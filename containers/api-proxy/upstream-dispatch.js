'use strict';

const { rebuildBodyFramingHeaders, getRequestCancellation } = require('./upstream-request-utils');
const { createFallbackRetryHandlers } = require('./upstream-fallback');
const { createAttemptRecovery } = require('./upstream-attempt-recovery');
const { validateReasoningEffort } = require('./reasoning-effort-validation');
const { sanitizeForLog, logRequestShape } = require('./logging');
const { rememberInjectedCredentials, protectUpstreamResponse, redactCredentialError } = require('./credential-protection');
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

    try {
      validateReasoningEffort(body, provider, upstreamPath, req.awfRuntimePricing, req, { targetHost, targetScheme });
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
        rememberInjectedCredentials(req, Object.fromEntries(Object.entries(outboundHeaders)
          .filter(([name]) => ['authorization', 'x-amz-security-token'].includes(name.toLowerCase()))));
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
      ...(req.awfTrustedService ? { rejectUnauthorized: true } : {}),
    };

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
