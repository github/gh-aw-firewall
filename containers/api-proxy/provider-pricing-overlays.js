'use strict';

const DOLLARS_PER_TOKEN_TO_DOLLARS_PER_MILLION = 1_000_000;

let cachedRaw;
let cachedProviders = null;

function canonicalizeModel(model) {
  if (!model || typeof model !== 'string') return '';
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  return bare.replace(/[._]/g, '-').toLowerCase();
}

function parseDollarsPerToken(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed * DOLLARS_PER_TOKEN_TO_DOLLARS_PER_MILLION;
}

function normalizeCostRates(cost) {
  if (!cost || typeof cost !== 'object') return null;
  const input = parseDollarsPerToken(cost.input);
  const output = parseDollarsPerToken(cost.output);
  if (input === null || output === null) return null;
  const cachedInput = cost.cache_read === undefined
    ? input * 0.1
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
  return {
    input,
    cachedInput,
    cacheWrite,
    output,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
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
  return { default: defaultTier, longContext: { ...longContext, threshold } };
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

function resolveProviderPricingOverlay(provider, model, inputTokens = 0) {
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
  const useLongContext = !!normalized.longContext &&
    inputTokens > normalized.longContext.threshold;
  const pricing = useLongContext ? normalized.longContext : normalized.default;
  return {
    pricing,
    source: 'operator',
    tier: useLongContext ? 'long_context' : 'default',
  };
}

function resetProviderPricingOverlaysForTests() {
  cachedRaw = undefined;
  cachedProviders = null;
}

module.exports = {
  getProviderAliases,
  resolveProviderPricingOverlay,
  resetProviderPricingOverlaysForTests,
};
