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
 * @returns {{ body: Buffer, originalModel: string, resolvedModel: string, log: string[], fallback?: object } | null}
 */
function rewriteModelInBody(body, provider, aliases, availableModels, modelFallbackConfig) {
  // Only attempt rewrite for non-empty bodies
  if (!body || body.length === 0) return null;

  const parsed = parseBodyAsObject(body);
  if (!parsed) return null; // Non-JSON body — skip

  // Determine the requested model. If absent, try the default alias ("").
  const originalModel = typeof parsed.model === 'string' ? parsed.model : '';

  const resolution = resolveModel(originalModel, aliases, availableModels, provider, [], modelFallbackConfig);
  if (!resolution) return null;

  const { resolvedModel, log } = resolution;

  // No rewrite needed if the model is already the resolved value
  if (resolvedModel === parsed.model) return null;

  // Patch the body
  parsed.model = resolvedModel;
  const newBody = Buffer.from(JSON.stringify(parsed), 'utf8');

  return { body: newBody, originalModel, resolvedModel, log, fallback: resolution.fallback };
}

module.exports = {
  rewriteModelInBody,
};
