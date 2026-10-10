'use strict';

const { computeTokenBudgetUsage } = require('./token-budget-log');

function setupTokenTracking(proxyRes, body, {
  requestId, provider, req, res, startTime, billingInfo,
  initiatorSent, span, isStreaming,
  trackTokenUsage, sanitizeForLog, metrics, otel, logRequest, wireApiCompatibility,
}) {
  const purpose = req.awfRequestContext?.purpose;
  const steering = req.awfSteering;
  const requestedEndpoint = wireApiCompatibility?.requestedEndpoint || null;
  const upstreamEndpoint = wireApiCompatibility?.upstreamEndpoint || null;
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
    ...(requestedEndpoint ? { requestedEndpoint, upstreamEndpoint } : {}),
    ...(req.awfModelFallback ? { modelFallback: req.awfModelFallback } : {}),
    ...(req.awfRouting ? {
      onSseData: req.awfRouting.onSseData,
      onSseInspectionStart: req.awfRouting.onSseInspectionStart,
      onSseInspectionComplete: req.awfRouting.onSseInspectionComplete,
    } : {}),
    onUsage: (normalizedUsage, model) => {
      otel.setTokenAttributes(span, { provider, model, normalizedUsage, streaming: isStreaming });
      const budgetResult = computeTokenBudgetUsage({ logRequest, requestId, provider, purpose }, normalizedUsage, model);
      otel.setBudgetAttributes(span, budgetResult);
      return budgetResult;
    },
    onSpanEnd: (statusCode) => {
      otel.endSpan(span, statusCode);
    },
  });
}

module.exports = {
  setupTokenTracking,
};
