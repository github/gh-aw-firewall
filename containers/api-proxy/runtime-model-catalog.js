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
    output,
    ...(cachedInput !== null ? { cachedInput } : {}),
    ...(cacheWrite !== null ? { cacheWrite } : {}),
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

  return {
    default: defaultTier,
    ...(longContext ? { longContext } : {}),
  };
}

function normalizePromotion(entry) {
  const promo = entry?.billing?.promo;
  const discountPercent = Number(promo?.discount_percent);
  if (!promo || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    return null;
  }
  return {
    discountPercent,
    ...(typeof promo.id === 'string' ? { id: promo.id } : {}),
    ...(typeof promo.ends_at === 'string' ? { endsAt: promo.ends_at } : {}),
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
    const promotion = format === 'copilot' ? normalizePromotion(entry) : null;
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
      ...(promotion ? { promotion } : {}),
    };
  }).filter(Boolean);

  records.sort((a, b) => a.id.localeCompare(b.id));
  return records.length > 0 ? records : null;
}

function replaceRuntimeModels(provider, records) {
  if (!Array.isArray(records) || records.length === 0) return false;
  const previousById = new Map(
    (runtimeCatalog[provider] || []).map(record => [canonicalizeModel(record.id), record]),
  );
  runtimeCatalog[provider] = records.map(record => {
    const previous = previousById.get(canonicalizeModel(record.id));
    if (!previous?.pricing) return record;
    const defaultTier = chooseTier(record.pricing?.default, previous.pricing.default);
    const longContext = chooseTier(record.pricing?.longContext, previous.pricing.longContext);
    const pricingProvenance = {
      default: getTierProvenance(
        defaultTier === previous.pricing.default ? previous : record,
        'default',
      ),
      ...(longContext ? {
        longContext: getTierProvenance(
          longContext === previous.pricing.longContext ? previous : record,
          'longContext',
        ),
      } : {}),
    };
    return {
      ...record,
      pricing: {
        default: defaultTier,
        ...(longContext ? { longContext } : {}),
      },
      pricingProvenance,
    };
  });
  return true;
}

function getTierProvenance(record, tierName) {
  return record.pricingProvenance?.[tierName] || {
    observedAt: record.pricingObservedAt || record.observedAt,
    ...(record.pricingApiVersion || record.apiVersion
      ? { apiVersion: record.pricingApiVersion || record.apiVersion }
      : {}),
  };
}

function chooseTier(current, previous) {
  if (isCompleteTier(current)) return current;
  if (isCompleteTier(previous)) return previous;
  return current || previous;
}

function isCompleteTier(tier) {
  return !!tier &&
    Object.hasOwn(tier, 'input') &&
    Object.hasOwn(tier, 'output') &&
    Object.hasOwn(tier, 'cachedInput') &&
    Object.hasOwn(tier, 'cacheWrite');
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

function resolveRuntimePricing(provider, model, inputTokens = 0) {
  const record = findRuntimeModel(provider, model);
  if (!record?.pricing?.default) return null;
  const longContext = record.pricing.longContext;
  const threshold = record.pricing.default.threshold;
  const useLongContext = !!longContext && !!threshold && inputTokens > threshold;
  const tier = useLongContext ? longContext : record.pricing.default;
  const tierName = useLongContext ? 'longContext' : 'default';
  const provenance = getTierProvenance(record, tierName);
  return {
    pricing: tier,
    source: 'provider',
    tier: useLongContext ? 'long_context' : 'default',
    observedAt: provenance.observedAt,
    apiVersion: provenance.apiVersion,
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
        },
      } : {}),
      ...(record.promotion ? {
        promotion: {
          discount_percent: record.promotion.discountPercent,
          ...(record.promotion.id ? { id: record.promotion.id } : {}),
          ...(record.promotion.endsAt ? { ends_at: record.promotion.endsAt } : {}),
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
