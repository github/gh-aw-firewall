'use strict';
const {
  parseModelNotSupportedFromBody,
  parseModelEndpointBlockedFromBody,
} = require('./upstream-error-classification');
const {
  createUpstreamResponseLogging,
  extractRequestModel,
  summarizeRequestTools,
} = require('./upstream-error-logging');
const { buildCopilotAuthErrorMessage } = require('./upstream-log');
const { handle400WithRetry, handleFallbackEligibleResponse } = require('./upstream-retry');
const { setupTokenTracking } = require('./upstream-token');
const { buildCopilotWireAuthDiagnostic } = require('./copilot-auth-diagnostics');
const { needsResponseTranslation } = require('./cross-provider-fallback');
const {
  MAX_MODEL_NOT_SUPPORTED_RETRIES,
  shouldBuffer400,
  shouldBufferForFallback,
  shouldCaptureUpstreamError,
  createResponseCapture,
  shouldCaptureErrorBodyChunk,
  captureErrorBodyChunk,
  bufferUpstreamResponse,
} = require('./upstream-response-buffering');
const { selectCompatibilityTransforms } = require('./upstream-response-transforms');

function withoutContentLength(headers) {
  const next = { ...headers };
  delete next['content-length'];
  delete next['Content-Length'];
  return next;
}

/**
 * Acknowledge a budget notice carried by this request as soon as the upstream
 * response arrives with a 2xx status, whether or not it streams. Every reply
 * follows this one rule: the model has accepted the request, so a client that
 * closes early (Codex closes right after response.completed) or a usage record
 * written before the downstream finishes does not cause the notice to be
 * repeated. Any other outcome leaves the notice to be released when the client
 * response closes (see proxy-request.js).
 */
function acknowledgeSteeringDelivery(req, proxyRes) {
  if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) return;
  req.awfSteeringDelivery?.acknowledge();
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
  const {
    logRequestCompletion,
    logUpstreamAuthError,
    logUpstreamErrorResponse,
    handleResponseStreamError,
  } = createUpstreamResponseLogging({
    metrics,
    logRequest,
    sanitizeForLog,
    otel,
    handleRequestError,
    applyMaxRunsInvocation,
    applyPermissionDenied,
  });

  function handleUpstreamResponse(proxyRes, requestHeaders, {
    body, res, provider, requestId, req, targetHost, upstreamPath, startTime, span, requestBytes,
    hasRetried, onRetry,
    modelNotSupportedRetryCount = 0, onModelNotSupportedRetry,
    onModelEndpointBlockedRetry,
    onWireApiEndpointRetry,
    onModelFallback = null,
    codexCompatibility = null,
    wireApiCompatibility = null,
    protocolTranslation = null,
  }) {
    req.awfRouting?.onUpstreamResponseHeaders?.(proxyRes.headers, proxyRes);
    const capture = createResponseCapture();
    const billingInfo = extractBillingHeaders(proxyRes.headers);
    const initiatorSent = requestHeaders['x-initiator'] || null;
    const requestModel = extractRequestModel(body);
    const requestTools = summarizeRequestTools(body);
    if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
      req.awfEnclaveModelBudgetAttempt?.settleMissing();
    }

    const isRoutingClassifier = req.awfRequestContext?.purpose === 'routing_classification';
    const canFallback = !isRoutingClassifier && typeof onModelFallback === 'function';
    const bufferingPolicy = {
      statusCode: proxyRes.statusCode, provider, isRoutingClassifier, canFallback,
      hasRetried, modelNotSupportedRetryCount, onModelEndpointBlockedRetry,
    };
    const buffer400 = shouldBuffer400(bufferingPolicy);
    const captureUpstreamError = shouldCaptureUpstreamError(bufferingPolicy);

    const authErrCtx = {
      requestId, provider, targetHost, req,
      copilotAuthDiagnostic: provider === 'copilot'
        ? buildCopilotWireAuthDiagnostic(req, requestHeaders, targetHost, upstreamPath) : undefined,
    };
    const completionCtx = {
      startTime, provider, req, upstreamPath, requestBytes, targetHost, requestId, wireApiCompatibility,
      copilotAuthDiagnostic: authErrCtx.copilotAuthDiagnostic,
    };

    proxyRes.on('error', (err) => handleResponseStreamError(err, {
      res, requestId, provider, req, targetHost, startTime, span,
    }));

    if (buffer400 || shouldBufferForFallback(bufferingPolicy)) {
      bufferUpstreamResponse(proxyRes, {
        res, requestId, capture,
        onBuffered: (responseBody) => {
          const responseCtx = {
            completionCtx, authErrCtx, initiatorSent, billingInfo, res, span, requestId,
            logRequestCompletion, logUpstreamAuthError, logUpstreamErrorResponse, otel,
            requestModel, requestTools,
          };
          if (!buffer400) {
            handleFallbackEligibleResponse(proxyRes, responseBody, { ...responseCtx, onModelFallback });
            return;
          }
          handle400WithRetry(proxyRes, requestHeaders, responseBody, {
            ...responseCtx,
            provider, hasRetried, onRetry,
            modelNotSupportedRetryCount, maxModelNotSupportedRetries: MAX_MODEL_NOT_SUPPORTED_RETRIES, onModelNotSupportedRetry,
            onModelEndpointBlockedRetry,
            onWireApiEndpointRetry,
            onModelFallback: canFallback ? onModelFallback : null,
            parseDeprecatedHeaderFromBody,
            learnAndStripDeprecatedHeaderValue,
            parseModelNotSupportedFromBody,
            parseModelEndpointBlockedFromBody,
            logRequest,
            sanitizeForLog,
          });
        },
        onOversized: (responseBody) => {
          logRequestCompletion(proxyRes.statusCode, capture.responseBytes, initiatorSent, billingInfo, completionCtx);
          logUpstreamAuthError(proxyRes.statusCode, {
            ...authErrCtx, responseBody, responseBodyTruncated: true,
          });
          logUpstreamErrorResponse(proxyRes.statusCode, {
            ...authErrCtx,
            requestModel,
            requestTools,
            transformed: false,
            responseHeaders: proxyRes.headers,
            responseBody,
            responseBodyBytes: capture.responseBytes,
            responseBodyTruncated: true,
          });
          otel.endSpan(span, proxyRes.statusCode);
        },
      });
      return;
    }

    const isStreaming = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
    const isJson = (proxyRes.headers['content-type'] || '').includes('application/json');
    acknowledgeSteeringDelivery(req, proxyRes);
    // A cross-provider fallback attempt is translated back into the protocol
    // of the listener that received the request; Codex compatibility follows
    // that originating provider rather than the serving one.
    const compatibilityProvider = protocolTranslation?.originProvider || provider;
    const canTransformCompatibilityResponse =
      (provider === 'copilot' || !!protocolTranslation) &&
      (!!codexCompatibility || !!wireApiCompatibility || needsResponseTranslation(protocolTranslation)) &&
      proxyRes.statusCode >= 200 &&
      proxyRes.statusCode < 300 &&
      !proxyRes.headers['content-encoding'];

    const resHeaders = { ...proxyRes.headers, 'x-request-id': requestId };
    logUpstreamAuthError(proxyRes.statusCode, authErrCtx);

    const responseTransforms = canTransformCompatibilityResponse
      ? selectCompatibilityTransforms({
        compatibilityProvider, protocolTranslation, codexCompatibility, wireApiCompatibility, isStreaming, isJson,
      }) : [];

    if (canTransformCompatibilityResponse && isJson) {
      const bufferedChunks = [];
      proxyRes.on('data', (chunk) => {
        capture.responseBytes += chunk.length;
        bufferedChunks.push(chunk);
      });
      proxyRes.on('end', () => {
        logRequestCompletion(proxyRes.statusCode, capture.responseBytes, initiatorSent, billingInfo, completionCtx);
        let outgoingBody = Buffer.concat(bufferedChunks);
        let transformed = false;
        for (const transform of responseTransforms) {
          const next = transform(outgoingBody);
          if (next) {
            outgoingBody = next;
            transformed = true;
          }
        }
        res.awfUpstreamResponse = true;
        res.writeHead(proxyRes.statusCode, transformed ? withoutContentLength(resHeaders) : resHeaders);
        res.end(outgoingBody);
      });
    } else {
      proxyRes.on('data', (chunk) => {
        capture.responseBytes += chunk.length;
        if (captureUpstreamError) captureErrorBodyChunk(capture, chunk);
      });
      proxyRes.on('end', () => {
        logRequestCompletion(proxyRes.statusCode, capture.responseBytes, initiatorSent, billingInfo, completionCtx);
        if (captureUpstreamError) {
          logUpstreamErrorResponse(proxyRes.statusCode, {
            ...authErrCtx,
            requestModel,
            requestTools,
            transformed: responseTransforms.length > 0,
            responseHeaders: proxyRes.headers,
            responseBody: Buffer.concat(capture.capturedErrorChunks, capture.capturedErrorBytes),
            responseBodyBytes: capture.responseBytes,
            responseBodyTruncated: capture.errorBodyTruncated,
          });
        }
      });

      if (responseTransforms.length > 0) {
        res.awfUpstreamResponse = true;
        res.writeHead(proxyRes.statusCode, withoutContentLength(resHeaders));
        responseTransforms.reduce((stream, transform) => stream.pipe(transform), proxyRes).pipe(res);
      } else {
        res.awfUpstreamResponse = true;
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
      wireApiCompatibility,
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
    extractRequestModel,
    summarizeRequestTools,
    shouldCaptureErrorBodyChunk,
  },
};
