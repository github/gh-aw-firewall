/**
 * Policy/harness admission and version-ranked selection of alias candidates.
 */

const { _isModelPermittedByPolicy, _isModelHarnessPermitted } = require('./model-policy');
const { compareByVersion } = require('./model-utils');
const { splitModelParameters, appendModelParameters } = require('./model-parameters');

function filterAliasCandidates({
  effectiveCandidates, modelPolicyConfig, currentProvider, resolutionState, log,
}) {
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
  return filteredCandidates;
}

function selectAliasCandidate({
  filteredCandidates, requestedModel, aliasKeys, automaticCandidates, genuineCandidates,
  resolvedViaSynthesis, fallbackConfig, log,
}) {
  const { parameterSuffix } = splitModelParameters(requestedModel);
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

module.exports = { filterAliasCandidates, selectAliasCandidate };
