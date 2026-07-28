'use strict';

const TOKENS_PER_MILLION = 1_000_000;
const DOLLARS_PER_AIU = 0.01;
const NANO_AIU_PER_AIU = 1_000_000_000;
const GEMINI_MODEL_NAME_PREFIX = 'models/';

const runtimeCatalog = Object.create(null);

function canonicalizeModel(model) {
  if (!model || typeof model !== 'string') return '';
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const withoutDateSuffix = bare.replace(/(-alpha)?-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  return withoutDateSuffix.replace(/[._]/g, '-').toLowerCase();
}

function normalizeModelId(entry, format) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.id || entry.name;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (format === 'gemini' && raw.startsWith(GEMINI_MODEL_NAME_PREFIX)) {
    return raw.slice(GEMINI_MODEL_NAME_PREFIX.length);
  }
  return raw;
}

function normalizePrice(value, batchSize, unit) {
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || !Number.isFinite(batchSize) || batchSize <= 0) return null;
  const aiu = unit === 'nano_aiu' ? numeric / NANO_AIU_PER_AIU : numeric;
  return aiu * DOLLARS_PER_AIU * (TOKENS_PER_MILLION / batchSize);
}

function normalizeTier(rawTier, batchSize, unit) {
  if (!rawTier || typeof rawTier !== 'object') return null;
  const input = normalizePrice(rawTier.input_price, batchSize, unit);
  const output = normalizePrice(rawTier.output_price, batchSize, unit);
  if (input === null || output === null) return null;
  const cachedInput = normalizePrice(
    rawTier.cache_read_price ?? rawTier.cache_price,
    batchSize,
    unit,
  );
  const cacheWrite = normalizePrice(rawTier.cache_write_price, batchSize, unit);
  const threshold = Number(rawTier.max_prompt_tokens ?? rawTier.context_max);
  return {
    input,
    cachedInput: cachedInput ?? input * 0.1,
    cacheWrite,
    output,
    ...(Number.isFinite(threshold) && threshold > 0 ? { threshold } : {}),
  };
}

function normalizeCopilotPricing(entry) {
  const tokenPrices = entry?.billing?.token_prices;
  if (!tokenPrices || typeof tokenPrices !== 'object') return null;
  const batchSize = Number(tokenPrices.batch_size);
  if (!Number.isFinite(batchSize) || batchSize <= 0) return null;

  let defaultTier;
  let longContext;
  if (tokenPrices.default && typeof tokenPrices.default === 'object') {
    defaultTier = normalizeTier(tokenPrices.default, batchSize, 'aiu');
    longContext = normalizeTier(tokenPrices.long_context, batchSize, 'aiu');
  } else {
    defaultTier = normalizeTier(tokenPrices, batchSize, 'nano_aiu');
  }
  if (!defaultTier) return null;

  const discountPercent = Number(entry?.billing?.promo?.discount_percent);
  return {
    default: defaultTier,
    ...(longContext ? { longContext } : {}),
    ...(Number.isFinite(discountPercent) && discountPercent >= 0 && discountPercent <= 100
      ? { discountPercent }
      : {}),
  };
}

/**
 * Normalize a provider model-list response without retaining the raw payload.
 */
function parseProviderModelMetadata(provider, json, options = {}) {
  if (!json || typeof json !== 'object') return null;
  const format = options.format || provider;
  const entries = Array.isArray(json.data)
    ? json.data
    : (Array.isArray(json.models) ? json.models : null);
  if (!entries) return null;

  const observedAt = options.observedAt || new Date().toISOString();
  const records = entries.map(entry => {
    const id = normalizeModelId(entry, format);
    if (!id) return null;
    const pricing = format === 'copilot' ? normalizeCopilotPricing(entry) : null;
    return {
      provider,
      id,
      source: 'provider',
      observedAt,
      ...(options.apiVersion ? { apiVersion: options.apiVersion } : {}),
      ...(entry.capabilities && typeof entry.capabilities === 'object'
        ? { capabilities: entry.capabilities }
        : {}),
      ...(pricing ? { pricing } : {}),
    };
  }).filter(Boolean);

  records.sort((a, b) => a.id.localeCompare(b.id));
  return records.length > 0 ? records : null;
}

function replaceRuntimeModels(provider, records) {
  if (!Array.isArray(records) || records.length === 0) return false;
  runtimeCatalog[provider] = records;
  return true;
}

function clearRuntimeModels() {
  for (const provider of Object.keys(runtimeCatalog)) delete runtimeCatalog[provider];
}

function getRuntimeModels(provider) {
  return runtimeCatalog[provider] || null;
}

function findRuntimeModel(provider, model) {
  const records = getRuntimeModels(provider);
  if (!records || !model) return null;
  const lower = model.toLowerCase();
  const exact = records.find(record => record.id.toLowerCase() === lower);
  if (exact) return exact;
  const canonical = canonicalizeModel(model);
  return records.find(record => canonicalizeModel(record.id) === canonical) || null;
}

function applyDiscount(pricing, discountPercent) {
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) return pricing;
  const multiplier = 1 - (discountPercent / 100);
  const discounted = value => Math.round(value * multiplier * 1e12) / 1e12;
  return {
    input: discounted(pricing.input),
    cachedInput: discounted(pricing.cachedInput),
    cacheWrite: pricing.cacheWrite === null ? null : discounted(pricing.cacheWrite),
    output: discounted(pricing.output),
  };
}

function resolveRuntimePricing(provider, model, inputTokens = 0) {
  const record = findRuntimeModel(provider, model);
  if (!record?.pricing?.default) return null;
  const longContext = record.pricing.longContext;
  const threshold = record.pricing.default.threshold;
  const useLongContext = !!longContext && !!threshold && inputTokens > threshold;
  const tier = useLongContext ? longContext : record.pricing.default;
  const discountPercent = record.pricing.discountPercent ?? 0;
  return {
    pricing: applyDiscount(tier, discountPercent),
    source: 'provider',
    tier: useLongContext ? 'long_context' : 'default',
    observedAt: record.observedAt,
    apiVersion: record.apiVersion,
    discountPercent,
  };
}

function getRuntimeCatalogSnapshot() {
  const snapshot = {};
  for (const [provider, records] of Object.entries(runtimeCatalog)) {
    snapshot[provider] = records.map(record => ({
      id: record.id,
      source: record.source,
      observed_at: record.observedAt,
      ...(record.apiVersion ? { api_version: record.apiVersion } : {}),
      ...(record.pricing ? {
        pricing: {
          default: record.pricing.default,
          ...(record.pricing.longContext ? { long_context: record.pricing.longContext } : {}),
          ...(record.pricing.discountPercent !== undefined
            ? { discount_percent: record.pricing.discountPercent }
            : {}),
        },
      } : {}),
    }));
  }
  return snapshot;
}

module.exports = {
  canonicalizeModel,
  parseProviderModelMetadata,
  replaceRuntimeModels,
  clearRuntimeModels,
  getRuntimeModels,
  findRuntimeModel,
  resolveRuntimePricing,
  getRuntimeCatalogSnapshot,
  testHelpers: {
    normalizeCopilotPricing,
  },
};
