'use strict';

const { createLogRequestCompletion, createLogUpstreamAuthError, buildCopilotAuthErrorMessage } = require('./upstream-log');
const { handle400WithRetry } = require('./upstream-retry');
const { setupTokenTracking } = require('./upstream-token');

/** Maximum number of times to retry a Copilot 400 "model not supported" response. */
const MAX_MODEL_NOT_SUPPORTED_RETRIES = 2;

/**
 * Pattern matching the Copilot error for a model that is not yet visible in
 * the caller's entitlement catalogue.  The error is transient — the catalogue
 * is non-deterministic and often stabilises within seconds.
 */
const MODEL_NOT_SUPPORTED_PATTERN = /the requested model is not supported/i;

/**
 * Return true when the response body contains a Copilot "model not supported"
 * error message.
 *
 * @param {Buffer} body
 * @returns {boolean}
 */
function parseModelNotSupportedFromBody(body) {
  return MODEL_NOT_SUPPORTED_PATTERN.test(body.toString('utf8'));
}

function createUpstreamResponseHandlers({
  metrics,
  logRequest,
  sanitizeForLog,
  otel,
  handleRequestError,
  trackTokenUsage,
  applyMaxRunsInvocation,
  applyPermissionDenied,
  extractBillingHeaders,
  parseDeprecatedHeaderFromBody,
  learnAndStripDeprecatedHeaderValue,
}) {
  const logRequestCompletion = createLogRequestCompletion({
    metrics,
    logRequest,
    sanitizeForLog,
    applyMaxRunsInvocation,
  });

  const logUpstreamAuthError = createLogUpstreamAuthError({
    logRequest,
    sanitizeForLog,
    applyPermissionDenied,
    parseModelNotSupportedFromBody,
  });

  function handleUpstreamResponse(proxyRes, requestHeaders, {
    body, res, provider, requestId, req, targetHost, startTime, span, requestBytes,
    hasRetried, onRetry,
    modelNotSupportedRetryCount = 0, onModelNotSupportedRetry,
  }) {
    let responseBytes = 0;
    const billingInfo = extractBillingHeaders(proxyRes.headers);
    const initiatorSent = requestHeaders['x-initiator'] || null;

    // Buffer the 400 response body when we may need to inspect it for either:
    //   (a) a deprecated Anthropic/Copilot beta-header value (first attempt only), or
    //   (b) a transient Copilot "model not supported" catalogue error (up to MAX retries).
    const shouldBuffer400 =
      proxyRes.statusCode === 400 &&
      (
        ((provider === 'anthropic' || provider === 'copilot') && !hasRetried) ||
        (provider === 'copilot' && modelNotSupportedRetryCount < MAX_MODEL_NOT_SUPPORTED_RETRIES)
      );

    const completionCtx = { startTime, provider, req, requestBytes, targetHost, requestId };
    const authErrCtx = { requestId, provider, targetHost, req };

    proxyRes.on('error', (err) => {
      otel.endSpanError(span, err, 502);
      handleRequestError(err, {
        res, requestId, provider, req, targetHost, startTime,
        statusCode: 502, clientMessage: 'Response stream error',
        onHeadersSent: () => {
          if (typeof res.destroy === 'function') res.destroy(err);
        },
      });
    });

    if (shouldBuffer400) {
      const bufferedChunks = [];
      proxyRes.on('data', (chunk) => {
        responseBytes += chunk.length;
        bufferedChunks.push(chunk);
      });
      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(bufferedChunks);
        const didRetry = handle400WithRetry(proxyRes, requestHeaders, responseBody, {
          provider, requestId, hasRetried, onRetry,
          modelNotSupportedRetryCount, maxModelNotSupportedRetries: MAX_MODEL_NOT_SUPPORTED_RETRIES, onModelNotSupportedRetry,
          completionCtx, authErrCtx, initiatorSent, billingInfo, res, span,
          parseDeprecatedHeaderFromBody,
          learnAndStripDeprecatedHeaderValue,
          parseModelNotSupportedFromBody,
          logRequest,
          sanitizeForLog,
          logRequestCompletion,
          logUpstreamAuthError,
          otel,
        });
        if (didRetry) return;
      });
      return;
    }

    proxyRes.on('data', (chunk) => { responseBytes += chunk.length; });
    proxyRes.on('end', () => {
      logRequestCompletion(proxyRes.statusCode, responseBytes, initiatorSent, billingInfo, completionCtx);
    });

    const resHeaders = { ...proxyRes.headers, 'x-request-id': requestId };
    logUpstreamAuthError(proxyRes.statusCode, authErrCtx);
    res.writeHead(proxyRes.statusCode, resHeaders);
    proxyRes.pipe(res);

    const isStreaming = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
    setupTokenTracking(proxyRes, body, {
      requestId, provider, req, startTime, billingInfo,
      initiatorSent, span, isStreaming,
      trackTokenUsage,
      sanitizeForLog,
      metrics,
      otel,
      logRequest,
    });
  }

  return {
    logRequestCompletion,
    logUpstreamAuthError,
    handleUpstreamResponse,
  };
}

module.exports = {
  createUpstreamResponseHandlers,
  parseModelNotSupportedFromBody,
  MAX_MODEL_NOT_SUPPORTED_RETRIES,
  // Exported for unit-test access only; not part of the public API.
  _testing: {
    buildCopilotAuthErrorMessage,
  },
};
