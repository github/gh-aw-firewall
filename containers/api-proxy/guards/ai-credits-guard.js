'use strict';

const { logRequest, sanitizeForLog } = require('../logging');
const pricingByModel = require('../model-information.pricing.generated.json');
const { getRuntimePricingFact } = require('../runtime-model-catalog');
const { getCatalogueLoader } = require('../catalogue-loader');
const { getCentralPricingFact, getMaintainedPricingFact, getImportedPricingFact,
  getMedianPricingFact } = require('../catalogue-pricing');
const { resolveApiKey, deriveCopilotApiTarget, isGithubCopilotCatalogTarget } = require('../providers/copilot-auth');
const { getProviderPricingFact } = require('../provider-pricing-overlays');
const { getConfiguredPricingFact } = require('../model-pricing-catalog');
const { parsePositiveNumber } = require('./guard-utils');
const { PROVIDER_ANTHROPIC, PROVIDER_COPILOT } = require('../provider-names');
const { BUDGET_WARNING_THRESHOLDS } = require('./steering-thresholds');
const { resolvePricing } = require('../catalogue-contract/pricing-resolution');
const { resolveModelIdentity } = require('../model-identity');
const exact = require('../catalogue-contract/exact-pricing');

const TOKENS_PER_MILLION = 1_000_000;
const DOLLARS_PER_CREDIT = 0.01;
const CREDIT_DENOMINATOR = TOKENS_PER_MILLION * DOLLARS_PER_CREDIT;

// Default operator-controlled safety limit, enforced regardless of maxAiCredits.
const HARD_CAP_AI_CREDITS = 10_000;

function getHardCapAiCredits(rawCap = process.env.AWF_AI_CREDITS_HARD_CAP) {
  const value = Number(rawCap);
  try {
    const preciseValue = exact.decimal(rawCap);
    if (Number.isFinite(value) && exact.compare(preciseValue, exact.ZERO) > 0) {
      return { value, preciseValue };
    }
  } catch {
    // Invalid operator values retain the mandatory default.
  }
  return { value: HARD_CAP_AI_CREDITS, preciseValue: exact.decimal(HARD_CAP_AI_CREDITS) };
}

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
      if (catalogPricing[field] !== null && catalogPricing[field] !== undefined) {
        if (exact.compare(exact.decimal(catalogPricing[field]), exact.decimal(pricing[field])) > 0) {
          pricing[field] = catalogPricing[field];
        }
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
  return exact.number(value);
}

function getEffectiveAiCreditsCeiling(config = getAiCreditsConfig()) {
  return config.exactMax ?? config.preciseHardCap;
}

function updateAiCreditSteeringThresholds() {
  const config = getAiCreditsConfig();
  const ceiling = getEffectiveAiCreditsCeiling(config);
  const configKey = `${ceiling.n}/${ceiling.d}`;
  if (aiCreditsState.steeringConfigKey !== configKey) {
    aiCreditsState.steeringConfigKey = configKey;
    aiCreditsState.emittedThresholds.clear();
    aiCreditsState.uninjectedThresholds.clear();
  }

  for (const threshold of BUDGET_WARNING_THRESHOLDS) {
    if (exact.compare(exact.multiply(aiCreditsState.totalAiCredits, exact.decimal(100)),
      exact.multiply(ceiling, exact.decimal(threshold))) >= 0 &&
      !aiCreditsState.emittedThresholds.has(threshold)) {
      aiCreditsState.emittedThresholds.add(threshold);
      aiCreditsState.uninjectedThresholds.add(threshold);
    }
  }
}

function createAiCreditsState() {
  return {
    totalAiCredits: exact.ZERO,
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
  initialized: false,
  rawMax: undefined,
  rawDefault: undefined,
  rawHardCap: undefined,
  parsed: { max: null, defaultPricing: null },
};

function parseDefaultPricing(rawDefault) {
  let defaultPricing = null;
  if (rawDefault) {
    try {
      const parsed = JSON.parse(rawDefault);
      if (parsed && parsed.input !== undefined && parsed.output !== undefined) {
        defaultPricing = exact.fromExact({
          input: exact.decimal(parsed.input),
          cachedInput: parsed.cachedInput === undefined
            ? exact.multiply(exact.decimal(parsed.input), exact.decimal('0.1')) : exact.decimal(parsed.cachedInput),
          cacheWrite: parsed.cacheWrite == null ? null : exact.decimal(parsed.cacheWrite),
          output: exact.decimal(parsed.output),
          ...(parsed.reasoning !== undefined ? { reasoning: exact.decimal(parsed.reasoning) } : {}),
        });
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  return defaultPricing;
}

function getAiCreditsConfig() {
  try {
    return parseAiCreditsConfig();
  } catch (error) {
    throwAccountingFailure(error);
  }
}

function parseAiCreditsConfig() {
  const rawMax = process.env.AWF_MAX_AI_CREDITS;
  const rawDefault = process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
  const rawHardCap = process.env.AWF_AI_CREDITS_HARD_CAP;
  if (aiCreditsConfigCache.initialized && aiCreditsConfigCache.rawMax === rawMax &&
      aiCreditsConfigCache.rawDefault === rawDefault && aiCreditsConfigCache.rawHardCap === rawHardCap) {
    return aiCreditsConfigCache.parsed;
  }
  const hardCap = getHardCapAiCredits(rawHardCap);
  const parsedMax = parsePositiveNumber(rawMax);
  let exactMax = null;
  // Invalid/nonpositive legacy limits retain their opt-out semantics.
  if (parsedMax || (typeof rawMax === 'string' &&
      /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawMax.trim()))) {
    exactMax = exact.decimal(rawMax);
    if (exact.compare(exactMax, exact.ZERO) === 0) exactMax = null;
  }
  if (exactMax) {
    if (exact.compare(exactMax, hardCap.preciseValue) > 0) {
      exactMax = hardCap.preciseValue;
    }
  }
  aiCreditsConfigCache.initialized = true;
  aiCreditsConfigCache.rawMax = rawMax;
  aiCreditsConfigCache.rawDefault = rawDefault;
  aiCreditsConfigCache.rawHardCap = rawHardCap;
  aiCreditsConfigCache.parsed = {
    max: exactMax ? Math.min(Number(rawMax), hardCap.value) : null,
    exactMax,
    hardCap: hardCap.value,
    preciseHardCap: hardCap.preciseValue,
    get defaultPricing() { return parseDefaultPricing(rawDefault); },
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
    median: () => options.allowMedianEstimate === false ? null : getMedianPricingFact(provider, pricingModel, inputTokens, {
      scope, catalogue, runtimeCatalog: options.runtimeCatalog,
      centralAllowed: !resolveApiKey(process.env) &&
        isGithubCopilotCatalogTarget(deriveCopilotApiTarget(process.env)),
    }),
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
  if (resolution.missingModelPricing && !options.quiet) {
    warnSelectedModelPricing(model, provider, resolution.result, state);
  }
  return resolution.result;
}

function warnSelectedModelPricing(model, provider, result, state = aiCreditsState) {
  if (!result?.estimate) return warnMissingModelPricing(model, state);
  const estimate = result.estimate;
  const key = `${provider}:${model}:${estimate.basis}`;
  if (state.warnedUnknownModels.has(key)) return;
  logRequest('warn', 'estimated_model_ai_credits_pricing', {
    provider: sanitizeForLog(provider), basis: estimate.basis,
    ...(estimate.family ? { family: sanitizeForLog(estimate.family).slice(0, 120) } : {}),
    donor_count: estimate.donorCount, component_donors: estimate.componentDonors,
    sources: estimate.sources,
    message: 'Model pricing is unavailable; using a same-backend per-component median accounting estimate. ' +
      'Estimated usage counts toward AI-credit totals and budgets; this is not verified provider billing.',
  });
  state.warnedUnknownModels.add(key);
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
    message: 'Model-specific pricing is unavailable from the pricing catalogs. ' +
      'Configured defaultAiCreditsPricing will be used if available; otherwise, without eligible same-backend median donors, ' +
      'unpriced usage is excluded from AI-credit totals and budget enforcement may undercount spending.',
  });
  state.warnedUnknownModels.add(model);
}

function checkModelPricing(model, provider = undefined, options = {}) {
  if (aiCreditsState.pricingFailure) return buildPricingResolutionError();
  try {
    getAiCreditsConfig();
    if (model) {
      const selected = resolveModelPricing(model, aiCreditsState, provider, 0, { ...options, quiet: true });
      if (selected?.estimate) warnSelectedModelPricing(model, provider, selected);
      else if (!selected || !isModelPriceable(model, provider, options)) warnMissingModelPricing(model);
    }
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
    return price === null ? exact.ZERO
      : exact.divide(exact.multiply(exact.decimal(tokens), price), exact.decimal(CREDIT_DENOMINATOR));
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
    pricingDiscountPercent: pricingResolution.discountPercent,
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

function throwAccountingFailure(error) {
  aiCreditsState.pricingFailure = true;
  if (error.code === 'pricing_resolution_error') throw error;
  logRequest('error', 'pricing_resolution_error', {
    reason: 'exact_accounting_failed', message: 'AI-credit accounting failed; no approximate price was applied.',
  });
  const sanitized = new Error('AI-credit pricing resolution failed');
  sanitized.code = 'pricing_resolution_error';
  sanitized.statusCode = 500;
  throw sanitized;
}

function applyExactAiCreditsUsage(normalizedUsage, model, provider = undefined, options = {}) {
  if (!normalizedUsage) return null;
  getAiCreditsConfig();
  const safeModel = model || 'unknown';
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
  aiCreditsState.totalAiCredits = total;
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
  try {
    return buildAiCreditsReflectState();
  } catch (error) {
    throwAccountingFailure(error);
  }
}

function buildAiCreditsReflectState() {
  const config = getAiCreditsConfig();
  const effectiveCeiling = getEffectiveAiCreditsCeiling(config);
  const reflectedTotal = exact.compare(aiCreditsState.totalAiCredits, effectiveCeiling) < 0
    ? aiCreditsState.totalAiCredits : effectiveCeiling;
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
      ...(usage.pricingEstimate ? { pricing_estimate: usage.pricingEstimate } : {}),
      accounting_policy: usage.accountingPolicy || null,
      fallback_pricing_used: usage.fallbackPricingUsed === true,
      dynamic_selector: usage.dynamicSelector || null,
    };
  }
  return {
    total: roundCredits(aiCreditsState.totalAiCredits),
    ...(aiCreditsState.pricingFailure ? { pricing_error: 'pricing_resolution_error' } : {}),
    max_ai_credits: config.max,
    effective_max_ai_credits: Number(config.max ?? config.hardCap),
    percent_used: exact.number(exact.multiply(exact.divide(reflectedTotal, effectiveCeiling), exact.decimal(100)), 2),
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
  try {
    updateAiCreditSteeringThresholds();
  } catch (error) {
    throwAccountingFailure(error);
  }
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
  const roundedTotalAiCredits = roundCredits(aiCreditsState.totalAiCredits);
  const hardCap = getHardCapAiCredits();

  // Hard cap always applies, regardless of config
  if (exact.compare(aiCreditsState.totalAiCredits, hardCap.preciseValue) >= 0) {
    return {
      maxAiCredits: hardCap.value,
      totalAiCredits: roundedTotalAiCredits,
      maxExceeded: true,
      hardCap: true,
    };
  }

  let config;
  try {
    config = getAiCreditsConfig();
  } catch (error) {
    if (error.code !== 'pricing_resolution_error') throw error;
    // The shared pricing-error descriptor blocks dispatch for invalid limits.
    return null;
  }
  if (!config.exactMax) return null;
  return {
    maxAiCredits: config.max,
    totalAiCredits: roundedTotalAiCredits,
    maxExceeded: exact.compare(aiCreditsState.totalAiCredits, config.exactMax) >= 0,
  };
}

function buildAiCreditsLimitError(aiCreditsBlockState) {
  const isHardCap = aiCreditsBlockState.hardCap === true;
  return {
    error: {
      type: 'ai_credits_limit_exceeded',
      message: isHardCap
        ? `Hard cap on AI credits reached (${aiCreditsBlockState.totalAiCredits.toFixed(6)} / ${aiCreditsBlockState.maxAiCredits}). This limit is set by the operator and cannot be raised from inside the run.`
        : `Maximum AI credits exceeded (${aiCreditsBlockState.totalAiCredits.toFixed(6)} / ${aiCreditsBlockState.maxAiCredits}).`,
      total_ai_credits: aiCreditsBlockState.totalAiCredits,
      max_ai_credits: aiCreditsBlockState.maxAiCredits,
      hard_cap: isHardCap,
    },
  };
}

function resetAiCreditsGuardForTests() {
  aiCreditsState = createAiCreditsState();
  aiCreditsConfigCache.initialized = false;
  aiCreditsConfigCache.rawMax = undefined;
  aiCreditsConfigCache.rawDefault = undefined;
  aiCreditsConfigCache.rawHardCap = undefined;
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
