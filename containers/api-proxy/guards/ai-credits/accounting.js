'use strict';

const { logRequest, sanitizeForLog } = require('../../logging');
const { PROVIDER_ANTHROPIC, PROVIDER_COPILOT } = require('../../provider-names');
const exact = require('../../catalogue-contract/exact-pricing');

const TOKENS_PER_MILLION = 1_000_000;
const DOLLARS_PER_CREDIT = 0.01;
const CREDIT_DENOMINATOR = TOKENS_PER_MILLION * DOLLARS_PER_CREDIT;

// Number of the run's most recent priced model requests (excluding
// routing-classifier requests) whose average cost estimates how many more
// requests fit in the remaining AI-credit budget.
const RECENT_REQUEST_COST_WINDOW = 10;

function roundCredits(value) {
  return exact.number(value);
}

function createAiCreditsAccounting({
  getState, getAiCreditsConfig, resolveModelPricing, getDynamicSelectorDescriptor,
  throwAccountingFailure, updateAiCreditSteeringThresholds,
}) {
  function calculateAiCredits(normalizedUsage, model, state = getState(), provider = undefined, options = {}) {
    for (const field of ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens']) {
      const value = normalizedUsage[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error('pricing_invalid_token_count');
      }
    }
    const reportedInput = normalizedUsage.input_tokens || 0;
    const cacheReadTokens = normalizedUsage.cache_read_tokens || 0;
    const cacheWriteTokens = normalizedUsage.cache_write_tokens || 0;
    const inputIncludesCache = normalizedUsage.input_tokens_include_cache === true;
    const additiveInput = provider === PROVIDER_ANTHROPIC ||
      (provider === PROVIDER_COPILOT && !inputIncludesCache);
    const totalInputForTier = additiveInput
      ? reportedInput + cacheReadTokens + cacheWriteTokens
      : reportedInput;
    if (!Number.isSafeInteger(totalInputForTier)) throw new Error('pricing_invalid_token_count');
    const pricingResolution = resolveModelPricing(model, state, provider, totalInputForTier, options);
    if (!pricingResolution) return null;
    if (options.catalogue &&
        !['operator', 'shared_catalog', 'provider', 'central_feed'].includes(pricingResolution.source)) {
      logRequest('info', 'central_feed_pricing_fallback', {
        provider, model: sanitizeForLog(model), revision: options.catalogue.revision,
        reason: 'no_fresh_supported_scoped_tariff', fallback_source: pricingResolution.source,
      });
    }
    const { pricing } = pricingResolution;
    const dynamicSelector = getDynamicSelectorDescriptor(model, provider);
    const promotion = pricingResolution.promotion;
    const discountedComponents = promotion?.active && promotion.discountPercent > 0
      ? Object.entries(pricingResolution.componentSources)
        .filter(([, provenance]) => provenance.source === 'provider')
        .map(([field]) => field)
      : [];
    const percent = promotion?.discountPercent ?? 0;
    const hundred = exact.decimal(100);
    const discount = exact.decimal(percent);
    const discountFactor = exact.divide({
      n: hundred.n * discount.d - discount.n * hundred.d,
      d: hundred.d * discount.d,
    }, hundred);
    const pricingPromotion = promotion ? {
      ...promotion,
      applied: discountedComponents.length > 0,
      discountedComponents,
      listPriceSource: pricingResolution.source,
      listPriceTier: pricingResolution.tier,
      effectivePriceSource: discountedComponents.length > 0 ? 'provider_promotion' : pricingResolution.source,
      effectivePriceTier: pricingResolution.tier,
    } : undefined;

    // input_tokens semantics differ by provider:
    //  - Anthropic and Copilot's precise copilot_usage report input_tokens as the
    //    NON-cached input only;
    //    cache_read_input_tokens and cache_creation_input_tokens are reported
    //    separately and are ADDITIVE to input_tokens. Subtracting them here would
    //    over-subtract and undercount the genuinely-fresh input tokens.
    //  - OpenAI-style usage (including Copilot responses without copilot_usage)
    //    reports prompt_tokens/input_tokens
    //    as the TOTAL input, with cached tokens being a SUBSET. Those must be
    //    subtracted before applying the full input rate to avoid double-counting.
    const nonCachedInput = additiveInput
      ? reportedInput
      : Math.max(0, reportedInput - cacheReadTokens - cacheWriteTokens);

    const charge = (tokens, field) => {
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('pricing_invalid_token_count');
      const price = exact.rate(pricing, field);
      if (price === null) return exact.ZERO;
      const credits = exact.divide(exact.multiply(exact.decimal(tokens), price), exact.decimal(CREDIT_DENOMINATOR));
      return discountedComponents.includes(field) ? exact.multiply(credits, discountFactor) : credits;
    };
    const inputCredits = charge(nonCachedInput, 'input');
    const cachedInputCredits = charge(cacheReadTokens, 'cachedInput');
    const cacheWriteCredits = charge(cacheWriteTokens, 'cacheWrite');
    const outputTokens = normalizedUsage.output_tokens || 0;
    const reasoningTokens = Math.min(
      Math.max(0, normalizedUsage.reasoning_tokens || 0),
      Math.max(0, outputTokens),
    );
    const reasoningCredits = charge(reasoningTokens, pricing.reasoning === undefined ? 'output' : 'reasoning');
    const outputCredits = exact.add(charge(Math.max(0, outputTokens - reasoningTokens), 'output'), reasoningCredits);
    const totalCredits = [inputCredits, cachedInputCredits, cacheWriteCredits, outputCredits]
      .reduce(exact.add, exact.ZERO);

    return {
      inputCredits,
      cachedInputCredits,
      cacheWriteCredits,
      outputCredits,
      totalCredits,
      pricingSource: pricingResolution.source,
      pricingTier: pricingResolution.tier,
      pricingObservedAt: pricingResolution.observedAt,
      pricingApiVersion: pricingResolution.apiVersion,
      pricingDiscountPercent: promotion?.discountPercent,
      pricingPromotion,
      pricingCatalogId: pricingResolution.pricingCatalogId,
      pricingCatalogVersion: pricingResolution.pricingCatalogVersion,
      pricingEstimate: pricingResolution.estimate,
      accountingPolicy: pricingResolution.accountingPolicy ||
        (dynamicSelector ? 'dynamic_selector_runtime' : model === 'unknown' ? 'unknown_model_fallback' : 'concrete_model'),
      usedFallbackPricing: pricingResolution.usedFallbackPricing === true ||
        pricingResolution.source === 'configured_default' ||
        pricingResolution.source === 'builtin_fallback' ||
        pricingResolution.source === 'dynamic_selector_fallback',
      dynamicSelector: pricingResolution.dynamicSelector || dynamicSelector?.name || null,
    };
  }

  function applyAiCreditsUsage(normalizedUsage, model, provider = undefined, options = {}) {
    try {
      return applyExactAiCreditsUsage(normalizedUsage, model, provider, options);
    } catch (error) {
      throwAccountingFailure(error);
    }
  }

  function applyExactAiCreditsUsage(normalizedUsage, model, provider = undefined, options = {}) {
    if (!normalizedUsage) return null;
    getAiCreditsConfig();
    const safeModel = model || 'unknown';
    const aiCreditsState = getState();
    const calc = calculateAiCredits(normalizedUsage, safeModel, aiCreditsState, provider, options);
    if (!calc) return null;

    if (!Object.hasOwn(aiCreditsState.byModel, safeModel)) {
      aiCreditsState.byModel[safeModel] = {
        inputCredits: exact.ZERO,
        cachedInputCredits: exact.ZERO,
        cacheWriteCredits: exact.ZERO,
        outputCredits: exact.ZERO,
        totalCredits: exact.ZERO,
        pricingSource: calc.pricingSource,
        pricingTier: calc.pricingTier,
        pricingCatalogId: calc.pricingCatalogId,
        pricingCatalogVersion: calc.pricingCatalogVersion,
        accountingPolicy: calc.accountingPolicy,
        fallbackPricingUsed: calc.usedFallbackPricing,
        dynamicSelector: calc.dynamicSelector,
      };
    }

    const modelBucket = aiCreditsState.byModel[safeModel];
    const totals = {};
    for (const field of ['inputCredits', 'cachedInputCredits', 'cacheWriteCredits', 'outputCredits', 'totalCredits']) {
      totals[field] = exact.add(modelBucket[field], calc[field]);
      roundCredits(totals[field]);
    }
    const total = exact.add(aiCreditsState.totalAiCredits, calc.totalCredits);
    roundCredits(total);
    Object.assign(modelBucket, totals);
    modelBucket.pricingSource = calc.pricingSource;
    modelBucket.pricingTier = calc.pricingTier;
    modelBucket.pricingCatalogId = calc.pricingCatalogId;
    modelBucket.pricingCatalogVersion = calc.pricingCatalogVersion;
    modelBucket.accountingPolicy = calc.accountingPolicy;
    modelBucket.fallbackPricingUsed = calc.usedFallbackPricing;
    modelBucket.dynamicSelector = calc.dynamicSelector;
    modelBucket.pricingEstimate = calc.pricingEstimate;
    modelBucket.pricingPromotion = calc.pricingPromotion;
    aiCreditsState.totalAiCredits = total;
    if (options.purpose !== 'routing_classification') {
      aiCreditsState.recentRequestCosts.push(calc.totalCredits);
      if (aiCreditsState.recentRequestCosts.length > RECENT_REQUEST_COST_WINDOW) {
        aiCreditsState.recentRequestCosts.shift();
      }
    }
    updateAiCreditSteeringThresholds();

    process.env.AWF_AI_CREDITS_USED = String(roundCredits(aiCreditsState.totalAiCredits));

    return {
      aiCreditsThisResponse: roundCredits(calc.totalCredits),
      inputCreditsThisResponse: roundCredits(calc.inputCredits),
      cachedInputCreditsThisResponse: roundCredits(calc.cachedInputCredits),
      cacheWriteCreditsThisResponse: roundCredits(calc.cacheWriteCredits),
      outputCreditsThisResponse: roundCredits(calc.outputCredits),
      totalAiCredits: roundCredits(aiCreditsState.totalAiCredits),
      pricingSource: calc.pricingSource,
      pricingTier: calc.pricingTier,
      ...(calc.pricingCatalogId ? { pricingCatalogId: calc.pricingCatalogId } : {}),
      ...(calc.pricingCatalogVersion ? { pricingCatalogVersion: calc.pricingCatalogVersion } : {}),
      ...(calc.pricingEstimate ? { pricingEstimate: calc.pricingEstimate } : {}),
      ...(calc.pricingPromotion ? { pricingPromotion: calc.pricingPromotion } : {}),
      accountingPolicy: calc.accountingPolicy,
      fallbackPricingUsed: calc.usedFallbackPricing,
      dynamicSelector: calc.dynamicSelector,
      ...(calc.pricingObservedAt ? { pricingObservedAt: calc.pricingObservedAt } : {}),
      ...(calc.pricingApiVersion ? { pricingApiVersion: calc.pricingApiVersion } : {}),
      ...(calc.pricingDiscountPercent !== undefined
        ? { pricingDiscountPercent: calc.pricingDiscountPercent }
        : {}),
    };
  }

  return { calculateAiCredits, applyAiCreditsUsage };
}

module.exports = { createAiCreditsAccounting };
