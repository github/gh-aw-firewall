'use strict';

function createRateLimitChecker({ limiter, metrics, logRequest, generateRequestId, isValidRequestId }) {
  /**
   * Check the rate limit for a provider and send a 429 if exceeded.
   * Returns true if the request was rate-limited (caller should return early).
   *
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @param {string} provider
   * @param {number} requestBytes
   * @returns {boolean}
   */
  return function checkRateLimit(req, res, provider, requestBytes) {
    const check = limiter.check(provider, requestBytes);
    if (!check.allowed) {
      const clientRequestId = req.headers['x-request-id'];
      const requestId = isValidRequestId(clientRequestId)
        ? clientRequestId
        : generateRequestId();
      const limitLabels = { rpm: 'requests per minute', rph: 'requests per hour', bytes_pm: 'bytes per minute' };
      const windowLabel = limitLabels[check.limitType] || check.limitType;

      metrics.increment('rate_limit_rejected_total', { provider, limit_type: check.limitType });
      logRequest('warn', 'rate_limited', {
        request_id: requestId,
        provider,
        limit_type: check.limitType,
        limit: check.limit,
        retry_after: check.retryAfter,
      });

      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(check.retryAfter),
        'X-RateLimit-Limit': String(check.limit),
        'X-RateLimit-Remaining': String(check.remaining),
        'X-RateLimit-Reset': String(check.resetAt),
        'X-Request-ID': requestId,
      });
      res.end(JSON.stringify({
        error: {
          type: 'rate_limit_error',
          message: `Rate limit exceeded for ${provider} provider. Limit: ${check.limit} ${windowLabel}. Retry after ${check.retryAfter} seconds.`,
          provider,
          limit: check.limit,
          window: check.limitType === 'rpm' ? 'per_minute' : check.limitType === 'rph' ? 'per_hour' : 'per_minute_bytes',
          retry_after: check.retryAfter,
        },
      }));
      return true;
    }
    return false;
  };
}

module.exports = {
  createRateLimitChecker,
};
