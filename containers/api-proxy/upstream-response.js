'use strict';

function createUpstreamResponseHandlers({
  metrics,
  logRequest,
  sanitizeForLog,
  otel,
  handleRequestError,
  trackTokenUsage,
  applyEffectiveTokenUsage,
  applyMaxRunsInvocation,
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

  function logUpstreamAuthError(statusCode, { requestId, provider, targetHost, req }) {
    if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
      logRequest('warn', 'upstream_auth_error', {
        request_id: requestId, provider, status: statusCode,
        upstream_host: targetHost, path: sanitizeForLog(req.url),
        message: `Upstream returned ${statusCode} — check that the API key is valid and correctly formatted`,
      });
    }
  }

  function handleUpstreamResponse(proxyRes, requestHeaders, {
    res, provider, requestId, req, targetHost, startTime, span, requestBytes, hasRetried, onRetry,
  }) {
    let responseBytes = 0;
    const billingInfo = extractBillingHeaders(proxyRes.headers);
    const initiatorSent = requestHeaders['x-initiator'] || null;
    const shouldBuffer400ForHeaderStrip =
      (provider === 'anthropic' || provider === 'copilot') &&
      !hasRetried &&
      proxyRes.statusCode === 400;

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

    if (shouldBuffer400ForHeaderStrip) {
      const bufferedChunks = [];
      proxyRes.on('data', (chunk) => {
        responseBytes += chunk.length;
        bufferedChunks.push(chunk);
      });
      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(bufferedChunks);
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

        logRequestCompletion(proxyRes.statusCode, responseBytes, initiatorSent, billingInfo, completionCtx);
        logUpstreamAuthError(proxyRes.statusCode, authErrCtx);

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
        applyEffectiveTokenUsage(normalizedUsage, model);
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
};
