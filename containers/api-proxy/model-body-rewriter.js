'use strict';

/**
 * HTTP body rewriting for AWF API proxy model resolution.
 *
 * Rewrites the "model" field in a JSON request body using the alias map.
 * This is an HTTP transformation concern, kept separate from the core
 * alias resolution algorithm in model-resolver.js.
 */

const { parseBodyAsObject } = require('./body-utils');
const { resolveModel } = require('./model-resolver');
const { stripRedundantProviderPrefix } = require('./model-utils');

/**
 * Attempt to rewrite the "model" field in a JSON request body using the alias map.
 *
 * Returns the rewritten body buffer and the resolution log when a rewrite occurs.
 * Returns null when no rewrite is needed or possible.
 *
 * @param {Buffer} body - Raw request body bytes
 * @param {string} provider - Current provider (e.g. "copilot")
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases - Parsed alias map
 * @param {Record<string, string[]|null>} availableModels - Cached models per provider
 * @param {{ enabled?: boolean, strategy?: string }} [modelFallbackConfig]
 * @param {{ allowedModels?: string[]|null, disallowedModels?: string[]|null }|null} [modelPolicyConfig]
 * @returns {{ body: Buffer, originalModel: string, resolvedModel: string, candidates: string[], log: string[], fallback?: object } | null}
 */
function rewriteModelInBody(body, provider, aliases, availableModels, modelFallbackConfig, modelPolicyConfig) {
  // Only attempt rewrite for non-empty bodies
  if (!body || body.length === 0) return null;

  const parsed = parseBodyAsObject(body);
  if (!parsed) return null; // Non-JSON body — skip

  // Determine the requested model. If absent, try the default alias ("").
  const originalModel = typeof parsed.model === 'string' ? parsed.model : '';

  const resolution = resolveModel(originalModel, aliases, availableModels, provider, [], modelFallbackConfig, modelPolicyConfig);
  if (!resolution) return null;

  const { resolvedModel, candidates, log } = resolution;

  // No rewrite needed if the model is already the resolved value
  if (resolvedModel === parsed.model) return null;

  // Patch the body
  parsed.model = resolvedModel;
  const newBody = Buffer.from(JSON.stringify(parsed), 'utf8');

  return { body: newBody, originalModel, resolvedModel, candidates, log, fallback: resolution.fallback };
}

/**
 * Strip a redundant "<provider>/" prefix (e.g. "copilot/auto", as sent by
 * harnesses such as Pi and Codex that use LiteLLM-style "provider/model"
 * naming) from the "model" field of a JSON request body.
 *
 * Unlike `rewriteModelInBody`, this runs unconditionally — independent of
 * whether `AWF_MODEL_ALIASES` is configured — so the prefix is normalized
 * even for deployments that do not use model aliasing at all.
 *
 * @param {Buffer} body - Raw request body bytes
 * @param {string} provider - Current provider (e.g. "copilot")
 * @returns {Buffer | null} The rewritten body, or null when no change is needed.
 */
function stripRedundantModelPrefixInBody(body, provider) {
  if (!body || body.length === 0) return null;

  const parsed = parseBodyAsObject(body);
  if (!parsed || typeof parsed.model !== 'string') return null;

  const stripped = stripRedundantProviderPrefix(parsed.model, provider);
  if (stripped === parsed.model) return null;

  parsed.model = stripped;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

module.exports = {
  rewriteModelInBody,
  stripRedundantModelPrefixInBody,
};
