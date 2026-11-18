/**
 * Policy and harness admission checks used during model resolution.
 */

const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const { evaluateModelEligibility } = require('./model-eligibility');

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

module.exports = { _isModelPermittedByPolicy, _isModelHarnessPermitted };
