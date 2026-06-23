'use strict';

const { buildCommonGuardChecks } = require('./guards/common-guard-checks');

/** Maps numeric status codes used by guards to HTTP/1.1 reason phrases. */
const HTTP_STATUS_LINES = {
  400: '400 Bad Request',
  403: '403 Forbidden',
  429: '429 Too Many Requests',
};

/**
 * Enforce all common security guards for a WebSocket upgrade request.
 * Writes a raw HTTP error response to the socket and destroys it when any
 * guard triggers, then returns true. Returns false when all guards pass.
 */
function enforceWebSocketGuards({ socket, logRequest, requestId, provider }, guardDeps) {
  // WebSocket upgrade requests have no JSON body, so model-specific guards
  // receive null and are skipped (their getters return null for null models).
  const guardChecks = buildCommonGuardChecks(guardDeps, null);

  for (const guard of guardChecks) {
    if (!guard.isBlocked(guard.block)) continue;

    const block = guard.block;
    logRequest('warn', guard.eventName, {
      request_id: requestId,
      provider,
      ...guard.buildLogFields(block),
    });

    const statusLine = HTTP_STATUS_LINES[guard.statusCode] || String(guard.statusCode);
    socket.write(`HTTP/1.1 ${statusLine}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`);
    socket.write(JSON.stringify(guard.buildError(block)));
    socket.destroy();
    return true;
  }

  return false;
}

function enforceWebSocketRateLimit({ limiter, metrics, logRequest, socket, requestId, provider }) {
  const rateCheck = limiter.check(provider, 0);
  if (!rateCheck.allowed) {
    metrics.increment('rate_limit_rejected_total', { provider, limit_type: rateCheck.limitType });
    logRequest('warn', 'rate_limited', {
      request_id: requestId, provider, limit_type: rateCheck.limitType,
      limit: rateCheck.limit, retry_after: rateCheck.retryAfter,
    });
    socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rateCheck.retryAfter}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return true;
  }

  return false;
}

module.exports = {
  enforceWebSocketGuards,
  enforceWebSocketRateLimit,
};
