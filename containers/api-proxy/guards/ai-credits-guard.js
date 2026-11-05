'use strict';

const { logRequest, sanitizeForLog } = require('../logging');
const pricingByModel = require('../model-information.pricing.generated.json');
const { getRuntimePricingFact } = require('../runtime-model-catalog');
const { getCatalogueLoader } = require('../catalogue-loader');
const { getCentralPricingFact, getMaintainedPricingFact, getImportedPricingFact } = require('../catalogue-pricing');
const { resolveApiKey, deriveCopilotApiTarget, isGithubCopilotCatalogTarget } = require('../providers/copilot-auth');
const { getProviderPricingFact } = require('../provider-pricing-overlays');
const { getConfiguredPricingFact } = require('../model-pricing-catalog');
const { parsePositiveNumber } = require('./guard-utils');
const { PROVIDER_ANTHROPIC, PROVIDER_COPILOT } = require('../provider-names');
const { BUDGET_WARNING_THRESHOLDS } = require('./steering-thresholds');
const { resolvePricing } = require('../catalogue-contract/pricing-resolution');
const { resolveModelIdentity } = require('../model-identity');

const TOKENS_PER_MILLION = 1_000_000;
const DOLLARS_PER_CREDIT = 0.01;
const CREDIT_DENOMINATOR = TOKENS_PER_MILLION * DOLLARS_PER_CREDIT;

// Absolute hard cap on AI credits that cannot be overridden by configuration.
// This is a safety limit to prevent runaway spending regardless of what
// maxAiCredits is set to via CLI flags or config files.
const HARD_CAP_AI_CREDITS = 10_000;

// Conservative fallback pricing ($/1M tokens) used when the model is the
// 'unknown' sentinel — i.e., both response and request omitted the model name.
// Uses claude-sonnet-4 level rates so credits are tracked rather than lost.
const BUILTIN_FALLBACK_PRICING = Object.freeze({
  input: 3.00,
  cachedInput: 0.30,
  cacheWrite: 3.75,
  output: 15.00,
});

// Static ceiling for recognized dynamic selectors whose concrete runtime model
// is unknown at accounting time. These rates bound every priced Copilot model
// in the maintained catalog; retain the ceiling if the catalog is unavailable.
const DYNAMIC_SELECTOR_PRICING_CEILING = Object.freeze({
  input: 10.00,
  cachedInput: 1.00,
  cacheWrite: 12.50,
  output: 50.00,
});

function buildDynamicSelectorFallbackPricing() {
  const pricing = { ...DYNAMIC_SELECTOR_PRICING_CEILING };
  for (const catalogPricing of Object.values(pricingByModel)) {
    for (const field of Object.keys(pricing)) {
      if (typeof catalogPricing[field] === 'number') {
        pricing[field] = Math.max(pricing[field], catalogPricing[field]);
      }
    }
  }
  return Object.freeze(pricing);
}

const DYNAMIC_SELECTOR_FALLBACK_PRICING = buildDynamicSelectorFallbackPricing();

// Kept separate from the generic unknown-model fallback because a dynamic
// selector is an explicit provider-supported request, not an unknown model.
const DYNAMIC_SELECTOR_FALLBACK_PRICING_SOURCE = 'dynamic_selector_fallback';

function getDynamicSelectorDescriptor(model, provider = undefined) {
  if (typeof model !== 'string') return null;
  if (provider !== PROVIDER_COPILOT) return null;
  if (model.toLowerCase() !== 'auto') return null;
  return { name: 'copilot:auto' };
}

function isRecognizedDynamicSelector(model, provider = undefined) {
  return !!getDynamicSelectorDescriptor(model, provider);
}

function roundCredits(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function getEffectiveAiCreditsCeiling(config = getAiCreditsConfig()) {
  return Math.min(config.max ?? HARD_CAP_AI_CREDITS, HARD_CAP_AI_CREDITS);
}

function updateAiCreditSteeringThresholds() {
  const config = getAiCreditsConfig();
  const ceiling = getEffectiveAiCreditsCeiling(config);
  const configKey = String(ceiling);
  if (aiCreditsState.steeringConfigKey !== configKey) {
    aiCreditsState.steeringConfigKey = configKey;
    aiCreditsState.emittedThresholds.clear();
    aiCreditsState.uninjectedThresholds.clear();
  }

  const percentUsed = (aiCreditsState.totalAiCredits / ceiling) * 100;
  for (const threshold of BUDGET_WARNING_THRESHOLDS) {
    if (percentUsed >= threshold && !aiCreditsState.emittedThresholds.has(threshold)) {
      aiCreditsState.emittedThresholds.add(threshold);
      aiCreditsState.uninjectedThresholds.add(threshold);
    }
  }
}

function createAiCreditsState() {
  return {
    totalAiCredits: 0,
    byModel: {},
    warnedUnknownModels: new Set(),
    pricingFailure: false,
    steeringConfigKey: null,
    emittedThresholds: new Set(),
    uninjectedThresholds: new Set(),
  };
}

let aiCreditsState = createAiCreditsState();

const aiCreditsConfigCache = {
  rawMax: undefined,
  rawDefault: undefined,
  parsed: { max: null, defaultPricing: null },
};

function getAiCreditsConfig() {
  const rawMax = process.env.AWF_MAX_AI_CREDITS;
  const rawDefault = process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
  if (aiCreditsConfigCache.rawMax === rawMax && aiCreditsConfigCache.rawDefault === rawDefault) {
    return aiCreditsConfigCache.parsed;
  }
  aiCreditsConfigCache.rawMax = rawMax;
  aiCreditsConfigCache.rawDefault = rawDefault;

  let defaultPricing = null;
  if (rawDefault) {
    try {
      const parsed = JSON.parse(rawDefault);
      if (parsed && typeof parsed.input === 'number' && typeof parsed.output === 'number') {
        defaultPricing = {
          input: parsed.input,
          cachedInput: parsed.cachedInput ?? parsed.input * 0.1,
          cacheWrite: parsed.cacheWrite ?? null,
          output: parsed.output,
          ...(typeof parsed.reasoning === 'number' ? { reasoning: parsed.reasoning } : {}),
        };
      }
    } catch { /* invalid JSON — leave null */ }
  }

  const parsedMax = parsePositiveNumber(rawMax);
  aiCreditsConfigCache.parsed = {
    max: parsedMax ? Math.min(parsedMax, HARD_CAP_AI_CREDITS) : null,
    defaultPricing,
  };
  return aiCreditsConfigCache.parsed;
}

/**
 * Historical compatibility helper; active pricing uses scoped source adapters.
 * Canonicalize a model name by stripping provider prefix and normalizing
 * common deployment suffixes and separators (dash, dot, underscore are all
 * treated as equivalent).
 * E.g. "copilot/claude-sonnet-4.6" → "claude-sonnet-4-6"
 *      "claude_sonnet_4_6"          → "claude-sonnet-4-6"
 *      "gpt-5-codex-mini-alpha-2025-11-07" → "gpt-5-codex-mini"
 */
function canonicalizeModel(model) {
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const parameterIndex = bare.indexOf('?');
  const withoutParameters = parameterIndex === -1 ? bare : bare.slice(0, parameterIndex);
  const withoutDateSuffix = withoutParameters.replace(/(-alpha)?-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  return withoutDateSuffix.replace(/[._]/g, '-');
}

function resolveModelPricing(model, state = aiCreditsState, provider = undefined, inputTokens = 0, options = {}) {
  const pricingModel = model.includes('?') ? model.slice(0, model.indexOf('?')) : model;
  let catalogue;
  const scope = provider
    ? { provider, channel: provider === PROVIDER_COPILOT ? 'copilot-api' : 'native-api' } : null;
  const capture = { identity: null, scope, inputTokens, time: null, maxAge: null, sources: {
    operator: () => provider ? getProviderPricingFact(provider, pricingModel) : null,
    configured: () => provider ? getConfiguredPricingFact(provider, pricingModel) : null,
    runtime: () => {
      const fact = provider ? getRuntimePricingFact(provider, pricingModel, options.runtimeCatalog) : null;
      catalogue = Object.hasOwn(options, 'catalogue') ? options.catalogue : getCatalogueLoader().capture();
      capture.time = catalogue?.time ?? null;
      capture.maxAge = catalogue?.maxAge ?? null;
      return fact;
    },
    central: () => provider && !resolveApiKey(process.env) &&
      isGithubCopilotCatalogTarget(deriveCopilotApiTarget(process.env))
      ? getCentralPricingFact(provider, pricingModel, catalogue, { nativeInput: true }) : null,
    curated: () => getMaintainedPricingFact(provider, pricingModel),
    imported: () => getImportedPricingFact(provider, pricingModel),
    selector: () => {
      const selector = getDynamicSelectorDescriptor(pricingModel, provider);
      return selector ? {
        source: DYNAMIC_SELECTOR_FALLBACK_PRICING_SOURCE, tier: 'conservative',
        default: DYNAMIC_SELECTOR_FALLBACK_PRICING,
        metadata: { accountingPolicy: 'dynamic_selector_fallback',
          dynamicSelector: selector.name, usedFallbackPricing: true },
      } : null;
    },
    configuredDefault: () => {
      const { defaultPricing } = getAiCreditsConfig();
      return defaultPricing ? { source: 'configured_default', default: defaultPricing } : null;
    },
    sentinel: () => pricingModel === 'unknown'
      ? { source: 'builtin_fallback', default: BUILTIN_FALLBACK_PRICING } : null,
  } };
  let resolution;
  try {
    capture.identity = provider
      ? resolveModelIdentity(pricingModel, provider, { scope, policy: { providerPrefix: false } }).identity : null;
    resolution = resolvePricing(capture);
  } catch {
    if (!options.quiet) state.pricingFailure = true;
    logRequest('error', 'pricing_resolution_error', {
      reason: 'shared_resolver_failed', message: 'AI-credit pricing resolution failed; no price was applied.',
    });
    const error = new Error('AI-credit pricing resolution failed');
    error.code = 'pricing_resolution_error';
    error.statusCode = 500;
    throw error;
  }
  if (resolution.missingModelPricing && !options.quiet) warnMissingModelPricing(model, state);
  return resolution.result;
}

/**
 * Side-effect-free check for whether a model has resolvable AI-credits pricing.
 *
 * Both the default and the highest selectable pricing tier must resolve.
 * Does not warn for missing prices or mutate guard state. Operational failures
 * are logged and thrown, not treated as missing pricing.
 *
 * @param {string} model
 * @param {string} [provider]
 * @returns {boolean}
 */
function isModelPriceable(model, provider = undefined, options = {}) {
  if (!model) return true;
  const defaultTier = resolveModelPricing(model, aiCreditsState, provider, 0, { ...options, quiet: true });
  if (!defaultTier) return false;
  const highestTier = resolveModelPricing(
    model,
    aiCreditsState,
    provider,
    Number.MAX_SAFE_INTEGER,
    { ...options, quiet: true },
  );
  return !!highestTier;
}

function warnMissingModelPricing(model, state = aiCreditsState) {
  if (state.warnedUnknownModels.has(model)) return;
  logRequest('warn', 'unknown_model_ai_credits_pricing', {
    modelProvided: Boolean(model),
    message: 'Model pricing is unavailable from the pricing catalogs. ' +
      'Configured defaultAiCreditsPricing will be used if available; otherwise ' +
      'unpriced usage is excluded from AI-credit totals and budget enforcement may undercount spending.',
  });
  state.warnedUnknownModels.add(model);
}

function checkModelPricing(model, provider = undefined, options = {}) {
  if (aiCreditsState.pricingFailure) return buildPricingResolutionError();
  try {
    if (model && !isModelPriceable(model, provider, options)) warnMissingModelPricing(model);
  } catch (error) {
    if (error.code !== 'pricing_resolution_error') throw error;
    return buildPricingResolutionError();
  }
  return null;
}

function buildPricingResolutionError() {
  return { error: {
    type: 'pricing_resolution_error',
    message: 'AI-credit pricing resolution failed; accounting could not be completed. Restart the proxy after correcting pricing configuration.',
  } };
}

function calculateAiCredits(normalizedUsage, model, state = aiCreditsState, provider = undefined, options = {}) {
  const reportedInput = normalizedUsage.input_tokens || 0;
  const cacheReadTokens = normalizedUsage.cache_read_tokens || 0;
  const cacheWriteTokens = normalizedUsage.cache_write_tokens || 0;
  const inputIncludesCache = normalizedUsage.input_tokens_include_cache === true;
  const additiveInput = provider === PROVIDER_ANTHROPIC ||
    (provider === PROVIDER_COPILOT && !inputIncludesCache);
  const totalInputForTier = additiveInput
    ? reportedInput + cacheReadTokens + cacheWriteTokens
    : reportedInput;
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

  const inputCredits = (nonCachedInput * pricing.input) / CREDIT_DENOMINATOR;
  const cachedInputCredits = (cacheReadTokens * pricing.cachedInput) / CREDIT_DENOMINATOR;
  const cacheWriteCredits = pricing.cacheWrite
    ? (cacheWriteTokens * pricing.cacheWrite) / CREDIT_DENOMINATOR
    : 0;
  const outputTokens = normalizedUsage.output_tokens || 0;
  const reasoningTokens = Math.min(
    Math.max(0, normalizedUsage.reasoning_tokens || 0),
    Math.max(0, outputTokens),
  );
  const reasoningCredits = (reasoningTokens * (pricing.reasoning ?? pricing.output)) / CREDIT_DENOMINATOR;
  const outputCredits = (
    (Math.max(0, outputTokens - reasoningTokens) * pricing.output / CREDIT_DENOMINATOR)
  ) + reasoningCredits;
  const totalCredits = inputCredits + cachedInputCredits + cacheWriteCredits + outputCredits;

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
    pricingDiscountPercent: pricingResolution.discountPercent,
    pricingCatalogId: pricingResolution.pricingCatalogId,
    pricingCatalogVersion: pricingResolution.pricingCatalogVersion,
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
  if (!normalizedUsage) return null;
  const safeModel = model || 'unknown';
  const calc = calculateAiCredits(normalizedUsage, safeModel, aiCreditsState, provider, options);
  if (!calc) return null;

  if (!Object.hasOwn(aiCreditsState.byModel, safeModel)) {
    aiCreditsState.byModel[safeModel] = {
      inputCredits: 0,
      cachedInputCredits: 0,
      cacheWriteCredits: 0,
      outputCredits: 0,
      totalCredits: 0,
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
  modelBucket.inputCredits += calc.inputCredits;
  modelBucket.cachedInputCredits += calc.cachedInputCredits;
  modelBucket.cacheWriteCredits += calc.cacheWriteCredits;
  modelBucket.outputCredits += calc.outputCredits;
  modelBucket.totalCredits += calc.totalCredits;
  modelBucket.pricingSource = calc.pricingSource;
  modelBucket.pricingTier = calc.pricingTier;
  modelBucket.pricingCatalogId = calc.pricingCatalogId;
  modelBucket.pricingCatalogVersion = calc.pricingCatalogVersion;
  modelBucket.accountingPolicy = calc.accountingPolicy;
  modelBucket.fallbackPricingUsed = calc.usedFallbackPricing;
  modelBucket.dynamicSelector = calc.dynamicSelector;
  aiCreditsState.totalAiCredits += calc.totalCredits;
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

function getAiCreditsReflectState() {
  const config = getAiCreditsConfig();
  const effectiveCeiling = getEffectiveAiCreditsCeiling(config);
  const reflectedTotal = Math.min(aiCreditsState.totalAiCredits, effectiveCeiling);
  const byModel = {};
  for (const [model, usage] of Object.entries(aiCreditsState.byModel)) {
    byModel[model] = {
      input_credits: roundCredits(usage.inputCredits),
      cached_input_credits: roundCredits(usage.cachedInputCredits),
      cache_write_credits: roundCredits(usage.cacheWriteCredits),
      output_credits: roundCredits(usage.outputCredits),
      total: roundCredits(usage.totalCredits),
      pricing_source: usage.pricingSource,
      pricing_tier: usage.pricingTier,
      ...(usage.pricingCatalogId ? { pricing_catalog_id: usage.pricingCatalogId } : {}),
      ...(usage.pricingCatalogVersion ? { pricing_catalog_version: usage.pricingCatalogVersion } : {}),
      accounting_policy: usage.accountingPolicy || null,
      fallback_pricing_used: usage.fallbackPricingUsed === true,
      dynamic_selector: usage.dynamicSelector || null,
    };
  }
  return {
    total: roundCredits(aiCreditsState.totalAiCredits),
    ...(aiCreditsState.pricingFailure ? { pricing_error: 'pricing_resolution_error' } : {}),
    max_ai_credits: config.max,
    effective_max_ai_credits: effectiveCeiling,
    percent_used: Math.round((reflectedTotal / effectiveCeiling) * 10000) / 100,
    thresholds_crossed: [...aiCreditsState.emittedThresholds].sort((a, b) => a - b),
    thresholds_pending: [...aiCreditsState.uninjectedThresholds].sort((a, b) => a - b),
    by_model: byModel,
  };
}

const AI_CREDIT_STEERING_MESSAGES = {
  80: 'You have used 80% of your AI-credit budget. Begin planning to wrap up your current work.',
  90: 'You have used 90% of your AI-credit budget. Complete your current task and prepare final output.',
  95: 'You have used 95% of your AI-credit budget. Finalize and submit your work now.',
  99: 'You have used 99% of your AI-credit budget. You are about to be cut off. Submit immediately.',
};

function getPendingAiCreditSteeringWarning() {
  updateAiCreditSteeringThresholds();
  if (aiCreditsState.uninjectedThresholds.size === 0) return null;
  const threshold = Math.max(...aiCreditsState.uninjectedThresholds);
  const text = AI_CREDIT_STEERING_MESSAGES[threshold] ||
    `You have used ${threshold}% of your AI-credit budget.`;
  return { threshold, message: `[AWF AI CREDIT WARNING] ${text}` };
}

function acknowledgeAiCreditSteeringWarning(threshold) {
  aiCreditsState.uninjectedThresholds.delete(threshold);
}

function getAiCreditsBlockState() {
  const config = getAiCreditsConfig();
  const roundedTotalAiCredits = roundCredits(aiCreditsState.totalAiCredits);

  // Hard cap always applies, regardless of config
  if (roundedTotalAiCredits >= HARD_CAP_AI_CREDITS) {
    return {
      maxAiCredits: HARD_CAP_AI_CREDITS,
      totalAiCredits: roundedTotalAiCredits,
      maxExceeded: true,
      hardCap: true,
    };
  }

  if (!config.max) return null;
  return {
    maxAiCredits: config.max,
    totalAiCredits: roundedTotalAiCredits,
    maxExceeded: roundedTotalAiCredits >= config.max,
  };
}

function buildAiCreditsLimitError(aiCreditsBlockState) {
  const isHardCap = aiCreditsBlockState.hardCap === true;
  return {
    error: {
      type: 'ai_credits_limit_exceeded',
      message: isHardCap
        ? `Hard cap on AI credits reached (${aiCreditsBlockState.totalAiCredits.toFixed(6)} / ${aiCreditsBlockState.maxAiCredits}). This limit cannot be overridden.`
        : `Maximum AI credits exceeded (${aiCreditsBlockState.totalAiCredits.toFixed(6)} / ${aiCreditsBlockState.maxAiCredits}).`,
      total_ai_credits: aiCreditsBlockState.totalAiCredits,
      max_ai_credits: aiCreditsBlockState.maxAiCredits,
      hard_cap: isHardCap,
    },
  };
}

function resetAiCreditsGuardForTests() {
  aiCreditsState = createAiCreditsState();
  aiCreditsConfigCache.rawMax = undefined;
  aiCreditsConfigCache.rawDefault = undefined;
  aiCreditsConfigCache.parsed = { max: null, defaultPricing: null };
  delete process.env.AWF_AI_CREDITS_USED;
}

module.exports = {
  HARD_CAP_AI_CREDITS,
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  getPendingAiCreditSteeringWarning,
  acknowledgeAiCreditSteeringWarning,
  checkModelPricing,
  isRecognizedDynamicSelector,
  isModelPriceable,
  canonicalizeModel,
  resetAiCreditsGuardForTests,
};
