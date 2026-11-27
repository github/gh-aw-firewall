'use strict';

const { createExecutorInvocationAdmission } = require('./executor-invocation-admission');
const { createExecutorInvocationExecution } = require('./executor-invocation-execution');
const { createExecutorInvocationTiming } = require('./executor-invocation-timing');

function createExecutorInvocation({
  config, seedMap, runId, audit, workspace, runner, clock, ledger, executorKind,
  uniformTiming, responseJitterSource, validateRequest, payloadKey, exitCategories,
  admission, lane, state, timing, diagnosticReason, emitInvocationTelemetry,
  markAdmitted, settleDynamic, safeDestroy,
}) {
  const admitInvocation = createExecutorInvocationAdmission({
    config, seedMap, runner, ledger, executorKind, validateRequest, payloadKey,
    admission, markAdmitted, settleDynamic,
  });
  const executeWork = createExecutorInvocationExecution({
    config, runId, audit, workspace, runner, clock, executorKind, payloadKey,
    exitCategories, lane, state, timing, diagnosticReason, settleDynamic, safeDestroy,
  });
  const beginInvocationTiming = createExecutorInvocationTiming({
    audit, clock, uniformTiming, responseJitterSource, timing, diagnosticReason,
    emitInvocationTelemetry,
  });

  return async function executeInvocation(request, respond, invocationId, signal) {
    const response = beginInvocationTiming(respond, invocationId);
    const invocation = await admitInvocation(request, invocationId, response.rejectBeforeExecution);
    if (!invocation) return;

    // From here on the charge is committed (never refunded) and every
    // response must be time-bucketed: workspace creation and query
    // execution both run against secret repository content, so their
    // latency alone is a signal.
    const startMs = response.admissionStartMs ?? clock.nowMs();
    const result = await executeWork(invocation, invocationId, signal, startMs);
    await response.completeResponse(invocation, startMs, result);
  };
}

module.exports = { createExecutorInvocation };
