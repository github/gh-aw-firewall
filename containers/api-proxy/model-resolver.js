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

const { getTierSortedModels } = require('./model-discovery');
const { globMatch, extractVersionNumbers, compareByVersion } = require('./model-utils');

const DEFAULT_MODEL_FALLBACK = Object.freeze({
  enabled: true,
  strategy: 'middle_power',
});

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

function normalizeFallbackConfig(modelFallbackConfig) {
  const config = modelFallbackConfig && typeof modelFallbackConfig === 'object'
    ? modelFallbackConfig
    : DEFAULT_MODEL_FALLBACK;
  return {
    enabled: config.enabled !== false,
    strategy: config.strategy || 'middle_power',
  };
}

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

function inferModelFamilyPrefix(requestedModel) {
  const key = String(requestedModel || '').toLowerCase();
  const gptFamily = key.match(/^(gpt-\d+(?:\.\d+)?)/)?.[1];
  if (gptFamily) return gptFamily;
  if (key.includes('claude')) return 'claude';
  if (key.includes('gemini')) return 'gemini';
  return null;
}

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

/**
 * Resolve a model name through the alias chain for a given provider.
 *
 * Resolution algorithm:
 * 1. Look up requestedModel in aliases (case-insensitive key match)
 * 2. For each entry in the alias list:
 *    a. If entry is "provider/pattern" — match against available models for that provider
 *       (only entries matching currentProvider are considered)
 *    b. If entry has no "/" — recursively resolve as another alias
 * 3. Collect all candidates, sort by version (highest first), return the best match
 *
 * @param {string} requestedModel - Model name from the request body (or "" for default)
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases - Alias map from parseModelAliases()
 * @param {Record<string, string[]|null>} availableModels - Cached provider models
 * @param {string} currentProvider - Provider handling this request (e.g. "copilot")
 * @param {string[]} [chain=[]] - Accumulates visited alias names for loop detection
 * @param {{ enabled?: boolean, strategy?: string }} [modelFallbackConfig]
 * @returns {{ resolvedModel: string, log: string[], fallback?: object } | null}
 */
function resolveModel(requestedModel, aliases, availableModels, currentProvider, chain = [], modelFallbackConfig = DEFAULT_MODEL_FALLBACK) {
  const log = [];
  const key = requestedModel.toLowerCase();
  const fallbackConfig = normalizeFallbackConfig(modelFallbackConfig);

  // ── Loop detection ────────────────────────────────────────────────────────
  if (chain.includes(key)) {
    log.push(`[model-resolver] loop detected: "${requestedModel}" already in chain [${chain.join(' → ')}]`);
    return null;
  }
  const newChain = [...chain, key];

  // ── Find alias entry (case-insensitive) ───────────────────────────────────
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
    // No alias defined — check if the model directly matches an available model for
    // this provider. If yes, pass it through as-is (no rewrite needed).
    const providerModels = (availableModels[currentProvider] || []);
    const direct = providerModels.find(m => m.toLowerCase() === key);
    if (direct) {
      log.push(`[model-resolver] direct match: "${requestedModel}" → "${direct}"`);
      return {
        resolvedModel: direct,
        log,
        fallback: fallbackConfig.enabled
          ? { activated: false, selection_method: 'middle_power_median', reason: 'direct_match' }
          : undefined,
      };
    }

    // If a gpt-5.<minor> model is requested but unavailable, fall back to the
    // highest available model in the same family for this provider.
    const family = key.match(/^(gpt-5)\.\d+$/)?.[1];
    if (family) {
      const familyPrefix = `${family}.`;
      const familyCandidates = providerModels.filter(m => m.toLowerCase().startsWith(familyPrefix));
      if (familyCandidates.length > 0) {
        const sorted = [...new Set(familyCandidates)].sort(compareByVersion);
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
    const fallbackResult = tryMiddlePowerFallback(
      requestedModel, availableModels, currentProvider,
      'no_alias_match_and_not_in_available_models', fallbackConfig, log
    );
    if (fallbackResult) return fallbackResult;
    // No match at all — cannot resolve.
    return null;
  }

  const [aliasKey, aliasRaw] = aliasEntry;
  const aliasDefinition = resolveAliasDefinition(aliasRaw);
  const patterns = aliasDefinition.patterns;
  log.push(`[model-resolver] alias: "${requestedModel}" → [${patterns.join(', ')}]`);

  // ── Expand each pattern ───────────────────────────────────────────────────
  const candidates = [];

  for (const pattern of patterns) {
    const slashIdx = pattern.indexOf('/');

    if (slashIdx === -1) {
      // Recursive alias reference (no provider prefix)
      const sub = resolveModel(pattern, aliases, availableModels, currentProvider, newChain, fallbackConfig);
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

  if (candidates.length === 0) {
    log.push(`[model-resolver] no candidates found for "${aliasKey}" on provider "${currentProvider}"`);
    const hasProviderPattern = patterns.some((pattern) => pattern.includes('/'));
    if (aliasDefinition.fallback && hasProviderPattern) {
      const fallbackResult = tryMiddlePowerFallback(
        requestedModel, availableModels, currentProvider,
        'no_alias_match_and_not_in_available_models', fallbackConfig, log
      );
      if (fallbackResult) return fallbackResult;
    }
    return null;
  }

  // ── Sort by version (highest first) and pick the best ────────────────────
  // Deduplicate while preserving sort order
  const unique = [...new Set(candidates)];
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
