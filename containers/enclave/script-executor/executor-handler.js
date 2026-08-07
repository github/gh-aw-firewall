'use strict';

const crypto = require('crypto');
const {
  CANONICAL_ERROR_RESPONSE_JSON,
  canonicalSuccessJson,
  parseAndValidateFiniteOutput,
  informationChargeForSchema,
  validateEnclaveScriptRequest,
} = require('../../bounded-execution/finite-disclosure');
const { createEnclaveInformationBudgetLedger } = require('../../bounded-execution/sensitivity-ledger');
const { createRealClock, waitForBucket } = require('../../bounded-execution/fixed-timing');
const defaultWorkspace = require('./workspace');

/**
 * The trusted enclave executor request handler (protocol v2).
 *
 * Responsibilities, in order, for every request:
 *
 *  1. consume one unit of the per-run *invocation* budget (`maxInvocations`,
 *     an operational cap independent of the bits below) — atomically, since
 *     Node's single-threaded event loop makes the check-and-increment
 *     indivisible because there is no `await` between them;
 *  2. validate the request — including the finite response schema — against
 *     the fixed protocol *before* any repository is copied or any container
 *     is launched;
 *  3. compute that schema's maximum complete-transcript information charge
 *     and atomically debit it from the repository's per-run bit ledger
 *     (see `./ledger`); an invocation proceeds iff the charge fits the
 *     remaining balance — there is no separate per-query cap;
 *  4. map the normalized repo id through AWF's static seed map to an opaque
 *     seed directory the caller never sees or names;
 *  5. build a fresh private writable copy and launch the query with a fixed
 *     argument vector, using a monotonic clock for every timing decision;
 *  6. strictly validate the result against the approved schema and
 *     canonically re-serialize it — raw query bytes/stdout/stderr/exit
 *     status never reach the caller;
 *  7. destroy the private copy, then respond at the first timing bucket
 *     boundary at or after all secret-dependent processing completed (see
 *     `./scheduler`).
 *
 * Every failure at every step produces the identical canonical
 * `{"status":"error"}`. The reason is recorded in the protected audit log,
 * which is never mounted into the agent or a query.
 *
 * Invocations are serialized. That bounds concurrent resource use and removes
 * any cross-invocation race in workspace creation/teardown/ledger access.
 */

function createExecutorHandler(params) {
  const { config, seedMap, runId, audit } = params;
  const workspace = params.workspace || defaultWorkspace;
  if (!params.runner) {
    throw new Error('createExecutorHandler requires a trusted ScriptRunner');
  }
  const runner = params.runner;
  const clock = params.clock || createRealClock();
  const ledger = params.ledger || createEnclaveInformationBudgetLedger(seedMap);
  const telemetry = params.telemetry || { emit() {} };
  const executorKind = params.executorKind || 'script';
  const uniformTiming = params.uniformTiming === true;
  if (executorKind !== 'script' && executorKind !== 'agent') {
    throw new Error('createExecutorHandler requires a known executor kind');
  }
  // Trusted executor-specific request grammar; callers cannot replace it.
  const validateRequest = params.validateRequest || validateEnclaveScriptRequest;
  // Name of the single free-form payload field this executor accepts.
  const payloadKey = params.payloadKey || 'script';
  // Optional trusted exit-status → protected-audit category map. Categories
  // never reach the caller; every failure is still the canonical error.
  const exitCategories = params.exitCategories || {};

  // Optional shared serialization lane. When several executors are exposed by
  // one server they share a lane so at most one sandbox — script or agent —
  // holds private repository content at a time.
  const lane = params.lane || { tail: Promise.resolve() };

  let invocationsUsed = 0;
  let accepting = true;

  function emitInvocationTelemetry(category) {
    telemetry.emit({
      primaryBackend: config.primaryBackend,
      executorBackend: config.executorBackend,
      lifecycleClass: 'invocation',
      capabilityState: 'supported',
      category,
    });
  }

  /**
   * Executes one request and reports its canonical result through
   * `respond` (called exactly once). The invocations run only through
   * validation, ledger debit, workspace creation, query launch, and result
   * validation actually reach the point where the response must be
   * time-bucketed; everything rejected before that responds immediately.
   */
  async function execute(request, respond) {
    const invocationId = crypto.randomBytes(12).toString('hex');
    const admissionStartMs = uniformTiming ? clock.nowMs() : undefined;
    let responded = false;
    const safeRespond = (json) => {
      if (responded) return;
      responded = true;
      respond(json);
    };
    const rejectBeforeExecution = async (reason, detail, telemetryCategory = reason) => {
      audit.failure(invocationId, reason, detail);
      emitInvocationTelemetry(telemetryCategory);
      if (admissionStartMs !== undefined) {
        await waitForBucket(admissionStartMs, clock.nowMs() - admissionStartMs, clock);
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

    const seed = seedMap.get(repoKey);
    if (!seed) {
      await rejectBeforeExecution('repo-not-allowed', privateRepo);
      return;
    }

    // Compute and debit the charge for THIS invocation's schema *before*
    // copying a seed or launching Python. Every invocation may declare a
    // different schema; there is no separate per-query cap — only whether
    // this charge fits the repository's remaining run balance.
    const charge = informationChargeForSchema(schema);
    if (!ledger.tryDebit(repoKey, charge, executorKind)) {
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

    try {
      layout = workspace.createInvocationWorkspace({
        config,
        invocationId,
        seedId: seed.seedId,
        schema,
        [payloadKey]: payload,
      });
    } catch (error) {
      failureReason = ['workspace-create-failed', error.message];
    }

    if (layout) {
      const remainingMs = config.timeoutSeconds * 1000 - (clock.nowMs() - startMs);
      if (remainingMs <= 0) {
        failureReason = ['timeout', 'workspace-creation-overran-deadline'];
      } else {
        try {
          const run = await runner.runScriptContainer({
            config,
            runId,
            invocationId,
            seedId: seed.seedId,
            timeoutMs: remainingMs,
          });
          if (run.timedOut) {
            failureReason = ['timeout'];
          } else if (run.exitCode !== 0) {
            failureReason = [
              exitCategories[run.exitCode] || 'non-zero-exit',
              `exit=${run.exitCode}`,
            ];
          } else {
            const raw = workspace.readQueryOutput(layout.outPath, config.maxOutputBytes);
            if (raw === undefined) {
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
          failureReason = ['launch-failed', error.message];
        }
      }
    }

    // Teardown is part of the observable operation: repository size and tree
    // shape can affect deletion time, and queued requests must not expose that
    // duration outside the charged timing bucket. Destroy by invocation id
    // even when creation threw after materializing only part of the workspace.
    // Executor-specific protected artifacts (never agent-visible) are captured
    // before teardown and inside the charged timing bucket.
    if (layout && typeof workspace.preserveInvocationArtifacts === 'function') {
      try {
        workspace.preserveInvocationArtifacts({ layout, config, invocationId });
      } catch (error) {
        if (failureReason === undefined) {
          failureReason = ['artifact-preservation-failed', error.message];
        } else {
          audit.failure(invocationId, 'artifact-preservation-failed', error.message);
        }
        canonicalResult = undefined;
      }
    }
    if (!safeDestroy(invocationId)) {
      failureReason = ['cleanup-failed'];
      canonicalResult = undefined;
    }

    const elapsedMs = clock.nowMs() - startMs;
    const { bucketMs, overflowed } = await waitForBucket(startMs, elapsedMs, clock);

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
        repo: privateRepo,
        sensitivity: seed.sensitivity,
        bits: charge,
        bucketMs,
      });
      emitInvocationTelemetry('success');
      safeRespond(canonicalSuccessJson(canonicalResult));
    } else {
      const category = failureReason ? failureReason[0] : 'unknown';
      audit.failure(invocationId, category, failureReason ? failureReason[1] : undefined);
      emitInvocationTelemetry(category);
      safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
    }

  }

  function safeDestroy(invocationId) {
    try {
      workspace.destroyInvocationWorkspace(config.workDir, invocationId);
      return true;
    } catch (error) {
      audit.failure(invocationId, 'cleanup-failed', error.message);
      return false;
    }
  }

  return {
    /** Stops admitting new invocations while letting admitted work drain. */
    close() {
      accepting = false;
    },

    /**
     * Handles one request. `respond` is called exactly once with the
     * canonical result JSON, as soon as it is ready to send (which, for any
     * invocation that reached workspace creation, is exactly at a timing
     * bucket boundary — never earlier). The returned promise resolves once
     * all server-side bookkeeping for the invocation (including workspace
     * cleanup) is complete; it carries no value and exists only to let the
     * caller serialize/await handler shutdown.
     *
     * Requests are queued so at most one query runs at a time.
     */
    handle(request, respond) {
      let responded = false;
      const safeRespond = (json) => {
        if (responded) return;
        responded = true;
        respond(json);
      };

      if (!accepting) {
        safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
        return Promise.resolve();
      }

      // The invocation-count cap is operational and independent of the bit
      // ledger: it is consumed per *response*, not per launch, so every
      // response the agent observes — including a rejection — counts
      // against it.
      if (invocationsUsed >= config.maxInvocations) {
        audit.failure('budget', 'invocation-count-exhausted', `max=${config.maxInvocations}`);
        emitInvocationTelemetry('invocation-count-exhausted');
        if (uniformTiming) {
          const queued = lane.tail.then(async () => {
            const startMs = clock.nowMs();
            await waitForBucket(startMs, clock.nowMs() - startMs, clock);
            safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
          });
          lane.tail = queued.then(
            () => undefined,
            () => undefined,
          );
          return queued;
        }
        safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
        return Promise.resolve();
      }
      invocationsUsed += 1;

      const queued = lane.tail.then(() => execute(request, safeRespond)).catch((error) => {
        audit.failure('queue', 'unexpected-error', error && error.message);
        emitInvocationTelemetry('unexpected-error');
        safeRespond(CANONICAL_ERROR_RESPONSE_JSON);
      });
      lane.tail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },

    /** Resolves when every admitted invocation has finished server-side work. */
    drain() {
      return lane.tail;
    },

    /** @internal Exposed for tests. */
    get invocationsUsed() {
      return invocationsUsed;
    },

    /** @internal Exposed for tests. */
    ledger,
  };
}

module.exports = { createExecutorHandler };
