'use strict';

const bundledCatalog = require('./models.dev.catalog.json');

const DOLLARS_PER_TOKEN_TO_DOLLARS_PER_MILLION = 1_000_000;

function canonicalizeModel(model) {
  if (!model || typeof model !== 'string') return '';
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const withoutDateSuffix = bare.replace(/(-alpha)?-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  return withoutDateSuffix.replace(/[._]/g, '-');
}

function parseDollarsPerToken(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed * DOLLARS_PER_TOKEN_TO_DOLLARS_PER_MILLION;
}

function normalizePricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;

  const input = parseDollarsPerToken(pricing.prompt);
  const output = parseDollarsPerToken(pricing.completion);
  if (input === null || output === null) return null;

  const cachedInput = pricing.input_cache_read === undefined
    ? input * 0.1
    : parseDollarsPerToken(pricing.input_cache_read);
  if (cachedInput === null) return null;

  const cacheWrite = pricing.input_cache_write === undefined
    ? null
    : parseDollarsPerToken(pricing.input_cache_write);
  if (pricing.input_cache_write !== undefined && cacheWrite === null) return null;

  return {
    input,
    cachedInput,
    cacheWrite,
    output,
  };
}

function isZeroCostPricing(pricing) {
  if (!pricing) return false;
  return pricing.input === 0 &&
    pricing.cachedInput === 0 &&
    (pricing.cacheWrite === null || pricing.cacheWrite === 0) &&
    pricing.output === 0;
}

function buildCatalogIndex(entries) {
  const knownModels = new Set();
  const pricingByModel = new Map();

  for (const entry of entries) {
    const normalizedPricing = normalizePricing(entry?.pricing);
    for (const candidate of [entry?.id, entry?.canonical_slug]) {
      const canonical = canonicalizeModel(candidate);
      if (!canonical) continue;
      knownModels.add(canonical);
      if (normalizedPricing && !pricingByModel.has(canonical)) {
        pricingByModel.set(canonical, normalizedPricing);
      }
    }
  }

  return { knownModels, pricingByModel };
}

const { knownModels, pricingByModel } = buildCatalogIndex(Array.isArray(bundledCatalog?.data) ? bundledCatalog.data : []);

function resolveCatalogModel(model) {
  const canonical = canonicalizeModel(model);
  if (!canonical) {
    return { exists: false, pricing: null, zeroCost: false };
  }

  const exactPricing = pricingByModel.get(canonical);
  if (exactPricing) {
    return { exists: true, pricing: exactPricing, zeroCost: isZeroCostPricing(exactPricing) };
  }

  let prefixMatch = null;
  for (const [knownModel, pricing] of pricingByModel.entries()) {
    if (canonical.startsWith(`${knownModel}-`)) {
      if (!prefixMatch || knownModel.length > prefixMatch.key.length) {
        prefixMatch = { key: knownModel, pricing };
      }
    }
  }

  if (prefixMatch) {
    return { exists: true, pricing: prefixMatch.pricing, zeroCost: isZeroCostPricing(prefixMatch.pricing) };
  }

  return { exists: knownModels.has(canonical), pricing: null, zeroCost: false };
}

module.exports = {
  resolveCatalogModel,
};
