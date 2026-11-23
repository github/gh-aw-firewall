'use strict';

const { rebuildBodyFramingHeaders, getRequestCancellation } = require('./upstream-request-utils');
const { createFallbackRetryHandlers } = require('./upstream-fallback');
const { createAttemptRecovery } = require('./upstream-attempt-recovery');
const { rejectInvalidReasoningEffort, rejectEnclaveBudgetAttempt } = require('./upstream-dispatch-guards');
const { signOutboundRequest, buildUpstreamRequestOptions } = require('./upstream-dispatch-transport');
const { logRequestShape } = require('./logging');
const { protectUpstreamResponse, redactCredentialError } = require('./credential-protection');
const { createInvocationModelBudget } = require('./enclave-model-budget');

const invocationModelBudget = createInvocationModelBudget(
  process.env.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET,
  { enforceInferenceEndpoints: process.env.AWF_ENCLAVE_AGENT_PROXY === '1' },
);

/**
 * Backoff delays (ms) between successive model-not-supported retries.
 * Index 0 → delay before the 1st retry, index 1 → delay before the 2nd retry.
 */
const MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS = [1000, 2000];

/**
 * Validate and budget each authenticated attempt, sign its final body, then
 * dispatch HTTP(S) transport and wire response/error callbacks to recovery.
 */
function createDispatchUpstreamRequest({
  https, http, proxyAgent, handleUpstreamResponse, sleep, otel, handleRequestError, metrics,
  logRequest = null, isFallbackModelPermitted = null, getFallbackModels,
  getProviderAdapter = null, modelBudget = invocationModelBudget,
  sendUpstreamRequest, failBrokerAuth,
}) {
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

    if (rejectInvalidReasoningEffort({
      body, provider, upstreamPath, req, res, targetHost, targetScheme, requestId, startTime, span,
    }, { metrics, otel, logRequest })) return;

    const { origin, assessCandidate, observeDecision, isPermitted, onModelFallback } = createAttemptRecovery({
      body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestSigner,
      hasRetried, modelNotSupportedRetryCount, targetScheme, codexCompatibility,
      wireApiCompatibility, wireApiSourceBody, wireApiEndpointRetryAttempted,
      attemptedModels, fallbackOrigin, protocolTranslation, requestHeaders, cancellation,
    }, {
      getBody: () => body, getRequestHeaders: () => requestHeaders,
      getFallbackModels, getProviderAdapter, isFallbackModelPermitted,
      sendUpstreamRequest, failBrokerAuth, metrics, otel, logRequest,
    });
    const budgetAttempt = modelBudget.beginAttempt({
      authorization: req.headers?.authorization,
      method: req.method,
      path: upstreamPath,
      body,
    });
    if (rejectEnclaveBudgetAttempt(budgetAttempt, {
      req, res, provider, requestId, span,
    }, { metrics, otel, logRequest })) return;
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

    const outboundHeaders = signOutboundRequest({
      requestSigner, requestHeaders, body, req, upstreamPath, targetHost, budgetAttempt,
      span, res, requestId, provider, startTime,
    }, { otel, handleRequestError, metrics });
    if (outboundHeaders === null) return;

    const { mod, options } = buildUpstreamRequestOptions({
      targetScheme, targetHost, upstreamPath, req, outboundHeaders, cancellation,
    }, { http, https, proxyAgent });

    let responded = false;
    logRequestShape(body, provider, requestId, 'upstream');
    const proxyReq = mod.request(options, (proxyRes) => {
      if (cancellation.cancelled) {
        proxyRes.destroy?.();
        return;
      }
      responded = true;
      if (req.awfTrustedService && proxyRes.statusCode >= 300 && proxyRes.statusCode < 400) {
        proxyRes.on('error', () => {});
        cancellation.finalized = true;
        cancellation.cancel();
        proxyRes.destroy();
        metrics.gaugeDec('active_requests', { provider });
        otel.endSpan(span, 502);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'trusted_service_redirect', message: 'Trusted service redirects are not allowed' } }));
        return;
      }
      const adapter = getProviderAdapter?.(provider);
      if (adapter?.renewableAuth) {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) adapter.recordAuthReadiness?.(true);
        else if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) adapter.recordAuthReadiness?.(false);
      }
      cancellation.responseStarted = true;
      const fallbackRetryHandlers = createFallbackRetryHandlers({
        body,
        targetHost,
        upstreamPath,
        req,
        res,
        provider,
        requestId,
        startTime,
        span,
        requestBytes,
        requestSigner,
        hasRetried,
        modelNotSupportedRetryCount,
        targetScheme,
        codexCompatibility,
        wireApiCompatibility,
        wireApiSourceBody,
        wireApiEndpointRetryAttempted,
        attemptedModels,
        origin,
        protocolTranslation,
        requestHeaders,
        cancellation,
        assessCandidate,
        observeDecision,
        sendUpstreamRequest,
        isPermitted,
        onModelFallback,
        logRequest,
      });
      let protectedResponse;
      try {
        protectedResponse = protectUpstreamResponse(proxyRes, req);
      } catch (error) {
        proxyRes.destroy();
        budgetAttempt.settleMissing();
        otel.endSpanError(span, error, 502);
        handleRequestError(error, {
          res, requestId, provider, req, targetHost, startTime,
          statusCode: 502, clientMessage: 'Upstream response could not be safely inspected',
        });
        return;
      }
      handleUpstreamResponse(protectedResponse, outboundHeaders, {
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
        onWireApiEndpointRetry: fallbackRetryHandlers.onWireApiEndpointRetry,
        onModelEndpointBlockedRetry: fallbackRetryHandlers.onModelEndpointBlockedRetry,
      });
    });

    proxyReq.on('error', (err) => {
      if (cancellation.cancelled) return;
      err = redactCredentialError(req, err);
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
  return dispatchUpstreamRequest;
}

module.exports = { createDispatchUpstreamRequest, MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS };
