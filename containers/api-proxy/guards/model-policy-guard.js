'use strict';

const { globMatch } = require('../model-utils');

/**
 * Model policy enforcement for AWF API proxy.
 *
 * Enforces allowed and disallowed model lists using glob patterns.
 *
 * Config (JSON arrays of glob patterns):
 *   AWF_ALLOWED_MODELS  — allowlist: only models matching at least one pattern are permitted
 *   AWF_DISALLOWED_MODELS — denylist: models matching any pattern are rejected
 *
 * Rules:
 *   1. If a model matches any disallowed pattern → rejected.
 *   2. If an allowlist is configured and the model matches no allowed pattern → rejected.
 *   3. Otherwise → permitted.
 *
 * Glob syntax: * wildcard, case-insensitive. Examples: "*opus*", "claude-*", "gpt-5*".
 */

/**
 * Parse a JSON array of glob pattern strings from a raw env var value.
 *
 * @param {string|null|undefined} raw
 * @returns {string[]|null} Parsed array of pattern strings, or null if absent/invalid/empty.
 */
function parseModelPatterns(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    if (!Array.isArray(parsed)) return null;
    const strings = parsed.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
    return strings.length > 0 ? strings : null;
  } catch {
    return null;
  }
}

const ALLOWED_MODELS = parseModelPatterns(process.env.AWF_ALLOWED_MODELS);
const DISALLOWED_MODELS = parseModelPatterns(process.env.AWF_DISALLOWED_MODELS);

if (ALLOWED_MODELS) {
  const { logRequest } = require('../logging');
  logRequest('info', 'startup', {
    message: 'Model policy: allowed models configured',
    allowed_models: ALLOWED_MODELS,
  });
}

if (DISALLOWED_MODELS) {
  const { logRequest } = require('../logging');
  logRequest('info', 'startup', {
    message: 'Model policy: disallowed models configured',
    disallowed_models: DISALLOWED_MODELS,
  });
}

/**
 * Check whether a model name is permitted by the current policy.
 *
 * @param {string} model - The model name to check (case-insensitive)
 * @param {string[]|null} [allowedModels] - Override for allowed patterns (defaults to module-level config)
 * @param {string[]|null} [disallowedModels] - Override for disallowed patterns (defaults to module-level config)
 * @returns {boolean} true when the model is permitted.
 */
function isModelPermittedByPolicy(model, allowedModels = ALLOWED_MODELS, disallowedModels = DISALLOWED_MODELS) {
  if (!allowedModels && !disallowedModels) return true;
  if (!model) return true;

  // Disallowed check first (denylist takes priority over allowlist)
  if (disallowedModels && disallowedModels.some(pattern => globMatch(pattern, model))) {
    return false;
  }

  // Allowlist check
  if (allowedModels && !allowedModels.some(pattern => globMatch(pattern, model))) {
    return false;
  }

  return true;
}

/**
 * Returns a block-state object when the model is rejected by the model policy,
 * or null when the model is permitted.
 *
 * @param {string|null} model - The model name extracted from the request body.
 * @returns {{ model: string, reason: 'disallowed'|'not_allowed' } | null}
 */
function getModelPolicyBlockState(model) {
  if (!model) return null;
  if (!ALLOWED_MODELS && !DISALLOWED_MODELS) return null;

  if (DISALLOWED_MODELS && DISALLOWED_MODELS.some(pattern => globMatch(pattern, model))) {
    return { model, reason: 'disallowed' };
  }

  if (ALLOWED_MODELS && !ALLOWED_MODELS.some(pattern => globMatch(pattern, model))) {
    return { model, reason: 'not_allowed' };
  }

  return null;
}

/**
 * Builds the structured 403 error response body for a model-policy rejection.
 *
 * @param {{ model: string, reason: string }} state
 * @returns {{ error: object }}
 */
function buildModelPolicyError(state) {
  const message = state.reason === 'disallowed'
    ? `Model '${state.model}' is not permitted: it is explicitly disallowed by the model policy.`
    : `Model '${state.model}' is not permitted: it does not match the allowed models policy.`;
  return {
    error: {
      type: 'model_policy_violation',
      message,
      model: state.model,
      reason: state.reason,
    },
  };
}

module.exports = {
  parseModelPatterns,
  isModelPermittedByPolicy,
  getModelPolicyBlockState,
  buildModelPolicyError,
  ALLOWED_MODELS,
  DISALLOWED_MODELS,
};
