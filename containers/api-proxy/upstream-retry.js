'use strict';

function handle400WithRetry(proxyRes, requestHeaders, responseBody, {
  provider, requestId, hasRetried, onRetry,
  modelNotSupportedRetryCount, maxModelNotSupportedRetries, onModelNotSupportedRetry,
  onModelEndpointBlockedRetry,
  completionCtx, authErrCtx, initiatorSent, billingInfo, res, span,
  parseDeprecatedHeaderFromBody, learnAndStripDeprecatedHeaderValue,
  parseModelNotSupportedFromBody, parseModelEndpointBlockedFromBody, logRequest, sanitizeForLog,
  logRequestCompletion, logUpstreamAuthError, otel,
}) {
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
        return true;
      }
    }
  }

  // ── (b) Permanent endpoint-blocked fallback (copilot only) ───────────────────
  // When Copilot rejects a model because it is not accessible via the requested
  // endpoint (e.g. gpt-5.4-mini on /chat/completions), this is a permanent
  // per-model restriction — not a transient catalogue issue.  Try the next
  // ranked candidate from the alias resolution if one is available.
  if (
    provider === 'copilot' &&
    onModelEndpointBlockedRetry &&
    parseModelEndpointBlockedFromBody(responseBody)
  ) {
    const { req } = authErrCtx;
    logRequest('warn', 'model_endpoint_blocked_fallback', {
      request_id: requestId,
      provider,
      path: sanitizeForLog(req.url),
      message: 'Copilot returned 400 endpoint-not-accessible; falling back to next alias candidate',
    });
    const didRetry = onModelEndpointBlockedRetry();
    if (didRetry) return true;
  }

  // ── (c) Transient model-not-supported retry (copilot only, up to MAX) ──────
  if (
    provider === 'copilot' &&
    modelNotSupportedRetryCount < maxModelNotSupportedRetries &&
    onModelNotSupportedRetry &&
    parseModelNotSupportedFromBody(responseBody)
  ) {
    logRequest('warn', 'model_not_supported_retry', {
      request_id: requestId,
      provider,
      retry_attempt: modelNotSupportedRetryCount + 1,
      max_retries: maxModelNotSupportedRetries,
      message: `Copilot returned 400 model not supported (transient); retrying (attempt ${modelNotSupportedRetryCount + 1}/${maxModelNotSupportedRetries})`,
    });
    onModelNotSupportedRetry();
    return true;
  }

  // ── (d) Model-unavailable diagnostic (non-retryable model-not-supported 400) ───
  if (proxyRes.statusCode === 400 && parseModelNotSupportedFromBody(responseBody)) {
    const { req } = authErrCtx;
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

  logRequestCompletion(proxyRes.statusCode, responseBody.length, initiatorSent, billingInfo, completionCtx);
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
  return false;
}

module.exports = {
  handle400WithRetry,
};
