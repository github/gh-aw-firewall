'use strict';

const { computeTokenBudgetUsage } = require('./token-budget-log');
const { endpointFor, inspectSseTerminalLine } = require('./routing-observation');

function setupTokenTracking(proxyRes, body, {
  requestId, provider, req, res, startTime, billingInfo,
  initiatorSent, span, isStreaming,
  trackTokenUsage, sanitizeForLog, metrics, otel, logRequest, wireApiCompatibility,
}) {
  const purpose = req.awfRequestContext?.purpose;
  const steering = req.awfSteering;
  const requestedEndpoint = wireApiCompatibility?.requestedEndpoint || null;
  const upstreamEndpoint = wireApiCompatibility?.upstreamEndpoint || null;
  const steeringDelivery = req.awfSteeringDelivery;
  const successfulUpstream = proxyRes.statusCode >= 200 && proxyRes.statusCode < 300;
  let streamOutcome = null;
  const requestPath = typeof req.url === 'string' ? req.url.split('?')[0] : '';
  const terminalTelemetry = {
    requested_endpoint: endpointFor(requestedEndpoint || requestPath),
    upstream_endpoint: endpointFor(upstreamEndpoint || requestPath),
  };
  const terminalState = { upstreamCompleted: false, upstreamTerminated: false, sseFailed: false };

  if (steeringDelivery && successfulUpstream && !isStreaming) {
    let upstreamEnded = false;
    let downstreamFinished = false;
    const acknowledgeWhenComplete = () => {
      if (upstreamEnded && downstreamFinished) steeringDelivery.acknowledge();
    };
    proxyRes.once('end', () => {
      upstreamEnded = true;
      acknowledgeWhenComplete();
    });
    res?.once?.('finish', () => {
      downstreamFinished = true;
      acknowledgeWhenComplete();
    });
  }

  const onSseData = line => {
    const outcome = typeof req.awfRouting?.onSseData === 'function'
      ? req.awfRouting.onSseData(line)
      : inspectSseTerminalLine(line, terminalTelemetry, terminalState).outcome;
    if (outcome === 'success') {
      streamOutcome = outcome;
      if (successfulUpstream) steeringDelivery?.acknowledge();
    } else if (outcome === 'failure') {
      streamOutcome = outcome;
      steeringDelivery?.release();
    }
  };
  const onSseInspectionComplete = () => {
    req.awfRouting?.onSseInspectionComplete?.();
    if (isStreaming && steeringDelivery) {
      req.awfSteeringSseInspectionComplete = true;
    }
    if (isStreaming && (!successfulUpstream || streamOutcome !== 'success')) {
      steeringDelivery?.release();
    }
  };

  // Extract model from request body as fallback for token tracking when the
  // upstream response omits the model field (e.g., Copilot SDK streaming).
  let requestModel = null;
  if (body && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (parsed && typeof parsed.model === 'string') requestModel = parsed.model;
    } catch { /* non-JSON body */ }
  }
  trackTokenUsage(proxyRes, {
    requestId, provider, path: sanitizeForLog(req.url), res, startTime, metrics, billingInfo, initiatorSent, requestModel, purpose, steering,
    caller: req.awfCaller || null,
    ...(requestedEndpoint ? { requestedEndpoint, upstreamEndpoint } : {}),
    ...(req.awfModelFallback ? { modelFallback: req.awfModelFallback } : {}),
    settleSteeringDelivery: !!steeringDelivery,
    onSseData,
    onSseInspectionStart: () => req.awfRouting?.onSseInspectionStart?.(),
    onSseInspectionComplete,
    onUsage: (normalizedUsage, model) => {
      req.awfEnclaveModelBudgetAttempt?.settle(normalizedUsage);
      otel.setTokenAttributes(span, { provider, model, normalizedUsage, streaming: isStreaming });
      const budgetResult = computeTokenBudgetUsage({
        logRequest, requestId, provider, purpose, catalogue: req.awfCatalogue,
        runtimeCatalog: req.awfRuntimePricing,
      }, normalizedUsage, model);
      otel.setBudgetAttributes(span, budgetResult);
      return budgetResult;
    },
    onUsageMissing: () => req.awfEnclaveModelBudgetAttempt?.settleMissing(),
    onSpanEnd: (statusCode) => {
      otel.endSpan(span, statusCode);
    },
  });
}

module.exports = {
  setupTokenTracking,
};
