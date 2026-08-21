'use strict';

const { applyEffectiveTokenUsage } = require('./guards/effective-token-guard');
const { applyAiCreditsUsage } = require('./guards/ai-credits-guard');
const { applyMaxCacheMissesUsage } = require('./guards/max-cache-misses-guard');

/**
 * Apply effective-token and AI-credits usage guards, emit a token_budget_usage
 * log entry when AI credits are consumed, and return the budget fields to be
 * persisted in the token-usage JSONL record.
 *
 * Extracted from the identical `onUsage` callbacks in upstream-response.js and
 * websocket-proxy.js to keep billing-critical logic in one place.
 *
 * @param {{ logRequest: Function, requestId: string, provider: string }} ctx
 * @param {object} normalizedUsage
 * @param {string|undefined} model
 * @returns {object|undefined} Budget fields for JSONL persistence, or undefined if neither guard is active.
 */
function computeTokenBudgetUsage({ logRequest, requestId, provider }, normalizedUsage, model) {
  const effectiveTokenUsage = applyEffectiveTokenUsage(normalizedUsage, model);
  const aiCreditsUsage = applyAiCreditsUsage(normalizedUsage, model, provider);
  applyMaxCacheMissesUsage(normalizedUsage);
  if (aiCreditsUsage) {
    logRequest('info', 'token_budget_usage', {
      request_id: requestId,
      provider,
      model: model || 'unknown',
      ai_credits_this_response: aiCreditsUsage.aiCreditsThisResponse,
      ai_credits_total: aiCreditsUsage.totalAiCredits,
      pricing_source: aiCreditsUsage.pricingSource,
      pricing_tier: aiCreditsUsage.pricingTier,
      accounting_policy: aiCreditsUsage.accountingPolicy,
      fallback_pricing_used: aiCreditsUsage.fallbackPricingUsed,
      dynamic_selector: aiCreditsUsage.dynamicSelector,
    });
  }
  const budgetFields = {};
  if (effectiveTokenUsage) {
    budgetFields.effective_tokens_this_response = effectiveTokenUsage.effectiveTokensThisResponse;
    budgetFields.effective_tokens_total = effectiveTokenUsage.totalEffectiveTokens;
    budgetFields.model_multiplier = effectiveTokenUsage.modelMultiplier;
  }
  if (aiCreditsUsage) {
    budgetFields.ai_credits_this_response = aiCreditsUsage.aiCreditsThisResponse;
    budgetFields.ai_credits_total = aiCreditsUsage.totalAiCredits;
    budgetFields.ai_credits_pricing_source = aiCreditsUsage.pricingSource;
    budgetFields.ai_credits_pricing_tier = aiCreditsUsage.pricingTier;
    budgetFields.ai_credits_accounting_policy = aiCreditsUsage.accountingPolicy;
    budgetFields.ai_credits_fallback_pricing_used = aiCreditsUsage.fallbackPricingUsed;
    budgetFields.ai_credits_dynamic_selector = aiCreditsUsage.dynamicSelector;
    if (aiCreditsUsage.pricingObservedAt) {
      budgetFields.ai_credits_pricing_observed_at = aiCreditsUsage.pricingObservedAt;
    }
    if (aiCreditsUsage.pricingApiVersion) {
      budgetFields.ai_credits_pricing_api_version = aiCreditsUsage.pricingApiVersion;
    }
    if (aiCreditsUsage.pricingDiscountPercent !== undefined) {
      budgetFields.ai_credits_pricing_discount_percent = aiCreditsUsage.pricingDiscountPercent;
    }
  }
  return Object.keys(budgetFields).length > 0 ? budgetFields : undefined;
}

module.exports = { computeTokenBudgetUsage };
