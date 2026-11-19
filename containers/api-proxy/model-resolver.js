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
 * Wildcard matches and fallbacks only consider models that can be selected
 * automatically (see automatic-selection.js); exact entries are kept as written.
 */

const { globMatch, extractVersionNumbers, compareByVersion, stripRedundantProviderPrefix } = require('./model-utils');
const { parseModelAliases, resolveAliasDefinition } = require('./model-alias-config');
const { _isModelPermittedByPolicy, _isModelHarnessPermitted } = require('./model-policy');
const { splitModelParameters, appendModelParameters, applyModelParametersToResolution } = require('./model-parameters');
const {
  filterResolvableAliases: filterAliases,
  filterAvailableModelsToConfiguredProviders,
} = require('./model-provider-filter');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const { resolveModelIdentity, findAvailableModel } = require('./model-identity');
const { getModelEligibilityScope, evaluateModelEligibility, isModelHarnessEligible } = require('./model-eligibility');
const { isAutomaticModelCandidate } = require('./automatic-model-eligibility');
const {
  DEFAULT_MODEL_FALLBACK,
  normalizeFallbackConfig,
  selectMiddlePowerFallback,
  tryMiddlePowerFallback,
} = require('./model-fallback');

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
      /^gpt-5\.\d+$/i.test(m) &&
      isAutomaticModelCandidate(m, currentProvider, eligibilityRequest.awfRuntimePricing));
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
        automaticReplacement: true,
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
      isModelHarnessEligible(m, currentProvider, resolutionState.eligibilityRequest, { inputMode: 'native' }) &&
      isAutomaticModelCandidate(m, currentProvider, eligibilityRequest.awfRuntimePricing)),
  };
  return applyModelParametersToResolution(tryMiddlePowerFallback(
    requestedModel, fallbackAvailableModels, currentProvider,
    'no_alias_match_and_not_in_available_models', fallbackConfig, log, eligibilityRequest.awfRuntimePricing
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
  const automaticCandidates = new Set();
  const genuineCandidates = new Set();
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
          (sub.automaticReplacement === true ? automaticCandidates : genuineCandidates).add(sub.resolvedModel);
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

      // An exact entry is an explicit choice; a wildcard only selects models
      // that can be chosen automatically.
      const isWildcard = modelPattern.includes('*');
      const skipped = [];
      for (const model of providerModels) {
        if (!globMatch(modelPattern, model)) continue;
        if (isWildcard && !isAutomaticModelCandidate(
          model, currentProvider, resolutionState.eligibilityRequest.awfRuntimePricing,
        )) {
          resolutionState.blocked = true;
          skipped.push(model);
          continue;
        }
        candidates.push(model);
        genuineCandidates.add(model);
      }
      if (skipped.length > 0) {
        log.push(`[model-resolver] "${pattern}" skipped ${skipped.length} model(s) that cannot be selected automatically: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}`);
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
              isModelHarnessEligible(model, currentProvider, resolutionState.eligibilityRequest, { inputMode: 'native' }) &&
              isAutomaticModelCandidate(
                model, currentProvider, resolutionState.eligibilityRequest.awfRuntimePricing,
              )),
        }, currentProvider,
        'no_alias_match_and_not_in_available_models', fallbackConfig, log,
        resolutionState.eligibilityRequest.awfRuntimePricing
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
    ...(automaticCandidates.has(resolved) && !genuineCandidates.has(resolved) ? { automaticReplacement: true } : {}),
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

function filterResolvableAliases(aliases, availableModels, configuredProviders) {
  return filterAliases(aliases, availableModels, configuredProviders, resolveModel);
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
