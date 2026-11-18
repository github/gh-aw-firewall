'use strict';

const {
  CANONICAL_ERROR_RESPONSE_JSON,
  canonicalSuccessJson,
  parseAndValidateFiniteOutput,
  informationChargeForSchema,
  schemaContainsFreeformString,
} = require('../../bounded-execution/finite-disclosure');
const { waitForBucket, TIMEOUT_BOUNDARY_GRACE_MS } = require('../../bounded-execution/fixed-timing');
const { resolveTerminalOutcome } = require('./executor-telemetry');

function createExecutorInvocation({
  config, seedMap, runId, audit, workspace, runner, clock, ledger, executorKind,
  uniformTiming, responseJitterSource, validateRequest, payloadKey, exitCategories,
  admission, lane, state, timing, diagnosticReason, emitInvocationTelemetry,
  markAdmitted, settleDynamic, safeDestroy,
}) {
  return async function executeInvocation(request, respond, invocationId, signal) {
    const admissionStartMs = uniformTiming ? clock.nowMs() : undefined;
    let responded = false;
    const safeRespond = (json) => {
      if (responded) return;
      responded = true;
      respond(json);
    };
    const rejectBeforeExecution = async (reason, detail, telemetryCategory = reason) => {
      timing(invocationId, admissionStartMs ?? clock.nowMs(),
        { phase: 'admission', status: 'rejected', reason });
      audit.failure(invocationId, reason, detail);
      emitInvocationTelemetry(telemetryCategory);
      if (admissionStartMs !== undefined) {
        await waitForBucket(
          admissionStartMs,
          clock.nowMs() - admissionStartMs,
          clock,
          responseJitterSource,
        );
      }
      safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
    };

    const validation = validateRequest(request);
    if (!validation.valid) {
      await rejectBeforeExecution('invalid-request', validation.errors.join('; '));
      return;
    }
    const { privateRepo, schema } = validation.request;
    const payload = validation.request[payloadKey];
    const repoKey = privateRepo.toLowerCase();

    let seed;
    let admitted;
    if (admission) {
      // Canonical admission runs *before* any repository content is exposed:
      // no workspace, no container, and no delegated bearer exists until AWF
      // has matched the selector against the compiler envelope, reserved
      // every run-wide quota, and minted exactly one identity.
      admitted = await admission.admit({ invocationId, selector: privateRepo, schema });
      if (!admitted || !admitted.admitted) {
        await rejectBeforeExecution('dynamic-admission-denied', undefined);
        return;
      }
      markAdmitted(invocationId);
      // Register into the *same* live per-repository ledger the static
      // executors debit. Registration is idempotent, so re-admitting a
      // repository can never refill a budget it has already spent.
      try {
        ledger.registerRepository(admitted.repo, admitted.sensitivity);
      } catch (error) {
        await settleDynamic(invocationId, 'broker-error', 0, 0);
        await rejectBeforeExecution('dynamic-sensitivity-invalid', error.message);
        return;
      }
      seed = { seedId: undefined, sensitivity: admitted.sensitivity };
    } else if (runner.hostOwned && config.dynamicEnabled) {
      // The host alone admits the selector and owns its delegated identity.
      // Reserve the worst-case disclosure locally before asking it to launch;
      // denied selectors never refund or reset the shared repository ledger.
      ledger.registerRepository(repoKey, config.dynamicSensitivity);
      seed = { seedId: undefined, sensitivity: config.dynamicSensitivity };
    } else {
      seed = seedMap.get(repoKey);
      if (!seed) {
        await rejectBeforeExecution('repo-not-allowed', privateRepo);
        return;
      }
    }
    if (schemaContainsFreeformString(schema) && seed.sensitivity !== 'trusted') {
      if (admitted) await settleDynamic(invocationId, 'schema-failure', 0, 0);
      await rejectBeforeExecution(
        'trusted-schema-required',
        `repo=${privateRepo} sensitivity=${seed.sensitivity}`,
      );
      return;
    }

    // Compute and debit the charge for THIS invocation's schema *before*
    // copying a seed or launching Python. Every invocation may declare a
    // different schema; there is no separate per-query cap — only whether
    // this charge fits the repository's remaining run balance.
    const charge = seed.sensitivity === 'trusted' ? 0 : informationChargeForSchema(schema);
    if (!ledger.tryDebit(admitted ? admitted.repo : repoKey, charge, executorKind)) {
      if (admitted) await settleDynamic(invocationId, 'broker-error', 0, 0);
      await rejectBeforeExecution('bit-budget-exhausted', `repo=${privateRepo} charge=${charge}`);
      return;
    }

    // From here on the charge is committed (never refunded) and every
    // response must be time-bucketed: workspace creation and query
    // execution both run against secret repository content, so their
    // latency alone is a signal.
    const startMs = admissionStartMs ?? clock.nowMs();

    let layout;
    let failureReason;
    let canonicalResult;
    timing(invocationId, startMs, { phase: 'work-start' });

    try {
      layout = runner.hostOwned ? {} : workspace.createInvocationWorkspace({
        config,
        runId,
        invocationId,
        seedId: seed.seedId,
        privateRepo: admitted ? admitted.repo : repoKey,
        schema,
        [payloadKey]: payload,
        ...(admitted
          ? { executorBearer: admitted.executorBearer, readMode: admitted.readMode }
          : {}),
      });
    } catch (error) {
      failureReason = ['workspace-create-failed', error.message];
    }

    if (layout) {
      const remainingMs = config.timeoutSeconds * 1000 +
        (runner.hostOwned ? TIMEOUT_BOUNDARY_GRACE_MS : 0) - (clock.nowMs() - startMs);
      if (remainingMs <= 0) {
        failureReason = ['timeout', 'workspace-creation-overran-deadline'];
      } else {
        try {
          timing(invocationId, startMs, { phase: 'runner-start',
            timeoutMs: config.timeoutSeconds * 1000, graceMs: runner.hostOwned ? TIMEOUT_BOUNDARY_GRACE_MS : 0 });
          const run = await runner.runInvocation({
            runId,
            invocationId,
            seedId: seed.seedId,
            deadlineMs: clock.nowMs() + remainingMs,
            signal,
            ...(runner.hostOwned ? {
              privateRepo: admitted ? admitted.repo : repoKey,
              payload,
              schema,
              admissionId: invocationId,
              executorKind,
            } : {}),
            ...(admitted
              ? { binding: { repository: admitted.repo, readMode: admitted.readMode } }
              : {}),
          });
          if (run.timedOut) {
            failureReason = ['timeout'];
          } else if (run.status === 'cancelled') {
            failureReason = ['cancelled'];
          } else if (run.exitCode !== 0) {
            failureReason = [
              exitCategories[run.exitCode] || 'non-zero-exit',
              `exit=${run.exitCode}`,
            ];
          } else {
            const raw = runner.hostOwned
              ? run.rawResult : workspace.readQueryOutput(layout.outPath, config.maxOutputBytes);
            if (raw === undefined || (runner.hostOwned
                && (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > config.maxOutputBytes))) {
              // Covers a missing file, an oversized file, invalid UTF-8, and
              // any non-regular replacement (symlink/FIFO/device/socket).
              failureReason = ['unreadable-output'];
            } else {
              const parsed = parseAndValidateFiniteOutput(raw, schema);
              if (!parsed.ok) {
                failureReason = ['nonconformant-output'];
              } else {
                canonicalResult = parsed.canonical;
              }
            }
          }
        } catch (error) {
          if (runner.hostOwned) {
            state.accepting = false;
            lane.closed = true;
          }
          failureReason = ['launch-failed', error.message];
        }
      }
    }

    timing(invocationId, startMs, { phase: 'work-complete',
      status: canonicalResult === undefined ? 'error' : 'ok', reason: diagnosticReason(failureReason) });
    timing(invocationId, startMs, { phase: 'cleanup-start' });
    let cleanupFailed = false;
    // Teardown is part of the observable operation: repository size and tree
    // shape can affect deletion time, and queued requests must not expose that
    // duration outside the charged timing bucket. Destroy by invocation id
    // even when creation threw after materializing only part of the workspace.
    // Executor-specific protected artifacts (never agent-visible) are captured
    // before teardown and inside the charged timing bucket.
    if (!runner.hostOwned && layout && typeof workspace.preserveInvocationArtifacts === 'function') {
      try {
        workspace.preserveInvocationArtifacts({ layout, config, invocationId });
      } catch (error) {
        cleanupFailed = true;
        if (failureReason === undefined) {
          failureReason = ['artifact-preservation-failed', error.message];
        } else {
          audit.failure(invocationId, 'artifact-preservation-failed', error.message);
        }
        canonicalResult = undefined;
      }
    }
    if (!safeDestroy(invocationId)) {
      cleanupFailed = true;
      failureReason ??= ['cleanup-failed'];
      canonicalResult = undefined;
      timing(invocationId, startMs, { phase: 'cleanup-failed', reason: 'cleanup-failed' });
    }

    // Settle the dynamic reservation and revoke the delegated identity on
    // *every* terminal path. An unresolved revocation downgrades an otherwise
    // successful invocation to the canonical error: a bearer that may still be
    // live has already touched repository content.
    if (admitted) {
      const settled = await settleDynamic(
        invocationId,
        resolveTerminalOutcome(canonicalResult, failureReason),
        canonicalResult === undefined ? 0 : Buffer.byteLength(canonicalResult, 'utf8'),
        Math.ceil((clock.nowMs() - startMs) / 1000),
      );
      if (!settled.revoked) {
        cleanupFailed = true;
        failureReason ??= ['dynamic-revocation-unresolved'];
        canonicalResult = undefined;
        timing(invocationId, startMs, { phase: 'cleanup-failed', reason: 'dynamic-revocation-unresolved' });
      }
    }

    const elapsedMs = clock.nowMs() - startMs;
    timing(invocationId, startMs, { phase: 'cleanup-complete',
      status: cleanupFailed ? 'error' : 'ok' });
    const { bucketMs, overflowed } = await waitForBucket(
      startMs,
      elapsedMs,
      clock,
      responseJitterSource,
      (record) => timing(invocationId, startMs, record),
    );
    timing(invocationId, startMs, { phase: 'response',
      status: overflowed || canonicalResult === undefined ? 'error' : 'ok',
      reason: overflowed ? 'timing-bucket-overflow' : diagnosticReason(failureReason), bucketMs });

    if (overflowed) {
      // Fail closed: processing (not the script itself, whose timeout
      // preserves a final-bucket post-processing margin) overran every
      // configured bucket — pathological infrastructure latency. Never emit a
      // successful result at unbucketed timing.
      audit.failure(invocationId, 'timing-bucket-overflow', failureReason ? failureReason.join(':') : undefined);
      emitInvocationTelemetry('timing-bucket-overflow');
      safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
    } else if (canonicalResult !== undefined) {
      audit.invocation({
        invocationId,
        repo: admitted ? admitted.repo : privateRepo,
        sensitivity: seed.sensitivity,
        bits: charge,
        bucketMs,
        ...(admitted ? { admission: 'dynamic', readMode: admitted.readMode } : {}),
      });
      emitInvocationTelemetry('success');
      safeRespond(canonicalSuccessJson(canonicalResult));
    } else {
      const category = failureReason ? failureReason[0] : 'unknown';
      audit.failure(invocationId, category, failureReason ? failureReason[1] : undefined);
      emitInvocationTelemetry(category);
      safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
    }
  };
}

module.exports = { createExecutorInvocation };
