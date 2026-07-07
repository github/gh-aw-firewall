'use strict';

/**
 * Backoff delays (ms) between successive model-not-supported retries.
 * Index 0 → delay before the 1st retry, index 1 → delay before the 2nd retry.
 */
const MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS = [1000, 2000];

/**
 * Create and dispatch the upstream HTTPS request.
 * Sets up the proxyReq error handler, writes the body, and delegates response
 * handling to handleUpstreamResponse (including the one-shot retry path).
 *
 * @param {{ https: import('https'), proxyAgent: import('http').Agent, handleUpstreamResponse: Function, sleep: Function, otel: object, handleRequestError: Function, metrics: object }} deps
 * @returns {(requestHeaders: object, ctx: object) => void}
 */
function createSendUpstreamRequest({
  https,
  proxyAgent,
  handleUpstreamResponse,
  sleep,
  otel,
  handleRequestError,
  metrics,
}) {
  return function sendUpstreamRequest(requestHeaders, {
    body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
    hasRetried = false,
    modelNotSupportedRetryCount = 0,
  }) {
    const options = {
      hostname: targetHost, port: 443, path: upstreamPath,
      method: req.method, headers: requestHeaders,
      agent: proxyAgent,
    };

    const proxyReq = https.request(options, (proxyRes) => {
      handleUpstreamResponse(proxyRes, requestHeaders, {
        body, res, provider, requestId, req, targetHost, startTime, span, requestBytes,
        hasRetried,
        modelNotSupportedRetryCount,
        onRetry: (retryHeaders) => sendUpstreamRequest(retryHeaders, {
          body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
          hasRetried: true,
          modelNotSupportedRetryCount,
        }),
        onModelNotSupportedRetry: () => {
          const delayMs = MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS[modelNotSupportedRetryCount] ?? 2000;
          sleep(delayMs).then(() => {
            sendUpstreamRequest(requestHeaders, {
              body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
              hasRetried,
              modelNotSupportedRetryCount: modelNotSupportedRetryCount + 1,
            });
          });
        },
      });
    });

    proxyReq.on('error', (err) => {
      otel.endSpanError(span, err, 502);
      handleRequestError(err, {
        res, requestId, provider, req, targetHost, startTime,
        statusCode: 502, clientMessage: 'Proxy error',
        extraMetrics: (duration) => {
          metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
          metrics.observe('request_duration_ms', duration, { provider });
        },
      });
    });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  };
}

module.exports = {
  MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS,
  createSendUpstreamRequest,
};
