/**
 * Model fallback selection logic for AWF API proxy.
 *
 * Provides the heuristic for selecting a lower-cost fallback model when
 * the requested model is unavailable. Extracted from model-resolver.js
 * for independent testability.
 */

const { getTierSortedModels } = require('./model-discovery');

const DEFAULT_MODEL_FALLBACK = Object.freeze({
  enabled: true,
  strategy: 'middle_power',
});

/**
 * Normalize raw fallback config into a consistent shape.
 * @param {object|null|undefined} modelFallbackConfig
 * @returns {{ enabled: boolean, strategy: string }}
 */
function normalizeFallbackConfig(modelFallbackConfig) {
  const config = modelFallbackConfig && typeof modelFallbackConfig === 'object'
    ? modelFallbackConfig
    : DEFAULT_MODEL_FALLBACK;
  return {
    enabled: config.enabled !== false,
    strategy: config.strategy || 'middle_power',
  };
}

/**
 * Normalize a raw alias definition into { patterns, fallback } shape.
 * @param {string[]|object} rawAlias
 * @returns {{ patterns: string[], fallback: boolean }}
 */
function resolveAliasDefinition(rawAlias) {
  if (Array.isArray(rawAlias)) {
    return { patterns: rawAlias, fallback: true };
  }
  if (!rawAlias || typeof rawAlias !== 'object' || Array.isArray(rawAlias)) {
    return { patterns: [], fallback: true };
  }
  return {
    patterns: Array.isArray(rawAlias.patterns) ? rawAlias.patterns : [],
    fallback: rawAlias.fallback !== false,
  };
}

/**
 * Infer the model family prefix from a requested model name.
 * @param {string} requestedModel
 * @returns {string|null}
 */
function inferModelFamilyPrefix(requestedModel) {
  const key = String(requestedModel || '').toLowerCase();
  const gptFamily = key.match(/^(gpt-\d+(?:\.\d+)?)/)?.[1];
  if (gptFamily) return gptFamily;
  if (key.includes('claude')) return 'claude';
  if (key.includes('gemini')) return 'gemini';
  return null;
}

/**
 * Select a middle-power fallback model from the provider's available models.
 *
 * @param {string} requestedModel - The original requested model name
 * @param {Record<string, string[]|null>} availableModels - Models per provider
 * @param {string} currentProvider - The target provider
 * @param {string} reason - Why fallback was triggered
 * @param {object} modelFallbackConfig - Raw fallback config
 * @returns {{ resolvedModel: string, fallback: object } | null}
 */
function selectMiddlePowerFallback(requestedModel, availableModels, currentProvider, reason, modelFallbackConfig) {
  const fallbackConfig = normalizeFallbackConfig(modelFallbackConfig);
  if (!fallbackConfig.enabled || fallbackConfig.strategy !== 'middle_power') return null;

  const providerModels = Array.isArray(availableModels[currentProvider]) ? availableModels[currentProvider] : [];
  if (providerModels.length === 0) return null;

  const familyPrefix = inferModelFamilyPrefix(requestedModel);
  const familyCandidates = familyPrefix
    ? providerModels.filter(model => model.toLowerCase().startsWith(familyPrefix))
    : [];
  const selectedPool = familyCandidates.length > 0 ? familyCandidates : providerModels;
  const sortedCandidates = getTierSortedModels(currentProvider, selectedPool);
  if (sortedCandidates.length === 0) return null;

  const medianIndex = Math.floor((sortedCandidates.length - 1) / 2);
  return {
    resolvedModel: sortedCandidates[medianIndex].model,
    fallback: {
      activated: true,
      reason,
      selection_method: 'middle_power_median',
      available_models_count: providerModels.length,
      used_family_filter: familyCandidates.length > 0,
      candidates: sortedCandidates,
    },
  };
}

/**
 * Attempts middle-power fallback and returns a resolution result if successful.
 * Encapsulates the repeated call + log + return pattern used in two places.
 *
 * @param {string} requestedModel
 * @param {Record<string, string[]|null>} availableModels
 * @param {string} currentProvider
 * @param {string} reason
 * @param {object} fallbackConfig
 * @param {string[]} log - Accumulator for resolution log messages (mutated in place)
 * @returns {{ resolvedModel: string, log: string[], fallback: object } | null}
 */
function tryMiddlePowerFallback(requestedModel, availableModels, currentProvider, reason, fallbackConfig, log) {
  const middlePowerFallback = selectMiddlePowerFallback(
    requestedModel, availableModels, currentProvider, reason, fallbackConfig
  );
  if (middlePowerFallback) {
    log.push(`[model-resolver] middle-power fallback: "${requestedModel}" → "${middlePowerFallback.resolvedModel}"`);
    return { resolvedModel: middlePowerFallback.resolvedModel, log, fallback: middlePowerFallback.fallback };
  }
  return null;
}

module.exports = {
  DEFAULT_MODEL_FALLBACK,
  normalizeFallbackConfig,
  resolveAliasDefinition,
  inferModelFamilyPrefix,
  selectMiddlePowerFallback,
  tryMiddlePowerFallback,
};
