'use strict';

function createExecutorTelemetry({ config, clock, diagnosticAudit, executorKind, exitCategories, telemetry }) {
  let diagnosticRecords = 0;
  function timing(invocationId, startMs, record) {
    if (!diagnosticAudit || diagnosticRecords > 4096) return;
    diagnosticRecords += 1;
    diagnosticAudit.lifecycle('invocation-timing', diagnosticRecords === 4097
      ? { phase: 'diagnostics', status: 'limit-reached' }
      : { invocationId, executorKind, elapsedMs: Math.max(0, Math.round(clock.nowMs() - startMs)), ...record });
  }

  const diagnosticReason = (failure) => {
    const reason = failure?.[0];
    return [
      'workspace-create-failed', 'timeout', 'cancelled', 'non-zero-exit', 'unreadable-output',
      'nonconformant-output', 'launch-failed', 'artifact-preservation-failed', 'cleanup-failed',
      'dynamic-revocation-unresolved', ...Object.values(exitCategories),
    ].includes(reason) ? reason : reason === undefined ? 'none' : 'unknown';
  };

  function emitInvocationTelemetry(category) {
    telemetry.emit({
      primaryBackend: config.primaryBackend,
      executorBackend: config.executorBackend,
      lifecycleClass: 'invocation',
      capabilityState: 'supported',
      category,
    });
  }

  return { timing, diagnosticReason, emitInvocationTelemetry };
}

/** Maps this invocation's internal result to one terminal settlement outcome. */
function resolveTerminalOutcome(canonicalResult, failureReason) {
  if (canonicalResult !== undefined) return 'success';
  const category = failureReason ? failureReason[0] : 'broker-error';
  if (category === 'timeout') return 'timeout';
  if (category === 'nonconformant-output' || category === 'unreadable-output') {
    return 'schema-failure';
  }
  if (typeof category === 'string' && category.startsWith('enclave-')) return 'agent-failure';
  if (category === 'non-zero-exit') return 'agent-failure';
  return 'broker-error';
}

module.exports = { createExecutorTelemetry, resolveTerminalOutcome };
