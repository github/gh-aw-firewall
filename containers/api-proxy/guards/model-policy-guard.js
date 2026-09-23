'use strict';

const { globMatch, stripRedundantProviderPrefix } = require('../model-utils');
const { getProviderAliases } = require('../provider-pricing-overlays');

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

function modelPolicyPatternMatches(pattern, model, provider) {
  if (!provider) return globMatch(pattern, model);
  const aliases = getProviderAliases(provider.toLowerCase());
  const prefix = aliases.find(alias => model.toLowerCase().startsWith(`${alias}/`));
  const nativeModel = prefix ? stripRedundantProviderPrefix(model, prefix) : model;
  return pattern.includes('/')
    ? aliases.some(alias => globMatch(pattern, `${alias}/${nativeModel}`))
    : globMatch(pattern, nativeModel);
}

function isDynamicModelUnverifiable(model, allowedModels, disallowedModels, provider) {
  return modelPolicyPatternMatches('auto', model, provider) &&
    !!disallowedModels &&
    !(allowedModels && allowedModels.some(pattern => modelPolicyPatternMatches(pattern, model, provider)));
}

/**
 * Check whether a model name is permitted by the current policy.
 *
 * @param {string} model - The model name to check (case-insensitive)
 * @param {string[]|null} [allowedModels] - Override for allowed patterns (defaults to module-level config)
 * @param {string[]|null} [disallowedModels] - Override for disallowed patterns (defaults to module-level config)
 * @param {string|null} [provider] - Provider slot for provider-qualified patterns.
 * @returns {boolean} true when the model is permitted.
 */
function isModelPermittedByPolicy(model, allowedModels = ALLOWED_MODELS, disallowedModels = DISALLOWED_MODELS, provider = null) {
  if (!allowedModels && !disallowedModels) return true;
  if (!model) return true;

  // Provider-aware resolution must not offer a dynamic model the request guard rejects.
  if (provider && isDynamicModelUnverifiable(model, allowedModels, disallowedModels, provider)) return false;

  // Disallowed check first (denylist takes priority over allowlist)
  if (disallowedModels && disallowedModels.some(pattern => modelPolicyPatternMatches(pattern, model, provider))) {
    return false;
  }

  // Allowlist check
  if (allowedModels && !allowedModels.some(pattern => modelPolicyPatternMatches(pattern, model, provider))) {
    return false;
  }

  return true;
}

/**
 * Returns a block-state object when the model is rejected by the model policy,
 * or null when the model is permitted.
 *
 * @param {string|null} model - The model name extracted from the request body.
 * @param {string|null} [provider] - Provider slot for provider-qualified patterns.
 * @returns {{ model: string, reason: 'disallowed'|'not_allowed'|'dynamic_model_unverifiable' } | null}
 */
function getModelPolicyBlockState(model, provider = null) {
  if (!model) return null;
  if (!ALLOWED_MODELS && !DISALLOWED_MODELS) return null;

  if (isDynamicModelUnverifiable(model, ALLOWED_MODELS, DISALLOWED_MODELS, provider)) {
    return { model, reason: 'dynamic_model_unverifiable' };
  }

  if (DISALLOWED_MODELS && DISALLOWED_MODELS.some(pattern => modelPolicyPatternMatches(pattern, model, provider))) {
    return { model, reason: 'disallowed' };
  }

  if (ALLOWED_MODELS && !ALLOWED_MODELS.some(pattern => modelPolicyPatternMatches(pattern, model, provider))) {
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
  const message = state.reason === 'dynamic_model_unverifiable'
    ? `Model '${state.model}' selects a concrete model at runtime, so the configured denylist cannot be proven. Explicitly allow 'auto' to opt in.`
    : state.reason === 'disallowed'
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
