'use strict';

const { parseBodyAsObject } = require('./body-utils');
const { carryForwardCodexCompatibility } = require('./codex-compat');
const {
  getFallbackModels,
  getRequestModel,
  selectNextFallbackModel,
  rewriteRequestModel,
} = require('./model-fallback-chain');
const { validateReasoningEffort } = require('./reasoning-effort-validation');
const { sanitizeForLog } = require('./logging');
const {
  carryForwardWireApiCompatibility,
  endpointForPath,
  replaceUpstreamEndpoint,
  translateCopilotWireApi,
} = require('./wire-api-compat');

/**
 * Backoff delays (ms) between successive model-not-supported retries.
 * Index 0 → delay before the 1st retry, index 1 → delay before the 2nd retry.
 */
const MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS = [1000, 2000];

function rebuildBodyFramingHeaders(headers, bodyLength) {
  const reframedHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName !== 'content-length' && lowerName !== 'transfer-encoding') {
      reframedHeaders[name] = value;
    }
  }
  reframedHeaders['content-length'] = String(bodyLength);
  return reframedHeaders;
}

function rebuildCopilotWireApiFallback(sourceBody, nextModel, req, upstreamPath) {
  const requestedEndpoint = endpointForPath(req?.url);
  const parsed = parseBodyAsObject(sourceBody);
  if (!requestedEndpoint || !parsed || typeof parsed.model !== 'string') return null;

  parsed.model = nextModel;
  const nextSourceBody = Buffer.from(JSON.stringify(parsed), 'utf8');
  const translated = translateCopilotWireApi(nextSourceBody, req.url);
  const compatibility = translated?.compatibility || {
    requestedEndpoint,
    upstreamEndpoint: requestedEndpoint,
    passthrough: true,
  };
  req.awfRouting?.onEndpointTranslation?.(compatibility);
  return {
    body: translated?.body || nextSourceBody,
    upstreamPath: replaceUpstreamEndpoint(
      upstreamPath,
      compatibility.upstreamEndpoint,
    ),
    wireApiCompatibility: compatibility,
    wireApiSourceBody: nextSourceBody,
  };
}

/**
 * Create and dispatch the upstream HTTP(S) request.
 * Sets up the proxyReq error handler, writes the body, and delegates response
 * handling to handleUpstreamResponse (including the one-shot retry path).
 *
 * When an ordered fallback chain is configured (`AWF_FALLBACK_MODELS`), a
 * model-specific upstream failure (5xx, connection error/timeout, or a
 * model-not-supported 400/404) re-sends the request with the next model in the
 * chain. See model-fallback-chain.js.
 *
 * @param {{ https: import('https'), http: import('http'), proxyAgent: import('http').Agent, handleUpstreamResponse: Function, sleep: Function, otel: object, handleRequestError: Function, metrics: object, logRequest?: Function, isFallbackModelPermitted?: (model: string, provider: string) => boolean, getFallbackModels?: () => string[] }} deps
 * @returns {(requestHeaders: object, ctx: object) => void}
 */
function createSendUpstreamRequest({
  https,
  http,
  proxyAgent,
  handleUpstreamResponse,
  sleep,
  otel,
  handleRequestError,
  metrics,
  logRequest = null,
  isFallbackModelPermitted = null,
  getFallbackModels: getFallbackModelsDep = getFallbackModels,
}) {
  return function sendUpstreamRequest(requestHeaders, {
    body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
    requestSigner = null,
    hasRetried = false,
    modelNotSupportedRetryCount = 0,
    targetScheme = 'https',
    codexCompatibility = null,
    wireApiCompatibility = null,
    wireApiSourceBody = null,
    attemptedModels = null,
  }) {
    try {
      validateReasoningEffort(body, provider, upstreamPath);
    } catch (err) {
      if (err.code !== 'unsupported_reasoning_effort') throw err;
      if (res.headersSent) return;

      const statusCode = err.statusCode || 400;
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
      logRequest?.('warn', 'request_validation_failed', {
        request_id: requestId,
        provider,
        method: req.method,
        path: sanitizeForLog(req.url),
        status: statusCode,
        duration_ms: duration,
        error_code: err.code,
      });
      otel.endSpan(span, statusCode);
      res.writeHead(statusCode, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
      res.end(JSON.stringify({
        error: {
          message: err.message,
          type: err.type || 'invalid_request_error',
          code: err.code,
        },
      }));
      return;
    }

    const isRoutingClassifier = req.awfRequestContext?.purpose === 'routing_classification';
    const cancellationSignal = isRoutingClassifier
      ? req.awfRequestContext.signal
      : null;

    // ── Ordered model fallback chain ────────────────────────────────────────
    // Resolve the next fallback model up front so the response handler only
    // buffers error bodies when a fallback is actually possible.
    let onModelFallback = null;
    if (!isRoutingClassifier && !req.awfScopedAuto) {
      const chain = getFallbackModelsDep();
      const current = chain.length > 0 ? getRequestModel(body, upstreamPath) : null;
      if (current) {
        const attempted = Array.isArray(attemptedModels) && attemptedModels.length > 0
          ? attemptedModels
          : [current.model];
        const nextModel = selectNextFallbackModel(chain, attempted, provider, isFallbackModelPermitted);
        const rewritten = nextModel
          ? rewriteRequestModel({ body, upstreamPath }, current.location, nextModel)
          : null;
        if (rewritten) {
          let fallbackTriggered = false;
          onModelFallback = ({ statusCode = null, reason = 'upstream_error' } = {}) => {
            if (fallbackTriggered || res.headersSent) return false;
            let wireFallback = null;
            if (provider === 'copilot' && wireApiSourceBody) {
              try {
                wireFallback = rebuildCopilotWireApiFallback(
                  wireApiSourceBody,
                  nextModel,
                  req,
                  upstreamPath,
                );
              } catch {
                return false;
              }
            }
            fallbackTriggered = true;
            const requestedModel = attempted[0];
            const attempt = attempted.length;
            req.awfModelFallback = {
              requested_model: requestedModel,
              model: nextModel,
              attempt,
              reason,
              ...(statusCode !== null ? { status: statusCode } : {}),
            };
            if (typeof logRequest === 'function') {
              logRequest('warn', 'model_fallback', {
                request_id: requestId,
                provider,
                from_model: current.model,
                to_model: nextModel,
                requested_model: requestedModel,
                attempt,
                reason,
                ...(statusCode !== null ? { status: statusCode } : {}),
                message: `Upstream ${statusCode !== null ? `returned ${statusCode}` : 'request failed'} for model "${current.model}"; falling back to "${nextModel}"`,
              });
            }
            const retryBody = wireFallback?.body || rewritten.body;
            const retryPath = wireFallback?.upstreamPath || rewritten.upstreamPath;
            const retryHeaders = retryBody === body
              ? requestHeaders
              : rebuildBodyFramingHeaders(requestHeaders, retryBody.length);
            sendUpstreamRequest(retryHeaders, {
              body: retryBody, targetHost, upstreamPath: retryPath, req, res, provider, requestId,
              startTime, span, requestBytes: retryBody.length, requestSigner,
              hasRetried,
              modelNotSupportedRetryCount,
              targetScheme,
              codexCompatibility: retryBody === body
                ? codexCompatibility
                : carryForwardCodexCompatibility(codexCompatibility),
              wireApiCompatibility: wireFallback
                ? wireFallback.wireApiCompatibility
                : carryForwardWireApiCompatibility(wireApiCompatibility),
              wireApiSourceBody: wireFallback?.wireApiSourceBody || wireApiSourceBody,
              attemptedModels: [...attempted, nextModel],
            });
            return true;
          };
        }
      }
    }
    let outboundHeaders = requestHeaders;
    if (requestSigner) {
      try {
        outboundHeaders = requestSigner({
          method: req.method,
          path: upstreamPath,
          headers: requestHeaders,
          body,
          targetHost,
        });
      } catch (err) {
        otel.endSpanError(span, err, 503);
        handleRequestError(err, {
          res, requestId, provider, req, targetHost, startTime,
          statusCode: 503,
          clientMessage: 'AWS request signing unavailable',
          extraMetrics: () => {
            metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
          },
        });
        return;
      }
    }

    // Honor an explicit http:// target scheme (see proxy-utils.js normalizeApiTarget)
    // by dialing the upstream in cleartext on port 80 instead of always assuming
    // HTTPS on 443. Bare hostnames and explicit https:// targets both default to
    // 'https', matching prior behavior.
    const isHttp = targetScheme === 'http';
    const mod = isHttp ? http : https;
    const options = {
      hostname: targetHost, port: isHttp ? 80 : 443, path: upstreamPath,
      method: req.method, headers: outboundHeaders,
      agent: proxyAgent,
      ...(cancellationSignal ? { signal: cancellationSignal } : {}),
    };

    let responded = false;
    const proxyReq = mod.request(options, (proxyRes) => {
      responded = true;
      handleUpstreamResponse(proxyRes, outboundHeaders, {
        body, res, provider, requestId, req, targetHost, startTime, span, requestBytes,
        hasRetried,
        modelNotSupportedRetryCount,
        codexCompatibility,
        wireApiCompatibility,
        wireApiSourceBody,
        onModelFallback,
        onRetry: (retryHeaders) => sendUpstreamRequest(retryHeaders, {
          body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes, requestSigner,
          hasRetried: true,
          modelNotSupportedRetryCount,
          targetScheme,
          codexCompatibility,
          wireApiCompatibility,
          wireApiSourceBody,
          attemptedModels,
        }),
        onModelNotSupportedRetry: () => {
          const delayMs = MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS[modelNotSupportedRetryCount] ?? 2000;
          sleep(delayMs).then(() => {
            sendUpstreamRequest(requestHeaders, {
              body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes, requestSigner,
              hasRetried,
              modelNotSupportedRetryCount: modelNotSupportedRetryCount + 1,
              targetScheme,
              codexCompatibility,
              wireApiCompatibility,
              wireApiSourceBody,
              attemptedModels,
            });
          });
        },
        onModelEndpointBlockedRetry: () => {
          // The model resolved from the alias is not accessible via this endpoint
          // (e.g. gpt-5.4-mini on Copilot /chat/completions).  Try the next
          // ranked candidate stored on the request object during body transform.
          const candidates = req.awfModelCandidates;
          if (!Array.isArray(candidates) || candidates.length < 2) return false;

          // Determine which model was sent in the current body.
          const parsed = parseBodyAsObject(body);
          const currentModel = parsed && parsed.model;
          if (!currentModel) return false;

          const currentIdx = candidates.indexOf(currentModel);
          if (currentIdx < 0 || currentIdx >= candidates.length - 1) return false;

          const nextModel = candidates[currentIdx + 1];
          let wireFallback = null;
          if (provider === 'copilot' && wireApiSourceBody) {
            try {
              wireFallback = rebuildCopilotWireApiFallback(
                wireApiSourceBody,
                nextModel,
                req,
                upstreamPath,
              );
            } catch {
              return false;
            }
          }

          // Rewrite the body with the next candidate. This produces a new
          // Buffer object, so Codex compatibility metadata (keyed on the
          // request/retry context, not on buffer identity) must be carried
          // forward explicitly — it does not depend on which model is used.
          const newParsed = parseBodyAsObject(body);
          if (!newParsed) return false;
          newParsed.model = nextModel;
          const newBody = wireFallback?.body || Buffer.from(JSON.stringify(newParsed), 'utf8');
          const retryPath = wireFallback?.upstreamPath || upstreamPath;
          const retryHeaders = rebuildBodyFramingHeaders(requestHeaders, newBody.length);

          // Update the candidates list so if the next model also fails we can
          // continue falling back (by shifting the current index forward).
          sendUpstreamRequest(retryHeaders, {
            body: newBody, targetHost, upstreamPath: retryPath, req, res, provider, requestId, startTime, span,
            requestBytes: newBody.length, requestSigner,
            hasRetried,
            modelNotSupportedRetryCount,
            targetScheme,
            codexCompatibility: carryForwardCodexCompatibility(codexCompatibility),
            wireApiCompatibility: wireFallback
              ? wireFallback.wireApiCompatibility
              : carryForwardWireApiCompatibility(wireApiCompatibility),
            wireApiSourceBody: wireFallback?.wireApiSourceBody || wireApiSourceBody,
            attemptedModels: [...(Array.isArray(attemptedModels) && attemptedModels.length > 0 ? attemptedModels : [currentModel]), nextModel],
          });
          return true;
        },
      });
    });

    proxyReq.on('error', (err) => {
      // A connection error or timeout before any upstream response is treated
      // like a 5xx for the ordered fallback chain.
      if (!responded && onModelFallback && onModelFallback({ reason: 'upstream_connection_error' })) {
        return;
      }
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
  rebuildBodyFramingHeaders,
  createSendUpstreamRequest,
};
