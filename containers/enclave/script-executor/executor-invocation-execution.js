'use strict';

const { parseAndValidateFiniteOutput } = require('../../bounded-execution/finite-disclosure');
const { TIMEOUT_BOUNDARY_GRACE_MS } = require('../../bounded-execution/fixed-timing');
const { resolveTerminalOutcome } = require('./executor-telemetry');

function createExecutorInvocationExecution({
  config, runId, audit, workspace, runner, clock, executorKind, payloadKey,
  exitCategories, lane, state, timing, diagnosticReason, settleDynamic, safeDestroy,
}) {
  function canonicalizeResult(run, layout, schema) {
    if (run.timedOut) return { failureReason: ['timeout'] };
    if (run.status === 'cancelled') return { failureReason: ['cancelled'] };
    if (run.exitCode !== 0) {
      return { failureReason: [
        exitCategories[run.exitCode] || 'non-zero-exit',
        `exit=${run.exitCode}`,
      ] };
    }
    const raw = runner.hostOwned
      ? run.rawResult : workspace.readQueryOutput(layout.outPath, config.maxOutputBytes);
    if (raw === undefined || (runner.hostOwned
        && (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > config.maxOutputBytes))) {
      // Covers a missing file, an oversized file, invalid UTF-8, and
      // any non-regular replacement (symlink/FIFO/device/socket).
      return { failureReason: ['unreadable-output'] };
    }
    const parsed = parseAndValidateFiniteOutput(raw, schema);
    if (!parsed.ok) return { failureReason: ['nonconformant-output'] };
    return { canonicalResult: parsed.canonical };
  }

  async function runWork(invocation, invocationId, signal, startMs) {
    const { seed, admitted, repoKey, schema, payload } = invocation;
    let layout;
    let result = {};
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
      result = { failureReason: ['workspace-create-failed', error.message] };
    }

    if (layout) {
      const remainingMs = config.timeoutSeconds * 1000 +
        (runner.hostOwned ? TIMEOUT_BOUNDARY_GRACE_MS : 0) - (clock.nowMs() - startMs);
      if (remainingMs <= 0) {
        result = { failureReason: ['timeout', 'workspace-creation-overran-deadline'] };
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
          result = canonicalizeResult(run, layout, schema);
        } catch (error) {
          if (runner.hostOwned) {
            state.accepting = false;
            lane.closed = true;
          }
          result = { failureReason: ['launch-failed', error.message] };
        }
      }
    }

    return { layout, ...result };
  }

  async function cleanupWork(invocation, invocationId, startMs, result) {
    const { admitted } = invocation;
    const { layout } = result;
    let { failureReason, canonicalResult } = result;
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

    return { failureReason, canonicalResult, cleanupFailed };
  }

  return async function executeWork(invocation, invocationId, signal, startMs) {
    const result = await runWork(invocation, invocationId, signal, startMs);
    return cleanupWork(invocation, invocationId, startMs, result);
  };
}

module.exports = { createExecutorInvocationExecution };
