/**
 * Synthesized fallback handling for missing alias pattern matches.
 */

const { _isModelPermittedByPolicy } = require('./model-policy');
const { isModelHarnessEligible } = require('./model-eligibility');
const { isAutomaticModelCandidate } = require('./automatic-model-eligibility');
const { splitModelParameters, applyModelParametersToResolution } = require('./model-parameters');
const { tryMiddlePowerFallback } = require('./model-fallback');

function getEffectiveAliasCandidates({ candidates, synthesizedCandidates, resolutionState, log }) {
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
  return {
    effectiveCandidates,
    resolvedViaSynthesis: candidates.length === 0 && synthesizedCandidates.length > 0,
  };
}

function tryAliasMiddlePowerFallback({
  aliasDefinition, requestedModel, availableModels, currentProvider, newChain,
  fallbackConfig, log, modelPolicyConfig, resolutionState, effectiveCandidates, aliasKeys,
}) {
  const patterns = aliasDefinition.patterns;
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
    const { parameterSuffix } = splitModelParameters(requestedModel);
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

module.exports = { getEffectiveAliasCandidates, tryAliasMiddlePowerFallback };
