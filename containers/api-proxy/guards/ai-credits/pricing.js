'use strict';

const { logRequest, sanitizeForLog } = require('../../logging');
const pricingByModel = require('../../model-information.pricing.generated.json');
const { getRuntimePricingFact } = require('../../runtime-model-catalog');
const { getCatalogueLoader } = require('../../catalogue-loader');
const { getCentralPricingFact, getMaintainedPricingFact, getImportedPricingFact,
  getMedianPricingFact } = require('../../catalogue-pricing');
const { resolveApiKey, deriveCopilotApiTarget, isGithubCopilotCatalogTarget } = require('../../providers/copilot-auth');
const { getProviderPricingFact } = require('../../provider-pricing-overlays');
const { getConfiguredPricingFact } = require('../../model-pricing-catalog');
const { PROVIDER_COPILOT } = require('../../provider-names');
const { resolvePricing } = require('../../catalogue-contract/pricing-resolution');
const { resolveModelIdentity } = require('../../model-identity');
const exact = require('../../catalogue-contract/exact-pricing');

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

function buildPricingResolutionError() {
  return { error: {
    type: 'pricing_resolution_error',
    message: 'AI-credit pricing resolution failed; accounting could not be completed. Restart the proxy after correcting pricing configuration.',
  } };
}

function createAiCreditsPricing({ getState, getAiCreditsConfig }) {
  function resolveModelPricing(model, state = getState(), provider = undefined, inputTokens = 0, options = {}) {
    const pricingModel = model.includes('?') ? model.slice(0, model.indexOf('?')) : model;
    let catalogue;
    const scope = provider
      ? { provider, channel: provider === PROVIDER_COPILOT ? 'copilot-api' : 'native-api' } : null;
    const capture = { identity: null, scope, inputTokens, time: null, maxAge: null, sources: {
      operator: () => provider ? getProviderPricingFact(provider, pricingModel) : null,
      configured: () => provider ? getConfiguredPricingFact(provider, pricingModel) : null,
      runtime: () => {
        capture.runtimeFact = provider
          ? getRuntimePricingFact(provider, pricingModel, options.runtimeCatalog, { now: options.now }) : null;
        catalogue = Object.hasOwn(options, 'catalogue') ? options.catalogue : getCatalogueLoader().capture();
        capture.time = catalogue?.time ?? null;
        capture.maxAge = catalogue?.maxAge ?? null;
        return capture.runtimeFact;
      },
      central: () => provider && !resolveApiKey(process.env) &&
        isGithubCopilotCatalogTarget(deriveCopilotApiTarget(process.env))
        ? getCentralPricingFact(provider, pricingModel, catalogue, { nativeInput: true }) : null,
      curated: () => getMaintainedPricingFact(provider, pricingModel, {
        scope, inputTokens, time: catalogue?.time, preferredTier: capture.runtimeFact?.tier,
      }),
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
    return resolution.result ? { ...resolution.result, componentSources: resolution.componentSources } : null;
  }

  function warnSelectedModelPricing(model, provider, result, state = getState()) {
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
    const defaultTier = resolveModelPricing(model, getState(), provider, 0, { ...options, quiet: true });
    if (!defaultTier) return false;
    const highestTier = resolveModelPricing(
      model,
      getState(),
      provider,
      Number.MAX_SAFE_INTEGER,
      { ...options, quiet: true },
    );
    return !!highestTier;
  }

  function warnMissingModelPricing(model, state = getState()) {
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
    if (getState().pricingFailure) return buildPricingResolutionError();
    try {
      getAiCreditsConfig();
      if (model) {
        const selected = resolveModelPricing(model, getState(), provider, 0, { ...options, quiet: true });
        if (selected?.estimate) warnSelectedModelPricing(model, provider, selected);
        else if (!selected || !isModelPriceable(model, provider, options)) warnMissingModelPricing(model);
      }
    } catch (error) {
      if (error.code !== 'pricing_resolution_error') throw error;
      return buildPricingResolutionError();
    }
    return null;
  }

  return {
    resolveModelPricing,
    checkModelPricing,
    isModelPriceable,
    isRecognizedDynamicSelector,
    canonicalizeModel,
    getDynamicSelectorDescriptor,
  };
}

module.exports = { createAiCreditsPricing };
