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

const { globMatch, extractVersionNumbers, compareByVersion, stripRedundantProviderPrefix } = require('./model-utils');
const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const { resolveModelIdentity, findAvailableModel } = require('./model-identity');
const { getModelEligibilityScope, evaluateModelEligibility, isModelHarnessEligible } = require('./model-eligibility');
const {
  DEFAULT_MODEL_FALLBACK,
  normalizeFallbackConfig,
  resolveAliasDefinition,
  selectMiddlePowerFallback,
  tryMiddlePowerFallback,
} = require('./model-fallback');

function splitModelParameters(model) {
  if (typeof model !== 'string') return { baseModel: model, parameterSuffix: '' };
  const queryIndex = model.indexOf('?');
  if (queryIndex === -1) return { baseModel: model, parameterSuffix: '' };
  return {
    baseModel: model.slice(0, queryIndex),
    parameterSuffix: model.slice(queryIndex),
  };
}

function appendModelParameters(model, parameterSuffix) {
  if (!parameterSuffix || typeof model !== 'string' || model.includes('?')) return model;
  return `${model}${parameterSuffix}`;
}

function applyModelParametersToResolution(resolution, parameterSuffix) {
  if (!resolution || !parameterSuffix) return resolution;
  return {
    ...resolution,
    resolvedModel: appendModelParameters(resolution.resolvedModel, parameterSuffix),
    ...(Array.isArray(resolution.candidates)
      ? { candidates: resolution.candidates.map(candidate => appendModelParameters(candidate, parameterSuffix)) }
      : {}),
  };
}

/**
 * Check whether a model name is permitted by the given policy config.
 *
 * @param {string} model
 * @param {{ allowedModels?: string[]|null, disallowedModels?: string[]|null }} policyConfig
 * @param {string} provider
 * @returns {boolean}
 */
function _isModelPermittedByPolicy(model, policyConfig, provider) {
  if (provider === 'copilot' &&
      getRetiredModelBlockState(model, provider, { inputMode: 'native' })) return false;
  if (!policyConfig) return true;
  return isModelPermittedByPolicy(
    model,
    policyConfig.allowedModels ?? null,
    policyConfig.disallowedModels ?? null,
    provider,
  );
}

function _isModelHarnessPermitted(model, provider, resolutionState) {
  const decision = evaluateModelEligibility(model, provider, resolutionState.eligibilityRequest, { inputMode: 'native' });
  if (!['incompatible', 'unverified'].includes(decision.harness)) return true;
  if (!resolutionState.harnessRejection) resolutionState.harnessRejection = decision;
  return false;
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

  const aliases = new Map();
  for (const name of Object.keys(parsed.models)) {
    const normalized = name.toLowerCase();
    const previous = aliases.get(normalized);
    if (previous !== undefined) {
      const error = new Error(
        `AWF_MODEL_ALIASES contains case-insensitive alias collision "${previous}" and "${name}"; rename one alias`,
      );
      error.code = 'ambiguous_model_alias';
      throw error;
    }
    aliases.set(normalized, name);
  }

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
function _resolveDirectMatch(key, requestedModel, currentProvider, availableModels, fallbackConfig, log, modelPolicyConfig, eligibilityRequest, resolutionState) {
  const { parameterSuffix } = splitModelParameters(requestedModel);
  const providerModels = (availableModels[currentProvider] || []);

  // 1. Direct match: model name already in the provider's available list
  const direct = findAvailableModel(splitModelParameters(requestedModel).baseModel, currentProvider, providerModels,
    { scope: getModelEligibilityScope(currentProvider, eligibilityRequest) });
  if (direct) {
    if (!_isModelPermittedByPolicy(direct, modelPolicyConfig, currentProvider)) {
      log.push(`[model-resolver] model policy blocked direct match: "${direct}"`);
      return null;
    }
    log.push(`[model-resolver] direct match: "${requestedModel}" → "${direct}"`);
    return {
      resolvedModel: appendModelParameters(direct, parameterSuffix),
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
    const familyCandidates = providerModels.filter(m => m.toLowerCase().startsWith(familyPrefix) &&
      /^gpt-5\.\d+$/i.test(m));
    const permittedCandidates = familyCandidates.filter(c =>
      _isModelPermittedByPolicy(c, modelPolicyConfig, currentProvider) &&
      _isModelHarnessPermitted(c, currentProvider, resolutionState));
    if (permittedCandidates.length > 0) {
      const sorted = [...new Set(permittedCandidates)].sort(compareByVersion);
      const fallback = sorted[0];
      log.push(`[model-resolver] requested model "${requestedModel}" not available, falling back to "${fallback}"`);
      return {
        resolvedModel: appendModelParameters(fallback, parameterSuffix),
        log,
        fallback: fallbackConfig.enabled
          ? { activated: false, selection_method: 'middle_power_median', reason: 'family_version_fallback' }
          : undefined,
      };
    }
    if (familyCandidates.some(candidate =>
      !_isModelHarnessPermitted(candidate, currentProvider, resolutionState))) {
      resolutionState.blocked = true;
      return null;
    }
  }

  // 3. Middle-power fallback. When a model policy is active, the fallback must only
  // ever select from the policy-permitted subset of the provider's models — otherwise
  // an unavailable request could resolve to a model the request guard would reject.
  const fallbackAvailableModels = {
    [currentProvider]: providerModels.filter(m =>
      _isModelPermittedByPolicy(m, modelPolicyConfig, currentProvider) &&
      _isModelHarnessPermitted(m, currentProvider, resolutionState)),
  };
  return applyModelParametersToResolution(tryMiddlePowerFallback(
    requestedModel, fallbackAvailableModels, currentProvider,
    'no_alias_match_and_not_in_available_models', fallbackConfig, log
  ), parameterSuffix);
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
function _resolveAliasPatterns(aliasKey, aliasDefinition, requestedModel, aliases, availableModels, currentProvider, newChain, fallbackConfig, log, modelPolicyConfig, resolutionState) {
  const { parameterSuffix } = splitModelParameters(requestedModel);
  const patterns = aliasDefinition.patterns;
  log.push(`[model-resolver] alias: "${requestedModel}" → [${patterns.join(', ')}]`);

  const candidates = [];
  const aliasKeys = new Set([aliasKey]);
  // Candidates produced by a nested alias's middle-power fallback are synthesized
  // guesses, not genuine pattern matches. They are kept separate so they can never
  // out-rank a sibling pattern that actually matched a model.
  const synthesizedCandidates = [];

  for (const pattern of patterns) {
    const slashIdx = pattern.indexOf('/');

    if (slashIdx === -1) {
      // Recursive alias reference (no provider prefix)
      const subState = { blocked: false, eligibilityRequest: resolutionState.eligibilityRequest };
      const sub = resolveModel(
        pattern,
        aliases,
        availableModels,
        currentProvider,
        newChain,
        fallbackConfig,
        modelPolicyConfig,
        false,
        subState
      );
      if (!sub && subState.blocked) {
        resolutionState.blocked = true;
        if (!resolutionState.harnessRejection) resolutionState.harnessRejection = subState.harnessRejection;
      }
      if (sub) {
        log.push(...sub.log);
        for (const key of sub.aliasKeys || []) aliasKeys.add(key);
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
      if (currentProvider === 'copilot' &&
          getRetiredModelBlockState(modelPattern, currentProvider, { inputMode: 'native' })) {
        resolutionState.blocked = true;
        log.push(`[model-resolver] ignored retired model target "${modelPattern}"`);
        continue;
      }

      for (const model of providerModels) {
        if (globMatch(modelPattern, model)) {
          candidates.push(model);
        }
      }
    }
  }

  // Prefer genuine pattern matches. Synthesized fallback picks from nested
  // aliases are only considered when no sibling pattern matched anything.
  const effectiveCandidates = candidates.length > 0 ? candidates
    : resolutionState.blocked ? [] : synthesizedCandidates;
  if (candidates.length > 0 && synthesizedCandidates.length > 0) {
    log.push(
      `[model-resolver] ignoring ${synthesizedCandidates.length} synthesized fallback candidate(s) ` +
      `in favour of ${candidates.length} genuine match(es)`
    );
  }

  // Keep genuine matches visible until admission so rejected matches cannot
  // activate the missing-model middle-power synthesis path.
  const filteredCandidates = effectiveCandidates.filter(c =>
    _isModelPermittedByPolicy(c, modelPolicyConfig, currentProvider) &&
    _isModelHarnessPermitted(c, currentProvider, resolutionState));
  if (effectiveCandidates.length > 0 && filteredCandidates.length === 0) resolutionState.blocked = true;

  if (filteredCandidates.length < effectiveCandidates.length) {
    const blocked = effectiveCandidates.filter(c => !filteredCandidates.includes(c));
    log.push(`[model-resolver] model eligibility filtered out ${blocked.length} candidate(s): ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? ', …' : ''}`);
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
    if (aliasDefinition.fallback && fallbackAllowed && hasProviderPattern && !modelPolicyConfig &&
        effectiveCandidates.length === 0 && !resolutionState.blocked) {
      const fallback = applyModelParametersToResolution(tryMiddlePowerFallback(
        requestedModel, {
          [currentProvider]: (availableModels[currentProvider] || [])
            .filter(model => _isModelPermittedByPolicy(model, modelPolicyConfig, currentProvider) &&
              _isModelHarnessPermitted(model, currentProvider, resolutionState)),
        }, currentProvider,
        'no_alias_match_and_not_in_available_models', fallbackConfig, log
      ), parameterSuffix);
      return fallback ? { ...fallback, aliasKeys: [...aliasKeys] } : null;
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
    resolvedModel: appendModelParameters(resolved, parameterSuffix),
    candidates: unique.map(candidate => appendModelParameters(candidate, parameterSuffix)),
    log,
    aliasKeys: [...aliasKeys],
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
  requestedModel, aliases, availableModels, currentProvider, chain = [],
  modelFallbackConfig = DEFAULT_MODEL_FALLBACK, modelPolicyConfig = null, preferDirectRequest = true,
  resolutionState = { blocked: false },
  eligibilityRequest = resolutionState.eligibilityRequest || {},
) {
  resolutionState.eligibilityRequest = eligibilityRequest;
  if (chain.length === 0) delete eligibilityRequest.awfAliasEligibilityRejection;
  const rejectResolution = () => {
    if (resolutionState.harnessRejection) {
      resolutionState.blocked = true;
      if (chain.length === 0) {
        eligibilityRequest.awfAliasEligibilityRejection = Object.freeze({
          requestedModel, provider: currentProvider, decision: resolutionState.harnessRejection,
        });
      }
    }
    return null;
  };
  const direct = preferDirectRequest && findAvailableModel(
    stripRedundantProviderPrefix(splitModelParameters(requestedModel).baseModel, currentProvider),
    currentProvider, availableModels?.[currentProvider] || [],
    { scope: getModelEligibilityScope(currentProvider, eligibilityRequest) },
  );
  if (!direct && preferDirectRequest && !isModelHarnessEligible(requestedModel, currentProvider, eligibilityRequest)) return null;
  const resolution = _resolveModel(
    requestedModel, aliases || {}, availableModels, currentProvider, chain,
    modelFallbackConfig, modelPolicyConfig, preferDirectRequest, resolutionState,
  );
  if (!resolution) return rejectResolution();
  const policy = {
    status: _isModelPermittedByPolicy(resolution.resolvedModel, modelPolicyConfig, currentProvider) ? 'allow' : 'deny',
    scope: getModelEligibilityScope(currentProvider, eligibilityRequest),
  };
  const eligibilityDecision = evaluateModelEligibility(resolution.resolvedModel, currentProvider, eligibilityRequest,
    { inputMode: 'native', evidence: { policy } });
  if (!eligibilityDecision.admitted && !direct) {
    resolutionState.blocked = true;
    if (['incompatible', 'unverified'].includes(eligibilityDecision.harness)) resolutionState.harnessRejection = eligibilityDecision;
    return rejectResolution();
  }
  const resolved = resolveModelIdentity(resolution.resolvedModel, currentProvider, {
    scope: getModelEligibilityScope(currentProvider, eligibilityRequest),
    policy: { providerPrefix: false },
  });
  const requested = resolveModelIdentity(requestedModel, currentProvider, {
    scope: getModelEligibilityScope(currentProvider, eligibilityRequest),
  });
  const matchKind = requested.identity?.key === resolved.identity?.key
    ? requested.matchKind
    : resolution.fallback?.activated ? 'fallback'
      : resolution.log.some(line => line.includes('[model-resolver] alias:')) ? 'routing-alias'
        : 'direct';
  return {
    ...resolution,
    eligibilityDecision,
    requestedModel,
    identity: resolved.identity,
    wireId: splitModelParameters(resolution.resolvedModel).baseModel,
    matchKind,
    aliasKeys: resolution.aliasKeys || [],
  };
}

function findRoutingAlias(aliases, key) {
  const entries = Object.entries(aliases).filter(([name]) => name.toLowerCase() === key);
  if (entries.length > 1) {
    const error = new Error(`Ambiguous routing alias "${key}"; use unique case-insensitive alias names`);
    error.code = 'ambiguous_model_alias';
    error.statusCode = 400;
    throw error;
  }
  return entries[0];
}

function _resolveModel(
  requestedModel,
  aliases,
  availableModels,
  currentProvider,
  chain = [],
  modelFallbackConfig = DEFAULT_MODEL_FALLBACK,
  modelPolicyConfig = null,
  preferDirectRequest = true,
  resolutionState = { blocked: false }
) {
  const log = [];
  const originalRequestedModel = requestedModel;
  const { baseModel: rawBaseModel, parameterSuffix } = splitModelParameters(requestedModel);
  // Strip a redundant "<provider>/" prefix (e.g. "openai/gpt-6-sol", as used by
  // harnesses such as Pi and Codex) so it resolves identically to the bare
  // model name on this provider. NOTE: body-handler.js's
  // `transformRequestBody` independently calls `stripRedundantModelPrefixInBody`
  // (model-body-rewriter.js) unconditionally before this alias-resolution path
  // runs, so that the same normalization is applied even when
  // AWF_MODEL_ALIASES is not configured. Both call sites share this logic via
  // `stripRedundantProviderPrefix` in model-utils.js — keep them in sync.
  const baseModel = stripRedundantProviderPrefix(rawBaseModel, currentProvider);
  if (baseModel !== rawBaseModel) {
    log.push(`[model-resolver] stripped redundant provider prefix: "${rawBaseModel}" → "${baseModel}"`);
  }
  const key = baseModel.toLowerCase();
  const fallbackConfig = normalizeFallbackConfig(modelFallbackConfig);
  // From here on, operate on a new normalized value (the possibly
  // prefix-stripped requested model) so downstream log messages, loop
  // detection, and direct/alias matching all see the normalized value rather
  // than the raw "<provider>/model" string. The raw input remains available
  // above as `originalRequestedModel` for anything that needs the true input.
  const normalizedRequestedModel = appendModelParameters(baseModel, parameterSuffix);
  if (currentProvider === 'copilot' && key === 'auto') {
    if (!_isModelPermittedByPolicy(baseModel, modelPolicyConfig, currentProvider)) {
      log.push(`[model-resolver] model policy blocked dynamic model: "${baseModel}"`);
      return null;
    }
    log.push('[model-resolver] special pass-through: "auto"');
    return {
      resolvedModel: normalizedRequestedModel,
      candidates: [normalizedRequestedModel],
      log,
      fallback: fallbackConfig.enabled
        ? { activated: false, selection_method: 'middle_power_median', reason: 'direct_match' }
        : undefined,
    };
  }

  // Loop detection
  if (chain.includes(key)) {
    log.push(`[model-resolver] loop detected: "${originalRequestedModel}" already in chain [${chain.join(' → ')}]`);
    return null;
  }
  const newChain = [...chain, key];

  // An explicit model available from this provider is authoritative over any
  // matching alias. This prevents an alias with the same name from silently
  // steering a request away from the configured provider.
  if (preferDirectRequest) {
    const providerModels = (availableModels[currentProvider] || []);
    const direct = findAvailableModel(baseModel, currentProvider, providerModels,
      { scope: getModelEligibilityScope(currentProvider, resolutionState.eligibilityRequest) });
    if (direct) {
      if (!_isModelPermittedByPolicy(direct, modelPolicyConfig, currentProvider)) {
        log.push(`[model-resolver] model policy blocked direct match: "${direct}"`);
        return null;
      }
      log.push(`[model-resolver] direct match: "${originalRequestedModel}" → "${direct}"`);
      return {
        resolvedModel: appendModelParameters(direct, parameterSuffix),
        candidates: [appendModelParameters(direct, parameterSuffix)],
        log,
        fallback: fallbackConfig.enabled
          ? { activated: false, selection_method: 'middle_power_median', reason: 'direct_match' }
          : undefined,
      };
    }
  }

  // Find alias entry (case-insensitive)
  let aliasEntry = findRoutingAlias(aliases, key);

  if (!aliasEntry) {
    // Family fallback: treat gpt-5.<minor> as gpt-5 when only the family alias
    // exists. This keeps versioned IDs like gpt-5.4 compatible with configs that
    // define "gpt-5" alias patterns.
    const familyAlias = key.match(/^(gpt-5)\.\d+$/)?.[1];
    if (familyAlias) {
      aliasEntry = findRoutingAlias(aliases, familyAlias);
      if (aliasEntry) {
        log.push(`[model-resolver] fallback alias: "${originalRequestedModel}" → "${aliasEntry[0]}"`);
      }
    }
  }

  if (!aliasEntry) {
    if (currentProvider === 'copilot' &&
        getRetiredModelBlockState(normalizedRequestedModel, currentProvider, { inputMode: 'native' })) {
      resolutionState.blocked = true;
      log.push(`[model-resolver] blocked retired model: "${normalizedRequestedModel}"`);
      return null;
    }
    return _resolveDirectMatch(key, normalizedRequestedModel, currentProvider, availableModels, fallbackConfig, log, modelPolicyConfig,
      resolutionState.eligibilityRequest, resolutionState);
  }

  const [aliasKey, aliasRaw] = aliasEntry;
  const aliasDefinition = resolveAliasDefinition(aliasRaw);
  return _resolveAliasPatterns(aliasKey, aliasDefinition, normalizedRequestedModel, aliases, availableModels, currentProvider, newChain, fallbackConfig, log, modelPolicyConfig, resolutionState);
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
