'use strict';

const { createLogRequestCompletion, createLogUpstreamAuthError, buildCopilotAuthErrorMessage } = require('./upstream-log');
const { handle400WithRetry } = require('./upstream-retry');
const { setupTokenTracking } = require('./upstream-token');
const {
  getCodexCompatibilityForRequestBody,
  transformCodexCompatibleResponseBody,
  createCodexCompatibleSseTransform,
} = require('./codex-compat');

/** Maximum number of times to retry a Copilot 400 "model not supported" response. */
const MAX_MODEL_NOT_SUPPORTED_RETRIES = 2;

/**
 * Pattern matching the Copilot error for a model that is not yet visible in
 * the caller's entitlement catalogue.  The error is transient — the catalogue
 * is non-deterministic and often stabilises within seconds.
 */
const MODEL_NOT_SUPPORTED_PATTERN = /the requested model is not supported/i;

/**
 * Pattern matching the Copilot error for a model that exists in the catalogue
 * but is not accessible via the requested endpoint (e.g. /chat/completions).
 * This is a permanent per-endpoint restriction, not a transient catalogue issue.
 * Examples: "model \"gpt-5.4-mini\" is not accessible via the /chat/completions endpoint"
 */
const MODEL_ENDPOINT_BLOCKED_PATTERN = /not accessible via the .+? endpoint/i;

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

/**
 * Return true when the response body indicates the model is not accessible
 * via the requested endpoint.
 *
 * @param {Buffer} body
 * @returns {boolean}
 */
function parseModelEndpointBlockedFromBody(body) {
  return MODEL_ENDPOINT_BLOCKED_PATTERN.test(body.toString('utf8'));
}

function withoutContentLength(headers) {
  const next = { ...headers };
  delete next['content-length'];
  delete next['Content-Length'];
  return next;
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
    onModelEndpointBlockedRetry,
  }) {
    let responseBytes = 0;
    const billingInfo = extractBillingHeaders(proxyRes.headers);
    const initiatorSent = requestHeaders['x-initiator'] || null;

    // Buffer the 400 response body when we may need to inspect it for either:
    //   (a) a deprecated Anthropic/Copilot beta-header value (first attempt only),
    //   (b) a transient Copilot "model not supported" catalogue error (up to MAX retries), or
    //   (c) a permanent Copilot "model not accessible via endpoint" error (fallback to next candidate).
    const shouldBuffer400 =
      proxyRes.statusCode === 400 &&
      (
        ((provider === 'anthropic' || provider === 'copilot') && !hasRetried) ||
        (provider === 'copilot' && modelNotSupportedRetryCount < MAX_MODEL_NOT_SUPPORTED_RETRIES) ||
        (provider === 'copilot' && !!onModelEndpointBlockedRetry)
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
          onModelEndpointBlockedRetry,
          completionCtx, authErrCtx, initiatorSent, billingInfo, res, span,
          parseDeprecatedHeaderFromBody,
          learnAndStripDeprecatedHeaderValue,
          parseModelNotSupportedFromBody,
          parseModelEndpointBlockedFromBody,
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

    const isStreaming = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
    const isJson = (proxyRes.headers['content-type'] || '').includes('application/json');
    const codexCompatibility = getCodexCompatibilityForRequestBody(body);
    const canTransformCodexResponse =
      provider === 'copilot' &&
      !!codexCompatibility &&
      proxyRes.statusCode >= 200 &&
      proxyRes.statusCode < 300 &&
      !proxyRes.headers['content-encoding'];

    const resHeaders = { ...proxyRes.headers, 'x-request-id': requestId };
    logUpstreamAuthError(proxyRes.statusCode, authErrCtx);

    let codexSseTransform = null;
    if (canTransformCodexResponse && isStreaming) {
      codexSseTransform = createCodexCompatibleSseTransform(body, provider);
    }

    if (canTransformCodexResponse && isJson) {
      const bufferedChunks = [];
      proxyRes.on('data', (chunk) => {
        responseBytes += chunk.length;
        bufferedChunks.push(chunk);
      });
      proxyRes.on('end', () => {
        logRequestCompletion(proxyRes.statusCode, responseBytes, initiatorSent, billingInfo, completionCtx);
        const responseBody = Buffer.concat(bufferedChunks);
        const transformed = transformCodexCompatibleResponseBody(responseBody, body, provider);
        const outgoingBody = transformed || responseBody;
        res.writeHead(proxyRes.statusCode, transformed ? withoutContentLength(resHeaders) : resHeaders);
        res.end(outgoingBody);
      });
    } else {
      proxyRes.on('data', (chunk) => { responseBytes += chunk.length; });
      proxyRes.on('end', () => {
        logRequestCompletion(proxyRes.statusCode, responseBytes, initiatorSent, billingInfo, completionCtx);
      });

      if (codexSseTransform) {
        res.writeHead(proxyRes.statusCode, withoutContentLength(resHeaders));
        proxyRes.pipe(codexSseTransform).pipe(res);
      } else {
        res.writeHead(proxyRes.statusCode, resHeaders);
        proxyRes.pipe(res);
      }
    }

    setupTokenTracking(proxyRes, body, {
      requestId, provider, req, res, startTime, billingInfo,
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
  parseModelEndpointBlockedFromBody,
  MAX_MODEL_NOT_SUPPORTED_RETRIES,
  // Exported for unit-test access only; not part of the public API.
  _testing: {
    buildCopilotAuthErrorMessage,
  },
};
