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
  if (!Number.isFinite(parsed) || parsed < 0) return null;
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
  const exactModels = new Set();
  const pricingByExactModel = new Map();
  const pricingByAlias = new Map();

  for (const entry of entries) {
    const normalizedPricing = normalizePricing(entry?.pricing);
    const exactModel = canonicalizeModel(entry?.id);
    if (exactModel) {
      knownModels.add(exactModel);
      exactModels.add(exactModel);
      if (!pricingByExactModel.has(exactModel)) {
        pricingByExactModel.set(exactModel, normalizedPricing);
      }
    }

    const alias = canonicalizeModel(entry?.canonical_slug);
    if (alias) {
      knownModels.add(alias);
      if (normalizedPricing && !pricingByAlias.has(alias)) {
        pricingByAlias.set(alias, normalizedPricing);
      }
    }
  }

  return { knownModels, exactModels, pricingByExactModel, pricingByAlias };
}

const catalogIndex = buildCatalogIndex(Array.isArray(bundledCatalog?.data) ? bundledCatalog.data : []);

function resolveCatalogModel(model, index = catalogIndex) {
  const canonical = canonicalizeModel(model);
  if (!canonical) {
    return { exists: false, pricing: null, zeroCost: false };
  }

  if (index.exactModels.has(canonical)) {
    const exactPricing = index.pricingByExactModel.get(canonical) || null;
    return { exists: true, pricing: exactPricing, zeroCost: isZeroCostPricing(exactPricing) };
  }

  const aliasPricing = index.pricingByAlias.get(canonical) || null;
  return {
    exists: index.knownModels.has(canonical),
    pricing: aliasPricing,
    zeroCost: isZeroCostPricing(aliasPricing),
  };
}

module.exports = {
  resolveCatalogModel, buildCatalogIndex,
};
