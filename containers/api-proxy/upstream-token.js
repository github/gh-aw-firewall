'use strict';

const { computeTokenBudgetUsage } = require('./token-budget-log');

function setupTokenTracking(proxyRes, body, {
  requestId, provider, req, startTime, billingInfo,
  initiatorSent, span, isStreaming,
  trackTokenUsage, sanitizeForLog, metrics, otel, logRequest,
}) {
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
    requestId, provider, path: sanitizeForLog(req.url), startTime, metrics, billingInfo, initiatorSent, requestModel,
    onUsage: (normalizedUsage, model) => {
      otel.setTokenAttributes(span, { provider, model, normalizedUsage, streaming: isStreaming });
      const budgetResult = computeTokenBudgetUsage({ logRequest, requestId, provider }, normalizedUsage, model);
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
