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
const { _resolveAliasPatterns } = require('./model-alias-pattern-expansion');
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
  return _resolveAliasPatterns({
    aliasKey, aliasDefinition, requestedModel: normalizedRequestedModel, aliases, availableModels,
    currentProvider, newChain, fallbackConfig, log, modelPolicyConfig, resolutionState, resolveModel,
  });
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
