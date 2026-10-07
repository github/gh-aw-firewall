'use strict';

const { parseBodyAsObject } = require('./body-utils');
const { carryForwardCodexCompatibility } = require('./codex-compat');
const {
  attemptKey,
  getFallbackModels,
  getRequestModel,
  selectNextFallbackCandidate,
  selectNextFallbackModel,
  rewriteRequestModel,
  toAttempt,
} = require('./model-fallback-chain');
const {
  buildCrossProviderRequest,
  getCrossProviderRejection,
  protocolForPath,
} = require('./cross-provider-fallback');
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
 * chain. Provider-qualified chain entries for another configured provider
 * switch the upstream provider too, translating the protocol when needed.
 * See model-fallback-chain.js and cross-provider-fallback.js.
 *
 * @param {{ https: import('https'), http: import('http'), proxyAgent: import('http').Agent, handleUpstreamResponse: Function, sleep: Function, otel: object, handleRequestError: Function, metrics: object, logRequest?: Function, isFallbackModelPermitted?: (model: string, provider: string) => boolean, getFallbackModels?: () => string[], getProviderAdapter?: (provider: string) => object|null }} deps
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
  getProviderAdapter = null,
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
    fallbackOrigin = null,
    protocolTranslation = null,
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
    // The origin captures the request as received by the agent-facing
    // listener, so later attempts (on this or another provider) can be rebuilt
    // from the agent's protocol rather than from a translated upstream body.
    const origin = fallbackOrigin || {
      provider,
      protocol: protocolForPath(req?.url),
      sourceBody: wireApiSourceBody || body,
      body,
      upstreamPath,
      requestHeaders,
      targetHost,
      requestSigner,
      targetScheme,
      codexCompatibility,
      wireApiCompatibility,
      wireApiSourceBody,
      failures: [],
    };

    // Evaluate candidates only after an eligible failure so skipped-entry
    // evidence is retained even when no candidate is usable.
    let onModelFallback = null;
    if (!isRoutingClassifier && !req.awfScopedAuto) {
      const chain = getFallbackModelsDep();
      const current = chain.length > 0 ? getRequestModel(body, upstreamPath) : null;
      if (current) {
        const attempted = Array.isArray(attemptedModels) && attemptedModels.length > 0
          ? attemptedModels.map(a => toAttempt(a, provider))
          : [{ provider, model: current.model }];
        const getRouteRejection = (candidate) => {
          if (candidate.provider === provider || candidate.provider === origin.provider) return null;
          return getCrossProviderRejection({
            protocol: origin.protocol,
            targetProvider: candidate.provider,
            adapter: typeof getProviderAdapter === 'function' ? getProviderAdapter(candidate.provider) : null,
          });
        };
        const select = (exclude, onSkip) => selectNextFallbackCandidate(chain, attempted, origin.provider, {
          isPermitted: isFallbackModelPermitted,
          getRouteRejection,
          exclude,
          onSkip,
        });

        {
          let fallbackTriggered = false;
          onModelFallback = ({ statusCode = null, reason = 'upstream_error', abandon = null } = {}) => {
            if (fallbackTriggered || res.headersSent) return false;
            fallbackTriggered = true;
            const failure = {
              provider,
              model: current.model,
              reason,
              ...(statusCode !== null ? { status: statusCode } : {}),
            };
            const failures = [...origin.failures, failure];
            const exclude = new Set();
            const logSkip = (candidate, skipReason) => {
              logRequest?.('warn', 'model_fallback_skipped', {
                request_id: requestId,
                provider: origin.provider,
                entry: candidate.entry,
                candidate_provider: candidate.provider,
                candidate_model: candidate.model,
                reason: skipReason,
                message: `Fallback entry "${candidate.entry}" skipped: ${skipReason}`,
              });
            };

            const recordFallback = (candidate) => {
              const requested = attempted[0];
              const attempt = attempted.length;
              req.awfModelFallback = {
                requested_model: requested.model,
                requested_provider: requested.provider,
                model: candidate.model,
                provider: candidate.provider,
                attempt,
                reason,
                ...(statusCode !== null ? { status: statusCode } : {}),
                from_model: current.model,
                from_provider: provider,
                failures,
              };
              if (typeof logRequest === 'function') {
                logRequest('warn', 'model_fallback', {
                  request_id: requestId,
                  provider,
                  from_model: current.model,
                  to_model: candidate.model,
                  from_provider: provider,
                  to_provider: candidate.provider,
                  requested_model: requested.model,
                  requested_provider: requested.provider,
                  attempt,
                  reason,
                  ...(statusCode !== null ? { status: statusCode } : {}),
                  message: `Upstream ${statusCode !== null ? `returned ${statusCode}` : 'request failed'} for model "${current.model}"` +
                    `${candidate.provider !== provider ? ` on ${provider}` : ''}; falling back to "${candidate.model}"` +
                    `${candidate.provider !== provider ? ` on ${candidate.provider}` : ''}`,
                });
              }
              if (candidate.provider !== provider) {
                // Active-request accounting follows the serving provider.
                metrics.gaugeDec('active_requests', { provider });
                metrics.gaugeInc('active_requests', { provider: candidate.provider });
              }
            };
            const nextAttempts = (candidate) => [...attempted, { provider: candidate.provider, model: candidate.model }];
            const nextOrigin = { ...origin, failures };
            let cancellationFinalized = false;
            const finalizeCancellation = () => {
              if (cancellationFinalized) return;
              cancellationFinalized = true;
              metrics.gaugeDec('active_requests', { provider });
              otel.endSpan(span, 0);
            };

            // Same provider as the failed attempt: rewrite the model in place.
            const buildSameProviderAttempt = (candidate) => {
              const rewritten = rewriteRequestModel({ body, upstreamPath }, current.location, candidate.model);
              if (!rewritten) return null;
              let wireFallback = null;
              if (provider === 'copilot' && wireApiSourceBody) {
                wireFallback = rebuildCopilotWireApiFallback(wireApiSourceBody, candidate.model, req, upstreamPath);
              }
              const retryBody = wireFallback?.body || rewritten.body;
              return () => sendUpstreamRequest(
                retryBody === body ? requestHeaders : rebuildBodyFramingHeaders(requestHeaders, retryBody.length),
                {
                  body: retryBody, targetHost, upstreamPath: wireFallback?.upstreamPath || rewritten.upstreamPath,
                  req, res, provider, requestId, startTime, span, requestBytes: retryBody.length, requestSigner,
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
                  attemptedModels: nextAttempts(candidate),
                  fallbackOrigin: nextOrigin,
                  protocolTranslation,
                },
              );
            };

            // Back to the receiving provider after a cross-provider attempt:
            // rebuild from the original upstream request.
            const buildOriginAttempt = (candidate) => {
              const located = getRequestModel(origin.body, origin.upstreamPath);
              const rewritten = located
                ? rewriteRequestModel({ body: origin.body, upstreamPath: origin.upstreamPath }, located.location, candidate.model)
                : null;
              if (!rewritten) return null;
              let wireFallback = null;
              if (origin.provider === 'copilot' && origin.wireApiSourceBody) {
                wireFallback = rebuildCopilotWireApiFallback(origin.wireApiSourceBody, candidate.model, req, origin.upstreamPath);
              }
              const retryBody = wireFallback?.body || rewritten.body;
              return () => sendUpstreamRequest(rebuildBodyFramingHeaders(origin.requestHeaders, retryBody.length), {
                body: retryBody, targetHost: origin.targetHost,
                upstreamPath: wireFallback?.upstreamPath || rewritten.upstreamPath,
                req, res, provider: origin.provider, requestId, startTime, span, requestBytes: retryBody.length,
                requestSigner: origin.requestSigner,
                hasRetried: false,
                modelNotSupportedRetryCount: 0,
                targetScheme: origin.targetScheme,
                codexCompatibility: carryForwardCodexCompatibility(origin.codexCompatibility),
                wireApiCompatibility: wireFallback
                  ? wireFallback.wireApiCompatibility
                  : carryForwardWireApiCompatibility(origin.wireApiCompatibility),
                wireApiSourceBody: wireFallback?.wireApiSourceBody || origin.wireApiSourceBody,
                attemptedModels: nextAttempts(candidate),
                fallbackOrigin: nextOrigin,
                protocolTranslation: null,
              });
            };

            const giveUp = () => {
              if (typeof abandon === 'function') {
                abandon();
                return;
              }
              if (res.headersSent) return;
              const duration = Date.now() - startTime;
              metrics.gaugeDec('active_requests', { provider });
              metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
              logRequest?.('error', 'model_fallback_exhausted', {
                request_id: requestId, provider, status: 502, duration_ms: duration,
              });
              otel.endSpan(span, 502);
              res.writeHead(502, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
              res.end(JSON.stringify({
                error: {
                  message: 'Upstream request failed and no fallback model could be dispatched',
                  type: 'model_fallback_exhausted',
                  code: 'model_fallback_exhausted',
                },
              }));
            };

            const tryCandidates = () => {
              for (;;) {
                const candidate = select(exclude, logSkip);
                if (!candidate) return false;
                const key = attemptKey(candidate.provider, candidate.model);
                if (candidate.provider === provider || candidate.provider === origin.provider) {
                  let dispatch = null;
                  try {
                    dispatch = candidate.provider === provider
                      ? buildSameProviderAttempt(candidate)
                      : buildOriginAttempt(candidate);
                  } catch {
                    dispatch = null;
                  }
                  if (!dispatch) {
                    exclude.add(key);
                    logSkip(candidate, 'request_rewrite_failed');
                    continue;
                  }
                  recordFallback(candidate);
                  dispatch();
                  return true;
                }

                // Cross-provider candidate: the target body transforms may be
                // asynchronous, so the attempt is built before dispatch and the
                // next candidate (or the original failure) is used if it cannot
                // be built faithfully.
                buildCrossProviderRequest({
                  sourceBody: origin.sourceBody,
                  protocol: origin.protocol,
                  originProvider: origin.provider,
                  targetProvider: candidate.provider,
                  model: candidate.model,
                  adapter: getProviderAdapter(candidate.provider),
                  req,
                  requestId,
                  codexCompatibility: !!origin.codexCompatibility,
                }).then((built) => {
                  if (res.headersSent || res.destroyed || res.writableEnded) {
                    finalizeCancellation();
                    return;
                  }
                  if (built.substitutedModel) {
                    logRequest?.('warn', 'model_fallback_substitution_blocked', {
                      request_id: requestId,
                      provider: candidate.provider,
                      model: candidate.model,
                      substituted_model: built.substitutedModel,
                      message: `Provider body transform tried to substitute "${built.substitutedModel}"; kept configured fallback "${candidate.model}"`,
                    });
                  }
                  recordFallback(candidate);
                  sendUpstreamRequest(built.headers, {
                    body: built.body, targetHost: built.targetHost, upstreamPath: built.upstreamPath,
                    req, res, provider: candidate.provider, requestId, startTime, span,
                    requestBytes: built.body.length, requestSigner: built.requestSigner,
                    hasRetried: false,
                    modelNotSupportedRetryCount: 0,
                    targetScheme: built.targetScheme,
                    codexCompatibility: carryForwardCodexCompatibility(origin.codexCompatibility),
                    wireApiCompatibility: built.wireApiCompatibility,
                    wireApiSourceBody: built.wireApiSourceBody,
                    attemptedModels: nextAttempts(candidate),
                    fallbackOrigin: nextOrigin,
                    protocolTranslation: built.protocolTranslation,
                  });
                }, (err) => {
                  exclude.add(key);
                  logSkip(candidate, err?.code === 'unsupported_protocol_feature' || err?.code === 'unsupported_wire_api_feature'
                    ? `protocol_translation_failed: ${err.feature || err.message}`
                    : 'request_build_failed');
                  if (res.headersSent || res.destroyed || res.writableEnded) {
                    finalizeCancellation();
                    return;
                  }
                  if (!tryCandidates()) giveUp();
                });
                return true;
              }
            };

            if (tryCandidates()) return true;
            return false;
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
        protocolTranslation,
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
          fallbackOrigin,
          protocolTranslation,
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
              fallbackOrigin,
              protocolTranslation,
            });
          });
        },
        onModelEndpointBlockedRetry: provider !== origin.provider ? null : () => {
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

          const nextModel = selectNextFallbackModel(
            candidates.slice(currentIdx + 1), [currentModel], provider, isFallbackModelPermitted,
          );
          if (!nextModel) return false;
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
            attemptedModels: [
              ...(Array.isArray(attemptedModels) && attemptedModels.length > 0
                ? attemptedModels.map(a => toAttempt(a, provider))
                : [{ provider, model: currentModel }]),
              { provider, model: nextModel },
            ],
            fallbackOrigin: origin,
            protocolTranslation,
          });
          return true;
        },
      });
    });

    proxyReq.on('error', (err) => {
      const failRequest = () => {
        otel.endSpanError(span, err, 502);
        handleRequestError(err, {
          res, requestId, provider, req, targetHost, startTime,
          statusCode: 502, clientMessage: 'Proxy error',
          extraMetrics: (duration) => {
            metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
            metrics.observe('request_duration_ms', duration, { provider });
          },
        });
      };
      // A connection error or timeout before any upstream response is treated
      // like a 5xx for the ordered fallback chain.
      if (!responded && onModelFallback && onModelFallback({ reason: 'upstream_connection_error', abandon: failRequest })) {
        return;
      }
      failRequest();
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
