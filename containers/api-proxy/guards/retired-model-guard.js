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
 * Keep this list in sync with RETIRED_COPILOT_MODEL_ALIASES in
 * src/copilot-model.ts (the TypeScript CLI equivalent).
 */
const RETIRED_COPILOT_MODELS = {
  'gpt-5-codex': 'gpt-5.3-codex',
};

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
  const suggestion = RETIRED_COPILOT_MODELS[key];
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
