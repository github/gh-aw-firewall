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
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed * DOLLARS_PER_TOKEN_TO_DOLLARS_PER_MILLION;
}

function normalizeCost(cost) {
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
  if (cachedInput === null || (cost.cache_write !== undefined && cacheWrite === null)) return null;
  return { input, cachedInput, cacheWrite, output };
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

function resolveProviderPricingOverlay(provider, model) {
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
  const pricing = normalizeCost(match?.entry?.cost);
  return pricing ? { pricing, source: 'operator', tier: 'default' } : null;
}

function resetProviderPricingOverlaysForTests() {
  cachedRaw = undefined;
  cachedProviders = null;
}

module.exports = {
  resolveProviderPricingOverlay,
  resetProviderPricingOverlaysForTests,
};
