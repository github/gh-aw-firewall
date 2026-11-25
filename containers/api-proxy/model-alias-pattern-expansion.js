/**
 * Recursive alias expansion and provider-specific pattern matching.
 */

const { globMatch } = require('./model-utils');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const { isAutomaticModelCandidate } = require('./automatic-model-eligibility');
const { filterAliasCandidates, selectAliasCandidate } = require('./model-candidate-selection');
const { getEffectiveAliasCandidates, tryAliasMiddlePowerFallback } = require('./model-middle-power-synthesis');

/**
 * Expand alias patterns for a resolved alias entry and pick the best candidate.
 *
 * @param {object} context - Resolution inputs and shared log/rejection state
 * @param {Function} context.resolveModel - Facade callback for recursive aliases
 * @returns {{ resolvedModel: string, log: string[], fallback?: object } | null}
 */
function _resolveAliasPatterns(context) {
  const {
    aliasKey, aliasDefinition, requestedModel, aliases, availableModels, currentProvider,
    newChain, fallbackConfig, log, modelPolicyConfig, resolutionState, resolveModel,
  } = context;
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

  const selectionContext = {
    ...context, candidates, automaticCandidates, genuineCandidates, aliasKeys, synthesizedCandidates,
  };
  Object.assign(selectionContext, getEffectiveAliasCandidates(selectionContext));
  const filteredCandidates = filterAliasCandidates(selectionContext);

  if (filteredCandidates.length === 0) {
    log.push(`[model-resolver] no candidates found for "${aliasKey}" on provider "${currentProvider}"`);
    return tryAliasMiddlePowerFallback(selectionContext);
  }
  return selectAliasCandidate({ ...selectionContext, filteredCandidates });
}

module.exports = { _resolveAliasPatterns };
