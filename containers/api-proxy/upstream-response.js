'use strict';

const { computeTokenBudgetUsage } = require('./token-budget-log');

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
  function logRequestCompletion(statusCode, responseBytes, initiatorSent, billingInfo, {
    startTime, provider, req, requestBytes, targetHost, requestId,
  }) {
    const duration = Date.now() - startTime;
    const sc = metrics.statusClass(statusCode);
    metrics.gaugeDec('active_requests', { provider });
    metrics.increment('requests_total', { provider, method: req.method, status_class: sc });
    metrics.increment('response_bytes_total', { provider }, responseBytes);
    metrics.observe('request_duration_ms', duration, { provider });
    if (statusCode >= 200 && statusCode < 300) {
      applyMaxRunsInvocation();
    }
    const logFields = {
      request_id: requestId, provider, method: req.method,
      path: sanitizeForLog(req.url), status: statusCode,
      duration_ms: duration, request_bytes: requestBytes,
      response_bytes: responseBytes, upstream_host: targetHost,
    };
    if (initiatorSent) logFields.x_initiator = initiatorSent;
    if (billingInfo) logFields.billing = billingInfo;
    logRequest('info', 'request_complete', logFields);
  }

  function logUpstreamAuthError(statusCode, { requestId, provider, targetHost, req, responseBody }) {
    if (statusCode === 401 || statusCode === 403) {
      applyPermissionDenied();
      logRequest('warn', 'upstream_auth_error', {
        request_id: requestId, provider, status: statusCode,
        upstream_host: targetHost, path: sanitizeForLog(req.url),
        message: `Upstream returned ${statusCode} — check that the API key is valid and correctly formatted`,
      });
    } else if (statusCode === 400) {
      // Suppress generic auth-error message when the 400 is a model-not-supported
      // error — that case is handled by the model_unavailable diagnostic.
      if (responseBody && parseModelNotSupportedFromBody(responseBody)) return;
      logRequest('warn', 'upstream_auth_error', {
        request_id: requestId, provider, status: statusCode,
        upstream_host: targetHost, path: sanitizeForLog(req.url),
        message: `Upstream returned ${statusCode} — check that the API key is valid and correctly formatted`,
      });
    }
  }

  function handleUpstreamResponse(proxyRes, requestHeaders, {
    res, provider, requestId, req, targetHost, startTime, span, requestBytes,
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

        // ── (a) Deprecated beta-header retry (first attempt for anthropic/copilot) ──
        if (!hasRetried && (provider === 'anthropic' || provider === 'copilot')) {
          const deprecated = parseDeprecatedHeaderFromBody(responseBody);
          if (deprecated) {
            const retryHeaders = { ...requestHeaders };
            const stripped = learnAndStripDeprecatedHeaderValue(
              retryHeaders, deprecated.header, deprecated.value, requestId, provider,
            );
            if (stripped) {
              onRetry(retryHeaders);
              return;
            }
          }
        }

        // ── (b) Transient model-not-supported retry (copilot only, up to MAX) ──────
        if (
          provider === 'copilot' &&
          modelNotSupportedRetryCount < MAX_MODEL_NOT_SUPPORTED_RETRIES &&
          onModelNotSupportedRetry &&
          parseModelNotSupportedFromBody(responseBody)
        ) {
          logRequest('warn', 'model_not_supported_retry', {
            request_id: requestId,
            provider,
            retry_attempt: modelNotSupportedRetryCount + 1,
            max_retries: MAX_MODEL_NOT_SUPPORTED_RETRIES,
            message: `Copilot returned 400 model not supported (transient); retrying (attempt ${modelNotSupportedRetryCount + 1}/${MAX_MODEL_NOT_SUPPORTED_RETRIES})`,
          });
          onModelNotSupportedRetry();
          return;
        }

        // ── (c) Model-unavailable diagnostic (retries exhausted or non-retryable) ───
        if (proxyRes.statusCode === 400 && parseModelNotSupportedFromBody(responseBody)) {
          logRequest('error', 'model_unavailable', {
            request_id: requestId,
            provider,
            status: proxyRes.statusCode,
            path: sanitizeForLog(req.url),
            retries_attempted: modelNotSupportedRetryCount,
            message: `Model is unavailable or retired — the requested model is not supported by ${provider}. ` +
              'Check that the model name is correct and not deprecated. ' +
              'If using model aliases, verify the alias resolves to an available model.',
          });
        }

        logRequestCompletion(proxyRes.statusCode, responseBytes, initiatorSent, billingInfo, completionCtx);
        logUpstreamAuthError(proxyRes.statusCode, { ...authErrCtx, responseBody });

        const resHeaders = {
          ...proxyRes.headers,
          'x-request-id': requestId,
          'content-length': String(responseBody.length),
        };
        delete resHeaders['transfer-encoding'];
        res.writeHead(proxyRes.statusCode, resHeaders);
        res.end(responseBody);
        otel.endSpan(span, proxyRes.statusCode);
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
    trackTokenUsage(proxyRes, {
      requestId, provider, path: sanitizeForLog(req.url), startTime, metrics, billingInfo, initiatorSent,
      onUsage: (normalizedUsage, model) => {
        otel.setTokenAttributes(span, { provider, model, normalizedUsage, streaming: isStreaming });
        return computeTokenBudgetUsage({ logRequest, requestId, provider }, normalizedUsage, model);
      },
      onSpanEnd: (statusCode) => {
        otel.endSpan(span, statusCode);
      },
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
};
