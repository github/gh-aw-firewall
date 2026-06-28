/**
 * Model alias resolution for AWF API proxy.
 *
 * Resolves model aliases and fallbacks against a set of available models,
 * enabling transparent model name rewriting in the proxy without requiring
 * the agent to know which concrete model IDs are available.
 *
 * Config schema (passed via AWF_MODEL_ALIASES env var as JSON):
 * {
 *   "models": {
 *     "sonnet": ["copilot/*sonnet*", "anthropic/*sonnet*"],
 *     "gpt-5-codex": ["copilot/gpt-5*-codex", "openai/gpt-5*-codex"],
 *     "": ["sonnet", "gpt-5*-codex"]   // default policy (empty string key)
 *   }
 * }
 *
 * Model ref syntax: "providerid/modelid" where modelid supports * wildcards.
 * Resolution is recursive (aliases can reference other aliases), loop-detected,
 * case-insensitive, and sorted by semver semantics (highest version first).
 */

const { globMatch, extractVersionNumbers, compareByVersion } = require('./model-utils');
const {
  DEFAULT_MODEL_FALLBACK,
  normalizeFallbackConfig,
  resolveAliasDefinition,
  selectMiddlePowerFallback,
  tryMiddlePowerFallback,
} = require('./model-fallback');

/**
 * Check whether a model name is permitted by the given policy config.
 * This is an inline copy of the logic from model-policy-guard.js to avoid a
 * circular-dependency between the pure resolver and the guard module.
 *
 * @param {string} model
 * @param {{ allowedModels?: string[]|null, disallowedModels?: string[]|null }} policyConfig
 * @returns {boolean}
 */
function _isModelPermittedByPolicy(model, policyConfig) {
  if (!policyConfig) return true;
  const { allowedModels, disallowedModels } = policyConfig;
  if (!allowedModels && !disallowedModels) return true;
  if (!model) return true;
  if (disallowedModels && disallowedModels.some(p => globMatch(p, model))) return false;
  if (allowedModels && !allowedModels.some(p => globMatch(p, model))) return false;
  return true;
}

/**
 * Parse model aliases configuration from a raw JSON string.
 *
 * @param {string|null|undefined} rawConfig - JSON string from AWF_MODEL_ALIASES env var
 * @returns {{ models: Record<string, string[]> } | null} Parsed config or null if invalid/absent
 */
function parseModelAliases(rawConfig) {
  if (!rawConfig) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!parsed.models || typeof parsed.models !== 'object' || Array.isArray(parsed.models)) return null;

  // Validate structure: each value must be either:
  //   - string[] (legacy alias syntax)
  //   - { patterns: string[], fallback?: boolean } (extended alias syntax)
  for (const [, value] of Object.entries(parsed.models)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== 'string') return null;
      }
      continue;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Array.isArray(value.patterns)) return null;
    for (const entry of value.patterns) {
      if (typeof entry !== 'string') return null;
    }
    if (value.fallback !== undefined && typeof value.fallback !== 'boolean') return null;
  }

  return { models: parsed.models };
}

/**
 * Attempt to resolve a model that has no alias entry.
 *
 * Tries in order:
 *   1. Direct match — model name already in provider's available list.
 *   2. GPT-5 family version fallback — gpt-5.<minor> unavailable → highest gpt-5.x.
 *   3. Middle-power fallback.
 *
 * @param {string} key - Lowercased requested model name
 * @param {string} requestedModel - Original requested model name (for log messages)
 * @param {string} currentProvider
 * @param {Record<string, string[]|null>} availableModels
 * @param {{ enabled: boolean, strategy: string }} fallbackConfig
 * @param {string[]} log - Accumulator for resolution log messages (mutated in place)
 * @returns {{ resolvedModel: string, log: string[], fallback?: object } | null}
 */
function _resolveDirectMatch(key, requestedModel, currentProvider, availableModels, fallbackConfig, log, modelPolicyConfig) {
  const providerModels = (availableModels[currentProvider] || []);

  // 1. Direct match: model name already in the provider's available list
  const direct = providerModels.find(m => m.toLowerCase() === key);
  if (direct) {
    if (!_isModelPermittedByPolicy(direct, modelPolicyConfig)) {
      log.push(`[model-resolver] model policy blocked direct match: "${direct}"`);
      return null;
    }
    log.push(`[model-resolver] direct match: "${requestedModel}" → "${direct}"`);
    return {
      resolvedModel: direct,
      log,
      fallback: fallbackConfig.enabled
        ? { activated: false, selection_method: 'middle_power_median', reason: 'direct_match' }
        : undefined,
    };
  }

  // 2. GPT-5 family version fallback: gpt-5.<minor> not available → highest gpt-5.x
  const family = key.match(/^(gpt-5)\.\d+$/)?.[1];
  if (family) {
    const familyPrefix = `${family}.`;
    const familyCandidates = providerModels.filter(m => m.toLowerCase().startsWith(familyPrefix));
    const permittedCandidates = modelPolicyConfig
      ? familyCandidates.filter(c => _isModelPermittedByPolicy(c, modelPolicyConfig))
      : familyCandidates;
    if (permittedCandidates.length > 0) {
      const sorted = [...new Set(permittedCandidates)].sort(compareByVersion);
      const fallback = sorted[0];
      log.push(`[model-resolver] requested model "${requestedModel}" not available, falling back to "${fallback}"`);
      return {
        resolvedModel: fallback,
        log,
        fallback: fallbackConfig.enabled
          ? { activated: false, selection_method: 'middle_power_median', reason: 'family_version_fallback' }
          : undefined,
      };
    }
  }

  // 3. Middle-power fallback
  return tryMiddlePowerFallback(
    requestedModel, availableModels, currentProvider,
    'no_alias_match_and_not_in_available_models', fallbackConfig, log
  );
}

/**
 * Expand alias patterns for a resolved alias entry and pick the best candidate.
 *
 * For each pattern:
 *   - "provider/modelpattern" — glob-match against the current provider's available models.
 *   - "aliasname" (no slash) — recursively resolve as another alias reference.
 *
 * @param {string} aliasKey - The alias key that was matched (used in log messages)
 * @param {{ patterns: string[], fallback: boolean }} aliasDefinition
 * @param {string} requestedModel - Original requested model name (for log/fallback)
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases
 * @param {Record<string, string[]|null>} availableModels
 * @param {string} currentProvider
 * @param {string[]} newChain - Resolution chain with the current key already appended
 * @param {{ enabled: boolean, strategy: string }} fallbackConfig
 * @param {string[]} log - Accumulator for resolution log messages (mutated in place)
 * @param {{ allowedModels?: string[]|null, disallowedModels?: string[]|null }|null} [modelPolicyConfig]
 * @returns {{ resolvedModel: string, log: string[], fallback?: object } | null}
 */
function _resolveAliasPatterns(aliasKey, aliasDefinition, requestedModel, aliases, availableModels, currentProvider, newChain, fallbackConfig, log, modelPolicyConfig) {
  const patterns = aliasDefinition.patterns;
  log.push(`[model-resolver] alias: "${requestedModel}" → [${patterns.join(', ')}]`);

  const candidates = [];

  for (const pattern of patterns) {
    const slashIdx = pattern.indexOf('/');

    if (slashIdx === -1) {
      // Recursive alias reference (no provider prefix)
      const sub = resolveModel(pattern, aliases, availableModels, currentProvider, newChain, fallbackConfig, modelPolicyConfig);
      if (sub) {
        log.push(...sub.log);
        candidates.push(sub.resolvedModel);
      }
    } else {
      // "provider/modelpattern" ref — only match for the current provider
      const patternProvider = pattern.slice(0, slashIdx).toLowerCase();
      const modelPattern = pattern.slice(slashIdx + 1);

      if (patternProvider !== currentProvider.toLowerCase()) continue;

      const providerModels = (availableModels[currentProvider] || []);
      for (const model of providerModels) {
        if (globMatch(modelPattern, model)) {
          candidates.push(model);
        }
      }
    }
  }

  // Apply model policy filter: remove candidates that are not permitted.
  const filteredCandidates = modelPolicyConfig
    ? candidates.filter(c => _isModelPermittedByPolicy(c, modelPolicyConfig))
    : candidates;

  if (filteredCandidates.length < candidates.length) {
    const blocked = candidates.filter(c => !filteredCandidates.includes(c));
    log.push(`[model-resolver] model policy filtered out ${blocked.length} candidate(s): ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? ', …' : ''}`);
  }

  if (filteredCandidates.length === 0) {
    log.push(`[model-resolver] no candidates found for "${aliasKey}" on provider "${currentProvider}"`);
    const hasProviderPattern = patterns.some((pattern) => pattern.includes('/'));
    if (aliasDefinition.fallback && hasProviderPattern && !modelPolicyConfig) {
      return tryMiddlePowerFallback(
        requestedModel, availableModels, currentProvider,
        'no_alias_match_and_not_in_available_models', fallbackConfig, log
      );
    }
    return null;
  }

  // Deduplicate, sort by version (highest first), and pick the best
  const unique = [...new Set(filteredCandidates)];
  unique.sort(compareByVersion);

  const resolved = unique[0];
  log.push(
    `[model-resolver] resolved: "${requestedModel}" → "${resolved}"` +
    (unique.length > 1
      ? ` (${unique.length} candidates: ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? ', …' : ''})`
      : '')
  );

  return {
    resolvedModel: resolved,
    log,
    fallback: fallbackConfig.enabled
      ? { activated: false, selection_method: 'middle_power_median', reason: 'normal_resolution_succeeded' }
      : undefined,
  };
}

/**
 * Resolve a model name through the alias chain for a given provider.
 *
 * Resolution algorithm:
 * 1. Loop detection — bail out if key already visited.
 * 2. Alias lookup (case-insensitive); family alias fallback for gpt-5.<minor>.
 * 3. No alias found → _resolveDirectMatch (direct, family-version, or middle-power).
 * 4. Alias found → _resolveAliasPatterns (pattern expansion + best-candidate selection).
 *
 * @param {string} requestedModel - Model name from the request body (or "" for default)
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases - Alias map from parseModelAliases()
 * @param {Record<string, string[]|null>} availableModels - Cached provider models
 * @param {string} currentProvider - Provider handling this request (e.g. "copilot")
 * @param {string[]} [chain=[]] - Accumulates visited alias names for loop detection
 * @param {{ enabled?: boolean, strategy?: string }} [modelFallbackConfig]
 * @param {{ allowedModels?: string[]|null, disallowedModels?: string[]|null }|null} [modelPolicyConfig]
 * @returns {{ resolvedModel: string, log: string[], fallback?: object } | null}
 */
function resolveModel(requestedModel, aliases, availableModels, currentProvider, chain = [], modelFallbackConfig = DEFAULT_MODEL_FALLBACK, modelPolicyConfig = null) {
  const log = [];
  const key = requestedModel.toLowerCase();
  const fallbackConfig = normalizeFallbackConfig(modelFallbackConfig);

  // Loop detection
  if (chain.includes(key)) {
    log.push(`[model-resolver] loop detected: "${requestedModel}" already in chain [${chain.join(' → ')}]`);
    return null;
  }
  const newChain = [...chain, key];

  // Find alias entry (case-insensitive)
  let aliasEntry = Object.entries(aliases).find(([k]) => k.toLowerCase() === key);

  if (!aliasEntry) {
    // Family fallback: treat gpt-5.<minor> as gpt-5 when only the family alias
    // exists. This keeps versioned IDs like gpt-5.4 compatible with configs that
    // define "gpt-5" alias patterns.
    const familyAlias = key.match(/^(gpt-5)\.\d+(?:[._-].*)?$/)?.[1];
    if (familyAlias) {
      aliasEntry = Object.entries(aliases).find(([k]) => k.toLowerCase() === familyAlias);
      if (aliasEntry) {
        log.push(`[model-resolver] fallback alias: "${requestedModel}" → "${aliasEntry[0]}"`);
      }
    }
  }

  if (!aliasEntry) {
    return _resolveDirectMatch(key, requestedModel, currentProvider, availableModels, fallbackConfig, log, modelPolicyConfig);
  }

  const [aliasKey, aliasRaw] = aliasEntry;
  const aliasDefinition = resolveAliasDefinition(aliasRaw);
  return _resolveAliasPatterns(aliasKey, aliasDefinition, requestedModel, aliases, availableModels, currentProvider, newChain, fallbackConfig, log, modelPolicyConfig);
}

/**
 * Filter an alias map to only include aliases resolvable to at least one
 * available model for at least one provider that has model data.
 *
 * An alias is kept when:
 *   - No provider has model data yet (unknown state — keep all aliases).
 *   - The alias resolves to a concrete model for at least one provider with data.
 *
 * Middle-power fallback is intentionally disabled during filtering so that only
 * genuine alias→model matches are counted; fallback selections would keep aliases
 * alive even after all their target models have been retired.
 *
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases
 * @param {Record<string, string[]|null>} availableModels - Cached models per provider (null = not yet fetched)
 * @returns {Record<string, string[]|{patterns: string[], fallback?: boolean}>}
 */
function filterResolvableAliases(aliases, availableModels) {
  if (!aliases || typeof aliases !== 'object') return aliases;

  // Providers with a non-empty model list (data is available)
  const providersWithData = Object.entries(availableModels)
    .filter(([, models]) => Array.isArray(models) && models.length > 0)
    .map(([provider]) => provider);

  // No model data yet — cannot make decisions, keep all aliases
  if (providersWithData.length === 0) return aliases;

  const noFallback = { enabled: false };
  const result = {};

  for (const aliasKey of Object.keys(aliases)) {
    const canResolve = providersWithData.some(provider => {
      const resolution = resolveModel(aliasKey, aliases, availableModels, provider, [], noFallback);
      return resolution !== null;
    });

    if (canResolve) {
      result[aliasKey] = aliases[aliasKey];
    }
  }

  return result;
}

module.exports = {
  parseModelAliases,
  globMatch,
  extractVersionNumbers,
  compareByVersion,
  selectMiddlePowerFallback,
  filterResolvableAliases,
  resolveModel,
};
