'use strict';

const {
  CANONICAL_ERROR_RESPONSE_JSON,
  canonicalSuccessJson,
} = require('../../bounded-execution/finite-disclosure');
const { waitForBucket } = require('../../bounded-execution/fixed-timing');

function createExecutorInvocationTiming({
  audit, clock, uniformTiming, responseJitterSource, timing, diagnosticReason,
  emitInvocationTelemetry,
}) {
  return function beginInvocationTiming(respond, invocationId) {
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

    async function completeResponse(invocation, startMs, result) {
      const { privateRepo, admitted, seed, charge } = invocation;
      const { failureReason, canonicalResult, cleanupFailed } = result;
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
    }

    return { admissionStartMs, rejectBeforeExecution, completeResponse };
  };
}

module.exports = { createExecutorInvocationTiming };
