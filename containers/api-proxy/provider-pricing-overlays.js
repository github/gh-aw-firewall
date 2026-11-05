'use strict';

const { selectPricingFact } = require('./catalogue-contract/pricing-resolution');
const exact = require('./catalogue-contract/exact-pricing');
const DOLLARS_PER_TOKEN_TO_DOLLARS_PER_MILLION = 1_000_000;

let cachedRaw;
let cachedProviders = null;

function canonicalizeModel(model) {
  if (!model || typeof model !== 'string') return '';
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  return bare.replace(/[._]/g, '-').toLowerCase();
}

function parseDollarsPerToken(value) {
  if (value === undefined) return null;
  return exact.multiply(exact.decimal(value), exact.decimal(DOLLARS_PER_TOKEN_TO_DOLLARS_PER_MILLION));
}

function normalizeCostRates(cost) {
  if (!cost || typeof cost !== 'object') return null;
  const input = parseDollarsPerToken(cost.input);
  const output = parseDollarsPerToken(cost.output);
  if (input === null || output === null) return null;
  const cachedInput = cost.cache_read === undefined
    ? exact.multiply(input, exact.decimal('0.1'))
    : parseDollarsPerToken(cost.cache_read);
  const cacheWrite = cost.cache_write === undefined
    ? null
    : parseDollarsPerToken(cost.cache_write);
  const reasoning = cost.reasoning === undefined
    ? undefined
    : parseDollarsPerToken(cost.reasoning);
  if (cachedInput === null ||
      (cost.cache_write !== undefined && cacheWrite === null) ||
      (cost.reasoning !== undefined && reasoning === null)) return null;
  return exact.fromExact({
    input,
    cachedInput,
    cacheWrite,
    output,
    ...(reasoning !== undefined ? { reasoning } : {}),
  });
}

function normalizeCost(cost) {
  const defaultTier = normalizeCostRates(cost);
  if (!defaultTier) return null;
  if (!Object.hasOwn(cost, 'long_context')) return { default: defaultTier };

  const rawLongContext = cost.long_context;
  if (!rawLongContext || typeof rawLongContext !== 'object' || Array.isArray(rawLongContext) ||
      ['input', 'cache_read', 'cache_write', 'output']
        .some(field => !Object.hasOwn(rawLongContext, field))) {
    return null;
  }
  const longContext = normalizeCostRates(rawLongContext);
  const threshold = rawLongContext.max_prompt_tokens;
  if (!longContext || !Number.isFinite(threshold) || threshold <= 0) return null;
  longContext.threshold = threshold;
  return { default: defaultTier, longContext };
}

function getProviderAliases(provider) {
  if (provider === 'copilot') return ['copilot', 'github-copilot', 'github'];
  if (provider === 'gemini') return ['gemini', 'google'];
  return [provider];
}

function getProviders() {
  const raw = process.env.AWF_API_PROXY_PROVIDERS;
  if (raw === cachedRaw) return cachedProviders;
  cachedRaw = raw;
  cachedProviders = null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cachedProviders = parsed;
    }
  } catch {
    cachedProviders = null;
  }
  return cachedProviders;
}

function getProviderPricingFact(provider, model) {
  const providers = getProviders();
  if (!providers || !provider || !model) return null;
  let models = null;
  for (const alias of getProviderAliases(provider)) {
    const candidate = providers[alias]?.models;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      models = candidate;
      break;
    }
  }
  if (!models) return null;

  const canonical = canonicalizeModel(model);
  let match = null;
  for (const [configuredModel, entry] of Object.entries(models)) {
    const configuredCanonical = canonicalizeModel(configuredModel);
    if (configuredCanonical === canonical ||
        (canonical.startsWith(`${configuredCanonical}-`) &&
          (!match || configuredCanonical.length > match.canonical.length))) {
      match = { canonical: configuredCanonical, entry };
      if (configuredCanonical === canonical) break;
    }
  }
  const normalized = normalizeCost(match?.entry?.cost);
  if (!normalized) return null;
  return {
    source: 'operator', ...normalized, threshold: normalized.longContext?.threshold,
  };
}

function resolveProviderPricingOverlay(provider, model, inputTokens = 0) {
  return selectPricingFact(getProviderPricingFact(provider, model), inputTokens);
}

function resetProviderPricingOverlaysForTests() {
  cachedRaw = undefined;
  cachedProviders = null;
}

module.exports = {
  getProviderPricingModelIds: provider => {
    const providers = getProviders();
    for (const alias of getProviderAliases(provider)) {
      const models = providers?.[alias]?.models;
      if (models && typeof models === 'object' && !Array.isArray(models)) return Object.keys(models);
    }
    return [];
  },
  getProviderAliases,
  getProviderPricingFact,
  resolveProviderPricingOverlay,
  resetProviderPricingOverlaysForTests,
};
