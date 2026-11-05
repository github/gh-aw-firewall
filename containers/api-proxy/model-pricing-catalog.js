'use strict';

const { getProviderAliases } = require('./provider-pricing-overlays');
const { selectPricingFact } = require('./catalogue-contract/pricing-resolution');
const exact = require('./catalogue-contract/exact-pricing');

let cachedRaw;
let cachedCatalog = null;

function canonicalizeModel(model) {
  if (!model || typeof model !== 'string') return '';
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const withoutDateSuffix = bare.replace(/(-alpha)?-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  return withoutDateSuffix.replace(/[._]/g, '-').toLowerCase();
}

function normalizePricing(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const normalizeTier = (tier, requireThreshold = false) => {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) return null;
    const { input, output, cachedInput, cacheWrite, reasoning } = tier;
    if ([input, output, cachedInput, reasoning].some(value => value === undefined) ||
        cacheWrite === undefined) {
      return null;
    }
    const threshold = tier.threshold;
    if (requireThreshold && (!Number.isFinite(threshold) || threshold <= 0)) return null;
    return {
      pricing: exact.rates({ input, cachedInput, cacheWrite, output, reasoning }),
      ...(requireThreshold ? { threshold } : {}),
    };
  };

  const defaultTier = normalizeTier(entry);
  if (!defaultTier) return null;
  if (!Object.hasOwn(entry, 'longContext')) return { default: defaultTier.pricing };

  const longContext = normalizeTier(entry.longContext, true);
  if (!longContext) return null;
  longContext.pricing.threshold = longContext.threshold;
  return {
    default: defaultTier.pricing,
    longContext: longContext.pricing,
  };
}

function parseCatalog(raw) {
  if (!raw) return null;
  try {
    const catalog = JSON.parse(raw);
    if (!catalog || catalog.schemaVersion !== 1 ||
        catalog.unit !== 'USD_PER_1M_TOKENS' ||
        typeof catalog.catalogId !== 'string' || !catalog.catalogId.trim() ||
        typeof catalog.version !== 'string' || !catalog.version.trim() ||
        !catalog.providers || typeof catalog.providers !== 'object' || Array.isArray(catalog.providers)) {
      return null;
    }
    return catalog;
  } catch {
    return null;
  }
}

function getCatalog() {
  const raw = process.env.AWF_MODEL_PRICING_CATALOG;
  if (raw === cachedRaw) return cachedCatalog;
  cachedRaw = raw;
  cachedCatalog = parseCatalog(raw);
  return cachedCatalog;
}

function getConfiguredPricingFact(provider, model) {
  const catalog = getCatalog();
  if (!catalog || !provider || !model) return null;

  const canonical = canonicalizeModel(model);
  if (!canonical) return null;

  for (const alias of getProviderAliases(provider)) {
    const providerEntry = catalog.providers[alias];
    const models = providerEntry?.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const [catalogModel, entry] of Object.entries(models)) {
      if (canonicalizeModel(catalogModel) !== canonical) continue;
      const normalized = normalizePricing(entry);
      if (!normalized) return null;
      return {
        source: 'shared_catalog', ...normalized, threshold: normalized.longContext?.threshold,
        metadata: { pricingCatalogId: catalog.catalogId, pricingCatalogVersion: catalog.version },
      };
    }
  }
  return null;
}

function resolveModelPricingCatalog(provider, model, inputTokens = 0) {
  return selectPricingFact(getConfiguredPricingFact(provider, model), inputTokens);
}

function resetModelPricingCatalogForTests() {
  cachedRaw = undefined;
  cachedCatalog = null;
}

module.exports = {
  getConfiguredPricingModelIds: provider => [...new Set(getProviderAliases(provider)
    .flatMap(alias => Object.keys(getCatalog()?.providers[alias]?.models || {})))],
  getConfiguredPricingFact,
  resolveModelPricingCatalog,
  resetModelPricingCatalogForTests,
};
