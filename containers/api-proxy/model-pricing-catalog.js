'use strict';

const { getProviderAliases } = require('./provider-pricing-overlays');

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
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 ||
        typeof output !== 'number' || !Number.isFinite(output) || output < 0 ||
        typeof cachedInput !== 'number' || !Number.isFinite(cachedInput) || cachedInput < 0 ||
        (cacheWrite !== null && (typeof cacheWrite !== 'number' || !Number.isFinite(cacheWrite) || cacheWrite < 0)) ||
        typeof reasoning !== 'number' || !Number.isFinite(reasoning) || reasoning < 0) {
      return null;
    }
    const threshold = tier.threshold;
    if (requireThreshold && (!Number.isFinite(threshold) || threshold <= 0)) return null;
    return {
      pricing: { input, cachedInput, cacheWrite, output, reasoning },
      ...(requireThreshold ? { threshold } : {}),
    };
  };

  const defaultTier = normalizeTier(entry);
  if (!defaultTier) return null;
  if (!Object.hasOwn(entry, 'longContext')) return { default: defaultTier.pricing };

  const longContext = normalizeTier(entry.longContext, true);
  if (!longContext) return null;
  return {
    default: defaultTier.pricing,
    longContext: { ...longContext.pricing, threshold: longContext.threshold },
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

function resolveModelPricingCatalog(provider, model, inputTokens = 0) {
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
      const useLongContext = !!normalized.longContext &&
        inputTokens > normalized.longContext.threshold;
      return {
        pricing: useLongContext
          ? normalized.longContext
          : normalized.default,
        source: 'shared_catalog',
        tier: useLongContext ? 'long_context' : 'default',
        pricingCatalogId: catalog.catalogId,
        pricingCatalogVersion: catalog.version,
      };
    }
  }
  return null;
}

function resetModelPricingCatalogForTests() {
  cachedRaw = undefined;
  cachedCatalog = null;
}

module.exports = {
  resolveModelPricingCatalog,
  resetModelPricingCatalogForTests,
};
