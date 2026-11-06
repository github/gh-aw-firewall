'use strict';

const { selectPricingFact } = require('./catalogue-contract/pricing-resolution');
const exact = require('./catalogue-contract/exact-pricing');
const NANO_AIU_PER_AIU = 1_000_000_000;
const GEMINI_MODEL_NAME_PREFIX = 'models/';

const runtimeCatalog = Object.create(null);
const captureTimes = new WeakMap();

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
  const numeric = exact.decimal(value);
  const aiu = unit === 'nano_aiu' ? exact.divide(numeric, exact.decimal(NANO_AIU_PER_AIU)) : numeric;
  return exact.divide(exact.multiply(aiu, exact.decimal(10000)), exact.decimal(batchSize));
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
  return exact.fromExact({
    input,
    output,
    ...(cachedInput !== null ? { cachedInput } : {}),
    ...(cacheWrite !== null ? { cacheWrite } : {}),
    ...(Number.isFinite(threshold) && threshold > 0 ? { threshold } : {}),
  });
}

function normalizeCopilotPricing(entry) {
  const tokenPrices = entry?.billing?.token_prices;
  if (!tokenPrices || typeof tokenPrices !== 'object') return null;
  const batchSize = tokenPrices.batch_size;
  if (batchSize === undefined || batchSize === null) return null;
  if (exact.compare(exact.decimal(batchSize), exact.ZERO) <= 0) throw new Error('pricing_decimal_invalid_batch');

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
    let pricing;
    let pricingError = false;
    try {
      pricing = format === 'copilot' ? normalizeCopilotPricing(entry) : null;
    } catch {
      // Discovery catches fetch failures. Retain an invalid tariff as a fact so
      // accounting cannot silently reuse old/lower-priority/free pricing.
      pricingError = true;
    }
    const promotion = format === 'copilot' ? normalizePromotion(entry) : null;
    const displayName = entry.display_name || entry.displayName || (entry.id ? entry.name : null);
    return {
      provider,
      id,
      ...(typeof displayName === 'string' && displayName.length > 0 ? { displayName } : {}),
      source: 'provider',
      observedAt,
      ...(options.apiVersion ? { apiVersion: options.apiVersion } : {}),
      ...(entry.capabilities && typeof entry.capabilities === 'object'
        ? { capabilities: entry.capabilities }
        : {}),
      ...(Array.isArray(entry.supportedReasoningEfforts)
        ? { supportedReasoningEfforts: [...entry.supportedReasoningEfforts] }
        : {}),
      ...(Array.isArray(entry.supported_endpoints)
        ? { supportedEndpoints: [...entry.supported_endpoints] }
        : {}),
      ...(typeof entry.model_picker_enabled === 'boolean'
        ? { modelPickerEnabled: entry.model_picker_enabled }
        : {}),
      ...(pricing ? { pricing } : {}),
      ...(pricingError ? { pricingError: true } : {}),
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
    if (record.pricingError || !previous?.pricing) return record;
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

function getWireApi(record) {
  if (!Array.isArray(record.supportedEndpoints) || record.supportedEndpoints.length !== 1) return undefined;
  if (record.supportedEndpoints[0] === '/responses') return 'responses';
  if (record.supportedEndpoints[0] === '/chat/completions') return 'completions';
  return undefined;
}

function getWireApiReflectFields(record) {
  const wireApi = getWireApi(record);
  return wireApi ? { wire_api: wireApi } : {};
}

function findRuntimeModel(provider, model, catalog = runtimeCatalog) {
  const records = catalog[provider];
  if (!records || !model) return null;
  const lower = model.toLowerCase();
  const exact = records.find(record => record.id.toLowerCase() === lower);
  if (exact) return exact;
  const canonical = canonicalizeModel(model);
  return records.find(record => canonicalizeModel(record.id) === canonical) || null;
}

function getRuntimePricingFact(provider, model, catalog = runtimeCatalog) {
  const record = findRuntimeModel(provider, model, catalog);
  if (record?.pricingError) throw new Error('pricing_resolution_invalid_tariff');
  if (!record?.pricing?.default) return null;
  const longContext = record.pricing.longContext;
  const threshold = record.pricing.default.threshold;
  return {
    source: 'provider', ...record.pricing, threshold: threshold || undefined,
    defaultMetadata: getTierProvenance(record, 'default'),
    longMetadata: longContext ? getTierProvenance(record, 'longContext') : undefined,
  };
}

function resolveRuntimePricing(provider, model, inputTokens = 0, catalog = runtimeCatalog) {
  return selectPricingFact(getRuntimePricingFact(provider, model, catalog), inputTokens);
}

function getRuntimeCatalogSnapshot() {
  const snapshot = {};
  for (const [provider, records] of Object.entries(runtimeCatalog)) {
    snapshot[provider] = records.map(record => ({
      id: record.id,
      source: record.source,
      observed_at: record.observedAt,
      ...(record.apiVersion ? { api_version: record.apiVersion } : {}),
      ...(record.pricingError ? { pricing_error: 'pricing_resolution_error' } : {}),
      ...getWireApiReflectFields(record),
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
  getRuntimePricingFact,
  canonicalizeModel,
  parseProviderModelMetadata,
  replaceRuntimeModels,
  clearRuntimeModels,
  getRuntimeModels,
  findRuntimeModel,
  resolveRuntimePricing,
  getRuntimePricingCaptureTime: (catalog, provider) =>
    captureTimes.get(catalog[provider]) ?? captureTimes.get(catalog) ?? Date.now(),
  captureRuntimePricing: () => {
    const snapshot = Object.fromEntries(Object.entries(runtimeCatalog).map(([provider, records]) =>
      [provider, records.map(record => ({
        ...structuredClone(record),
        ...(record.pricing ? { pricing: Object.fromEntries(Object.entries(record.pricing).map(([tier, prices]) =>
          [tier, exact.rates(prices)])) } : {}),
      }))]));
    const time = Date.now();
    captureTimes.set(snapshot, time);
    // Request routing merges backend captures while retaining their record arrays.
    for (const records of Object.values(snapshot)) captureTimes.set(records, time);
    return snapshot;
  },
  getRuntimeCatalogSnapshot,
  testHelpers: {
    normalizeCopilotPricing,
  },
};
