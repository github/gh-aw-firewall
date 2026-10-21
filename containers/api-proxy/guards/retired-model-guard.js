'use strict';

const { sanitizeForLog } = require('../logging');

/**
 * Known-retired Copilot model names mapped to their suggested replacements.
 *
 * When the API proxy receives a request body that references one of these
 * model names, it rejects the request immediately with a 400 rather than
 * forwarding it to the upstream provider.  Forwarding a retired model name
 * to the Copilot API tends to surface an authentication-flavoured error (401
 * or 403) rather than a clear "model unavailable" message, which misleads
 * operators into thinking their API keys are invalid.
 *
 * Generated from shared/model-information/sources by models:generate.
 * Keep lowercase-only matching here: host separator equivalence is a separate
 * compatibility policy, not an implicit proxy normalization correction.
 */
const RETIRED_COPILOT_MODELS = new Map(
  Object.entries(require('../model-information.retired.generated.json')),
);

/**
 * Returns a block-state object when the given model name is a known-retired
 * Copilot model, or null when the model is not retired / is absent.
 *
 * @param {string|null} model - The model name extracted from the request body.
 * @returns {{ model: string, suggestion: string } | null}
 */
function getRetiredModelBlockState(model) {
  if (!model) return null;
  const key = model.toLowerCase();
  const suggestion = RETIRED_COPILOT_MODELS.get(key);
  if (!suggestion) return null;
  return { model: sanitizeForLog(model), suggestion };
}

/**
 * Builds the structured 400 error response body for a retired-model rejection.
 *
 * @param {{ model: string, suggestion: string }} state
 * @returns {{ error: object }}
 */
function buildRetiredModelError(state) {
  return {
    error: {
      type: 'retired_model',
      message: `Model '${state.model}' is retired or unsupported. Did you mean '${state.suggestion}'?`,
      model: state.model,
      suggestion: state.suggestion,
    },
  };
}

module.exports = {
  getRetiredModelBlockState,
  buildRetiredModelError,
};
