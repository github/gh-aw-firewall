'use strict';

const { parseBodyAsObject } = require('./body-utils');
const { isModelEligible } = require('./model-eligibility');
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
const { createInvocationModelBudget } = require('./enclave-model-budget');
const {
  MAX_AUTOMATIC_RECOVERIES,
  isAutomaticRecoveryEnabled,
  recoveryRecords,
  getAutomaticRecoveryCandidates,
  protocolForUrl,
} = require('./model-recovery');

const invocationModelBudget = createInvocationModelBudget(
  process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET,
);

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

function getRequestCancellation(req, res) {
  if (req.awfUpstreamCancellation) return req.awfUpstreamCancellation;

  const controller = new AbortController();
  const externalSignal = req.awfRequestContext?.signal;
  const cancellation = {
    controller,
    cancelled: false,
    finalized: false,
    responseStarted: false,
    activeAttempt: null,
    onCancel: null,
    cancel() {
      if (cancellation.cancelled) return;
      cancellation.cancelled = true;
      cancellation.activeAttempt?.settleMissing();
      externalSignal?.removeEventListener('abort', cancellation.cancel);
      controller.abort();
      cancellation.onCancel?.();
    },
  };
  req.awfUpstreamCancellation = cancellation;

  if (res && typeof res.once === 'function') {
    res.once('close', () => {
      if (!res.writableFinished) cancellation.cancel();
    });
    if (externalSignal) {
      res.once('finish', () => externalSignal.removeEventListener('abort', cancellation.cancel));
    }
  }
  if (externalSignal) {
    if (externalSignal.aborted) cancellation.cancel();
    else externalSignal.addEventListener('abort', cancellation.cancel, { once: true });
  }
  if (res?.destroyed && !res.writableFinished) cancellation.cancel();
  return cancellation;
}

function rebuildCopilotWireApiFallback(sourceBody, nextModel, req, upstreamPath, preserveEndpoint = false) {
  const requestedEndpoint = endpointForPath(req?.url);
  const parsed = parseBodyAsObject(sourceBody);
  if (!requestedEndpoint || !parsed || typeof parsed.model !== 'string') return null;

  parsed.model = nextModel;
  const nextSourceBody = Buffer.from(JSON.stringify(parsed), 'utf8');
  const translated = preserveEndpoint ? null : translateCopilotWireApi(nextSourceBody, req.url);
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
 * @param {{ https: import('https'), http: import('http'), proxyAgent: import('http').Agent, handleUpstreamResponse: Function, sleep: Function, otel: object, handleRequestError: Function, metrics: object, logRequest?: Function, isFallbackModelPermitted?: (model: string, provider: string, req: object) => boolean, getFallbackModels?: () => string[], getProviderAdapter?: (provider: string) => object|null }} deps
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
  modelBudget = invocationModelBudget,
}) {
  const failBrokerAuth = ({ res, req, provider, span }) => {
    metrics.gaugeDec('active_requests', { provider });
    otel.endSpan(span, 503);
    if (res.headersSent || res.destroyed || res.writableEnded) return;
    if (req.awfRouting) req.awfRouting.localError = { code: 'token_broker_unavailable', type: 'authentication_error' };
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'token_broker_unavailable', type: 'authentication_error',
      message: 'Copilot token broker authentication unavailable' } }));
  };

  // Resolve renewable credentials immediately before each actual attempt,
  // including model/endpoint retries. No refresh timer can touch active streams.
  function sendUpstreamRequest(requestHeaders, ctx) {
    const adapter = getProviderAdapter?.(ctx.provider);
    if (!adapter?.renewableAuth) return dispatchUpstreamRequest(requestHeaders, ctx);
    return adapter.getAuthHeaders({ method: ctx.req.method, url: ctx.upstreamPath, headers: ctx.req.headers })
      .then(authHeaders => {
        const headers = Object.fromEntries(Object.entries(requestHeaders)
          .filter(([key]) => key.toLowerCase() !== 'authorization'));
        dispatchUpstreamRequest({ ...headers, ...authHeaders }, ctx);
      }).catch(() => failBrokerAuth(ctx));
  }

  function dispatchUpstreamRequest(requestHeaders, {
    body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
    requestSigner = null,
    hasRetried = false,
    modelNotSupportedRetryCount = 0,
    targetScheme = 'https',
    codexCompatibility = null,
    wireApiCompatibility = null,
    wireApiSourceBody = null,
    wireApiEndpointRetryAttempted = false,
    attemptedModels = null,
    fallbackOrigin = null,
    protocolTranslation = null,
  }) {
    const isPermitted = (model, route) =>
      isModelEligible(model, route, req, { inputMode: 'native' }) &&
      (!isFallbackModelPermitted || isFallbackModelPermitted(model, route, req));
    const cancellation = getRequestCancellation(req, res);
    cancellation.responseStarted = false;
    cancellation.onCancel = () => {
      if (cancellation.finalized) return;
      cancellation.finalized = true;
      metrics.gaugeDec('active_requests', { provider });
      if (!cancellation.responseStarted) otel.endSpan(span, 0);
    };
    if (cancellation.cancelled) cancellation.onCancel();
    if (cancellation.cancelled) return;

    try {
      validateReasoningEffort(body, provider, upstreamPath, req.awfRuntimePricing);
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
      if (req.awfRouting) {
        req.awfRouting.localError = { code: err.code, type: err.type || 'invalid_request_error' };
      }
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
      wireApiEndpointRetryAttempted,
      failures: req.awfModelFallback?.failures || [],
    };

    // Evaluate candidates only after an eligible failure so skipped-entry
    // evidence is retained even when no candidate is usable.
    let onModelFallback = null;
    if (!isRoutingClassifier && !req.awfScopedAuto) {
      const chain = getFallbackModelsDep();
      const automaticRecovery = isAutomaticRecoveryEnabled(provider, req) &&
        protocolForUrl(req.url) &&
        recoveryRecords(provider, req).length > 0;
      const current = chain.length > 0 || automaticRecovery ? getRequestModel(body, upstreamPath) : null;
      if (current) {
        const attempted = Array.isArray(attemptedModels) && attemptedModels.length > 0
          ? attemptedModels.map(a => toAttempt(a, provider))
          : req.awfRecoveryAttempts || [{ provider, model: current.model }];
        const getRouteRejection = (candidate) => {
          if (candidate.provider === provider || candidate.provider === origin.provider) return null;
          return getCrossProviderRejection({
            protocol: origin.protocol,
            targetProvider: candidate.provider,
            adapter: typeof getProviderAdapter === 'function' ? getProviderAdapter(candidate.provider) : null,
          });
        };
        const select = (candidates, exclude, onSkip) => selectNextFallbackCandidate(candidates, attempted, origin.provider, {
          isPermitted,
          getRouteRejection,
          exclude,
          onSkip,
        });

        {
          let fallbackTriggered = false;
          onModelFallback = ({ statusCode = null, reason = 'upstream_error', abandon = null } = {}) => {
            if (cancellation.cancelled || fallbackTriggered || res.headersSent) return false;
            fallbackTriggered = true;
            const failure = {
              provider,
              model: current.model,
              reason,
              ...(statusCode !== null ? { status: statusCode } : {}),
            };
            const failures = [...origin.failures, failure];
            const automaticModels = automaticRecovery &&
              ['model_not_supported', 'model_endpoint_incompatible'].includes(reason) &&
              (req.awfAutomaticRecoveryCount || (req.awfRecoveryAttempts ? 1 : 0)) < MAX_AUTOMATIC_RECOVERIES
              ? getAutomaticRecoveryCandidates({
                model: attempted[0].model, provider,
                body: origin.sourceBody, url: req.url, req, isPermitted,
              }).map(model => `${provider}/${model}`)
              : [];
            const candidates = [...chain, ...automaticModels];
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
              if (!chain.includes(candidate.entry)) {
                req.awfAutomaticRecoveryCount = (req.awfAutomaticRecoveryCount ||
                  (req.awfRecoveryAttempts ? 1 : 0)) + 1;
              }
              req.awfModelFallback = {
                requested_model: sanitizeForLog(req.awfRequestedModelSelector || requested.model),
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
              req.awfRouting?.onModelFallback?.(req.awfModelFallback);
              if (typeof logRequest === 'function') {
                logRequest('warn', 'model_fallback', {
                  request_id: requestId,
                  provider,
                  from_model: sanitizeForLog(current.model),
                  to_model: sanitizeForLog(candidate.model),
                  from_provider: provider,
                  to_provider: candidate.provider,
                  requested_model: sanitizeForLog(req.awfRequestedModelSelector || requested.model),
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
              if (cancellationFinalized || cancellation.finalized) return;
              cancellationFinalized = true;
              cancellation.cancel();
              if (cancellation.responseStarted) otel.endSpan(span, 0);
            };

            // Same provider as the failed attempt: rewrite the model in place.
            const buildSameProviderAttempt = (candidate) => {
              const rewritten = rewriteRequestModel({ body, upstreamPath }, current.location, candidate.model);
              if (!rewritten) return null;
              let wireFallback = null;
              if (provider === 'copilot' && wireApiSourceBody) {
                wireFallback = rebuildCopilotWireApiFallback(
                  wireApiSourceBody, candidate.model, req, upstreamPath, !chain.includes(candidate.entry),
                );
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
                  wireApiEndpointRetryAttempted,
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
                wireFallback = rebuildCopilotWireApiFallback(
                  origin.wireApiSourceBody, candidate.model, req, origin.upstreamPath, !chain.includes(candidate.entry),
                );
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
                wireApiEndpointRetryAttempted: origin.wireApiEndpointRetryAttempted,
                attemptedModels: nextAttempts(candidate),
                fallbackOrigin: nextOrigin,
                protocolTranslation: null,
              });
            };

            const giveUp = () => {
              if (!(automaticRecovery && reason === 'model_not_supported') && typeof abandon === 'function') {
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
              if (req.awfRouting) {
                req.awfRouting.localError = { code: 'model_fallback_exhausted', type: 'model_fallback_exhausted' };
              }
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
                if (cancellation.cancelled) return false;
                const candidate = select(candidates, exclude, logSkip);
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
                  if (cancellation.cancelled || res.headersSent || res.destroyed || res.writableEnded) {
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
                    wireApiEndpointRetryAttempted,
                    attemptedModels: nextAttempts(candidate),
                    fallbackOrigin: nextOrigin,
                    protocolTranslation: built.protocolTranslation,
                  });
                }, (err) => {
                  if (cancellation.cancelled) {
                    finalizeCancellation();
                    return;
                  }
                  if (err?.code === 'token_broker_unavailable') {
                    failBrokerAuth({ res, req, provider, span });
                    return;
                  }
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
            if (automaticRecovery && reason === 'model_not_supported') {
              giveUp();
              return true;
            }
            return false;
          };
        }
      }
    }
    const budgetAttempt = modelBudget.beginAttempt({
      authorization: req.headers?.authorization,
      method: req.method,
      path: upstreamPath,
      body,
    });
    if (!budgetAttempt.allowed) {
      const statusCode = budgetAttempt.reason === 'invalid_capability' ? 403 : 429;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', {
        provider,
        method: req.method,
        status_class: '4xx',
      });
      logRequest?.('warn', 'enclave_model_budget_rejected', {
        request_id: requestId,
        provider,
        reason: budgetAttempt.reason,
      });
      const capabilityEvent = {
        missing: 'enclave_model_capability_missing',
        scheme: 'enclave_model_capability_scheme',
        format: 'enclave_model_capability_format',
        signature: 'enclave_model_capability_signature',
        claims: 'enclave_model_capability_claims',
        claims_changed: 'enclave_model_capability_claims_changed',
      }[budgetAttempt.capabilityFailure];
      if (budgetAttempt.reason === 'invalid_capability' && capabilityEvent) {
        logRequest?.('warn', capabilityEvent, { status: statusCode });
      }
      if (budgetAttempt.reason === 'token_limit') {
        logRequest?.('warn', 'enclave_model_token_limit', { status: statusCode });
        const tokenEvent = {
          body_missing: 'enclave_model_token_body_missing',
          input_reservation: 'enclave_model_token_input_reservation',
          request_json: 'enclave_model_token_request_json',
          request_shape: 'enclave_model_token_request_shape',
          output_conflict: 'enclave_model_token_output_conflict',
          output_shape: 'enclave_model_token_output_shape',
          stream_options: 'enclave_model_token_stream_options',
          budget_exhausted: 'enclave_model_token_budget_exhausted',
        }[budgetAttempt.tokenFailure];
        if (typeof tokenEvent === 'string') {
          logRequest?.('warn', tokenEvent, { status: statusCode });
        }
      }
      otel.endSpan(span, statusCode);
      if (res.headersSent) {
        res.destroy?.();
        return;
      }
      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      });
      res.end(JSON.stringify({
        error: {
          message: 'Enclave model budget exhausted or invalid',
          type: 'awf_enclave_model_budget_error',
          code: `awf_enclave_model_budget_${budgetAttempt.reason}`,
        },
      }));
      return;
    }
    cancellation.activeAttempt = budgetAttempt;
    if (cancellation.cancelled) {
      budgetAttempt.settleMissing();
      return;
    }
    if (budgetAttempt.body) {
      body = budgetAttempt.body;
      requestHeaders = rebuildBodyFramingHeaders(requestHeaders, body.length);
      requestBytes = body.length;
    }
    req.awfEnclaveModelBudgetAttempt = budgetAttempt;

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
        budgetAttempt.settleMissing();
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

    // Keep the authority intact for Host headers/signing, but dial hostname and
    // port separately (including for IPv6 literals).
    const isHttp = targetScheme === 'http';
    const mod = isHttp ? http : https;
    const targetUrl = new URL(`${targetScheme}://${targetHost}`);
    const options = {
      hostname: targetUrl.hostname.replace(/^\[|\]$/g, ''),
      port: targetUrl.port ? Number(targetUrl.port) : (isHttp ? 80 : 443),
      path: upstreamPath,
      method: req.method, headers: outboundHeaders,
      agent: proxyAgent,
      signal: cancellation.controller.signal,
    };

    let responded = false;
    const proxyReq = mod.request(options, (proxyRes) => {
      if (cancellation.cancelled) {
        proxyRes.destroy?.();
        return;
      }
      responded = true;
      const adapter = getProviderAdapter?.(provider);
      if (adapter?.renewableAuth) {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) adapter.recordAuthReadiness?.(true);
        else if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) adapter.recordAuthReadiness?.(false);
      }
      cancellation.responseStarted = true;
      handleUpstreamResponse(proxyRes, outboundHeaders, {
        body, res, provider, requestId, req, targetHost, upstreamPath, startTime, span, requestBytes,
        hasRetried,
        modelNotSupportedRetryCount,
        codexCompatibility,
        wireApiCompatibility,
        wireApiSourceBody,
        wireApiEndpointRetryAttempted,
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
          wireApiEndpointRetryAttempted,
          attemptedModels,
          fallbackOrigin,
          protocolTranslation,
        }),
        onModelNotSupportedRetry: () => {
          const delayMs = MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS[modelNotSupportedRetryCount] ?? 2000;
          sleep(delayMs).then(() => {
            if (cancellation.cancelled) return;
            sendUpstreamRequest(requestHeaders, {
              body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes, requestSigner,
              hasRetried,
              modelNotSupportedRetryCount: modelNotSupportedRetryCount + 1,
              targetScheme,
              codexCompatibility,
              wireApiCompatibility,
              wireApiSourceBody,
              wireApiEndpointRetryAttempted,
              attemptedModels,
              fallbackOrigin,
              protocolTranslation,
            });
          });
        },
        onWireApiEndpointRetry: () => {
          if (cancellation.cancelled) return false;
          if (provider !== 'copilot' || !wireApiSourceBody || wireApiEndpointRetryAttempted) return false;
          const requestedEndpoint = endpointForPath(req.url);
          const rejectedEndpoint = endpointForPath(upstreamPath);
          if (!requestedEndpoint || !rejectedEndpoint) return false;
          const alternateEndpoint = rejectedEndpoint === '/responses' ? '/chat/completions' : '/responses';
          let retryBody = wireApiSourceBody;
          let retryCompatibility = {
            requestedEndpoint,
            upstreamEndpoint: requestedEndpoint,
            passthrough: true,
          };
          if (alternateEndpoint !== requestedEndpoint) {
            const translated = translateCopilotWireApi(wireApiSourceBody, req.url, {
              upstreamEndpoint: alternateEndpoint,
            });
            if (!translated) return false;
            retryBody = translated.body;
            retryCompatibility = translated.compatibility;
          }
          req.awfRouting?.onEndpointTranslation?.(retryCompatibility);
          logRequest?.('warn', 'wire_api_endpoint_retry', {
            request_id: requestId,
            provider,
            rejected_endpoint: rejectedEndpoint,
            upstream_endpoint: alternateEndpoint,
            message: 'Copilot rejected the endpoint; retrying the same model on the other wire API',
          });
          const retryHeaders = rebuildBodyFramingHeaders(requestHeaders, retryBody.length);
          retryHeaders['accept-encoding'] = 'identity';
          sendUpstreamRequest(retryHeaders, {
            body: retryBody, targetHost,
            upstreamPath: replaceUpstreamEndpoint(upstreamPath, alternateEndpoint),
            req, res, provider, requestId, startTime, span,
            requestBytes: retryBody.length, requestSigner,
            hasRetried, modelNotSupportedRetryCount, targetScheme,
            codexCompatibility, wireApiCompatibility: retryCompatibility,
            wireApiSourceBody, wireApiEndpointRetryAttempted: true, attemptedModels,
            fallbackOrigin: { ...origin, wireApiEndpointRetryAttempted: true },
            protocolTranslation,
          });
          return true;
        },
        onModelEndpointBlockedRetry: provider !== origin.provider ? null : () => {
          if (cancellation.cancelled) return false;
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
            candidates.slice(currentIdx + 1), [currentModel], provider, isPermitted,
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
            wireApiEndpointRetryAttempted,
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
      if (cancellation.cancelled) return;
      budgetAttempt.settleMissing();
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
  }
  return sendUpstreamRequest;
}

module.exports = {
  MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS,
  rebuildBodyFramingHeaders,
  createSendUpstreamRequest,
};
