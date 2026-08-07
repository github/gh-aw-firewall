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
  // Candidates produced by a nested alias's middle-power fallback are synthesized
  // guesses, not genuine pattern matches. They are kept separate so they can never
  // out-rank a sibling pattern that actually matched a model.
  const synthesizedCandidates = [];

  for (const pattern of patterns) {
    const slashIdx = pattern.indexOf('/');

    if (slashIdx === -1) {
      // Recursive alias reference (no provider prefix)
      const sub = resolveModel(
        pattern,
        aliases,
        availableModels,
        currentProvider,
        newChain,
        fallbackConfig,
        modelPolicyConfig,
        false
      );
      if (sub) {
        log.push(...sub.log);
        if (sub.fallback && sub.fallback.activated) {
          synthesizedCandidates.push(sub.resolvedModel);
        } else {
          candidates.push(sub.resolvedModel);
        }
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

  // Prefer genuine pattern matches. Synthesized fallback picks from nested
  // aliases are only considered when no sibling pattern matched anything.
  const effectiveCandidates = candidates.length > 0 ? candidates : synthesizedCandidates;
  if (candidates.length > 0 && synthesizedCandidates.length > 0) {
    log.push(
      `[model-resolver] ignoring ${synthesizedCandidates.length} synthesized fallback candidate(s) ` +
      `in favour of ${candidates.length} genuine match(es)`
    );
  }

  // Apply model policy filter: remove candidates that are not permitted.
  const filteredCandidates = modelPolicyConfig
    ? effectiveCandidates.filter(c => _isModelPermittedByPolicy(c, modelPolicyConfig))
    : effectiveCandidates;

  if (filteredCandidates.length < effectiveCandidates.length) {
    const blocked = effectiveCandidates.filter(c => !filteredCandidates.includes(c));
    log.push(`[model-resolver] model policy filtered out ${blocked.length} candidate(s): ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? ', …' : ''}`);
  }

  if (filteredCandidates.length === 0) {
    log.push(`[model-resolver] no candidates found for "${aliasKey}" on provider "${currentProvider}"`);
    const hasProviderPattern = patterns.some((pattern) => pattern.includes('/'));
    // Only fall back when this alias actually names the current provider. An alias
    // whose patterns target *other* providers (e.g. "haiku" → copilot/*, anthropic/*
    // evaluated on an openai proxy) has a legitimately empty candidate set.
    //
    // This is enforced only for *nested* alias references, where sibling patterns in
    // the parent fan-out can still supply a genuine match. A top-level request keeps
    // the existing graceful-degradation behaviour of substituting something rather
    // than failing outright.
    const isNestedReference = newChain.length > 1;
    const targetsCurrentProvider = patterns.some((pattern) => {
      const slashIdx = pattern.indexOf('/');
      return slashIdx !== -1 &&
        pattern.slice(0, slashIdx).toLowerCase() === currentProvider.toLowerCase();
    });
    const fallbackAllowed = !isNestedReference || targetsCurrentProvider;
    if (aliasDefinition.fallback && fallbackAllowed && hasProviderPattern && !modelPolicyConfig) {
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
  const resolvedViaSynthesis = candidates.length === 0 && synthesizedCandidates.length > 0;
  log.push(
    `[model-resolver] resolved: "${requestedModel}" → "${resolved}"` +
    (unique.length > 1
      ? ` (${unique.length} candidates: ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? ', …' : ''})`
      : '')
  );

  return {
    resolvedModel: resolved,
    candidates: unique,
    log,
    fallback: fallbackConfig.enabled
      ? {
        activated: resolvedViaSynthesis,
        selection_method: 'middle_power_median',
        reason: resolvedViaSynthesis
          ? 'no_alias_match_and_not_in_available_models'
          : 'normal_resolution_succeeded',
      }
      : undefined,
  };
}

/**
 * Resolve a model name through the alias chain for a given provider.
 *
 * Resolution algorithm:
 * 1. Loop detection — bail out if key already visited.
 * 2. Direct match — preserve an explicitly available provider model.
 * 3. Alias lookup (case-insensitive); family alias fallback for gpt-5.<minor>.
 * 4. No alias found → _resolveDirectMatch (family-version or middle-power fallback).
 * 5. Alias found → _resolveAliasPatterns (pattern expansion + best-candidate selection).
 *
 * @param {string} requestedModel - Model name from the request body (or "" for default)
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases - Alias map from parseModelAliases()
 * @param {Record<string, string[]|null>} availableModels - Cached provider models
 * @param {string} currentProvider - Provider handling this request (e.g. "copilot")
 * @param {string[]} [chain=[]] - Accumulates visited alias names for loop detection
 * @param {{ enabled?: boolean, strategy?: string }} [modelFallbackConfig]
 * @param {{ allowedModels?: string[]|null, disallowedModels?: string[]|null }|null} [modelPolicyConfig]
 * @param {boolean} [preferDirectRequest=true] - Prefer an exact provider model over a same-named alias for top-level requests
 * @returns {{ resolvedModel: string, candidates: string[], log: string[], fallback?: object } | null}
 */
function resolveModel(
  requestedModel,
  aliases,
  availableModels,
  currentProvider,
  chain = [],
  modelFallbackConfig = DEFAULT_MODEL_FALLBACK,
  modelPolicyConfig = null,
  preferDirectRequest = true
) {
  const log = [];
  const key = requestedModel.toLowerCase();
  const fallbackConfig = normalizeFallbackConfig(modelFallbackConfig);

  if (currentProvider === 'copilot' && key === 'auto') {
    log.push('[model-resolver] special pass-through: "auto"');
    return {
      resolvedModel: requestedModel,
      candidates: [requestedModel],
      log,
      fallback: fallbackConfig.enabled
        ? { activated: false, selection_method: 'middle_power_median', reason: 'direct_match' }
        : undefined,
    };
  }

  // Loop detection
  if (chain.includes(key)) {
    log.push(`[model-resolver] loop detected: "${requestedModel}" already in chain [${chain.join(' → ')}]`);
    return null;
  }
  const newChain = [...chain, key];

  // An explicit model available from this provider is authoritative over any
  // matching alias. This prevents an alias with the same name from silently
  // steering a request away from the configured provider.
  if (preferDirectRequest) {
    const providerModels = (availableModels[currentProvider] || []);
    const direct = providerModels.find(m => m.toLowerCase() === key);
    if (direct) {
      if (!_isModelPermittedByPolicy(direct, modelPolicyConfig)) {
        log.push(`[model-resolver] model policy blocked direct match: "${direct}"`);
        return null;
      }
      log.push(`[model-resolver] direct match: "${requestedModel}" → "${direct}"`);
      return {
        resolvedModel: direct,
        candidates: [direct],
        log,
        fallback: fallbackConfig.enabled
          ? { activated: false, selection_method: 'middle_power_median', reason: 'direct_match' }
          : undefined,
      };
    }
  }

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
 *   - No provider has model data yet and its patterns can target a configured
 *     provider (or configured providers are unknown).
 *   - The alias resolves to a concrete model for at least one provider with data.
 *
 * Middle-power fallback is intentionally disabled during filtering so that only
 * genuine alias→model matches are counted; fallback selections would keep aliases
 * alive even after all their target models have been retired.
 *
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases
 * @param {Record<string, string[]|null>} availableModels - Cached models per provider (null = not yet fetched)
 * @param {Set<string>|string[]|null|undefined} [configuredProviders] - Provider cache keys that are configured
 * @returns {Record<string, string[]|{patterns: string[], fallback?: boolean}>}
 */
function filterResolvableAliases(aliases, availableModels, configuredProviders) {
  if (!aliases || typeof aliases !== 'object') return aliases;
  const configured = configuredProviders === null || configuredProviders === undefined
    ? null
    : (configuredProviders instanceof Set
      ? configuredProviders
      : new Set(Array.isArray(configuredProviders) ? configuredProviders : []));

  // Providers with a non-empty model list (data is available)
  const providersWithData = Object.entries(availableModels)
    .filter(([, models]) => Array.isArray(models) && models.length > 0)
    .map(([provider]) => provider);

  if (providersWithData.length === 0) {
    if (configured === null) return aliases;
    const result = {};
    for (const aliasKey of Object.keys(aliases)) {
      if (_aliasCanTargetConfiguredProvider(aliasKey, aliases, configured)) {
        result[aliasKey] = aliases[aliasKey];
      }
    }
    return result;
  }

  const noFallback = { enabled: false };
  const result = {};
  const configuredProvidersWithoutData = configured === null
    ? new Set()
    : new Set([...configured].filter(provider => !Array.isArray(availableModels[provider])));

  for (const aliasKey of Object.keys(aliases)) {
    const canResolveWithKnownModels = providersWithData.some(provider => {
      const resolution = resolveModel(aliasKey, aliases, availableModels, provider, [], noFallback, null, false);
      return resolution !== null;
    });
    const mayResolveWhenPendingCatalogLoads = _aliasCanTargetConfiguredProvider(
      aliasKey,
      aliases,
      configuredProvidersWithoutData,
    );

    if (canResolveWithKnownModels || mayResolveWhenPendingCatalogLoads) {
      result[aliasKey] = aliases[aliasKey];
    }
  }

  return result;
}

/**
 * Conservatively determine whether an alias can target any configured provider
 * before provider model catalogues are available.
 *
 * @param {string} aliasKey
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases
 * @param {Set<string>} configuredProviders
 * @param {Set<string>} [chain]
 * @returns {boolean}
 */
function _aliasCanTargetConfiguredProvider(aliasKey, aliases, configuredProviders, chain = new Set()) {
  const normalizedKey = aliasKey.toLowerCase();
  if (chain.has(normalizedKey)) return false;

  const aliasEntry = Object.entries(aliases).find(([key]) => key.toLowerCase() === normalizedKey);
  if (!aliasEntry) return configuredProviders.size > 0;

  const nextChain = new Set(chain);
  nextChain.add(normalizedKey);
  const { patterns } = resolveAliasDefinition(aliasEntry[1]);
  return patterns.some((pattern) => {
    const slashIdx = pattern.indexOf('/');
    if (slashIdx !== -1) {
      return configuredProviders.has(pattern.slice(0, slashIdx).toLowerCase());
    }
    return _aliasCanTargetConfiguredProvider(pattern, aliases, configuredProviders, nextChain);
  });
}

/**
 * Restrict a provider→models map to the providers that are actually configured
 * for this run.
 *
 * Alias resolution treats any provider with a populated model list as a valid
 * steering target. When a provider slot has no credentials (the proxy reports
 * `configured: false` for it and answers every request with
 * `provider_not_configured`), steering a request there guarantees a 100% failure
 * rate. Blanking those providers' model lists before resolution makes them
 * invisible to the alias table, so candidates are only ever drawn from provider
 * slots that can actually serve a request.
 *
 * When `configuredProviders` is null/undefined, the map is returned unchanged
 * because configuration is unknown. An empty set is a known state and blanks
 * every provider.
 *
 * @param {Record<string, string[]|null>} availableModels
 * @param {Set<string>|string[]|null|undefined} configuredProviders - Provider cache keys that are configured
 * @returns {Record<string, string[]|null>}
 */
function filterAvailableModelsToConfiguredProviders(availableModels, configuredProviders) {
  if (!availableModels || typeof availableModels !== 'object') return availableModels;
  if (configuredProviders === null || configuredProviders === undefined) return availableModels;

  const configured = configuredProviders instanceof Set
    ? configuredProviders
    : new Set(Array.isArray(configuredProviders) ? configuredProviders : []);

  const result = {};
  for (const [provider, models] of Object.entries(availableModels)) {
    result[provider] = configured.has(provider) ? models : null;
  }
  return result;
}

module.exports = {
  parseModelAliases,
  filterAvailableModelsToConfiguredProviders,
  globMatch,
  extractVersionNumbers,
  compareByVersion,
  selectMiddlePowerFallback,
  filterResolvableAliases,
  resolveModel,
};
