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
const { compareByVersion, stripRedundantProviderPrefix } = require('./model-utils');
const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');

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

function isCopilotAutoResponsesRequest(body, req) {
  if (req?.method !== 'POST' || typeof req.url !== 'string') return false;
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return false;
  }
  if (pathname !== '/responses' && pathname !== '/v1/responses') return false;
  const parsed = parseBodyAsObject(body);
  return typeof parsed?.model === 'string' &&
    stripRedundantProviderPrefix(parsed.model, 'copilot').toLowerCase() === 'auto';
}

function rewriteCopilotAutoResponsesModelInBody(body, availableModels, modelRecords, modelPolicyConfig) {
  const available = new Set(
    (availableModels || []).filter(model => typeof model === 'string').map(model => model.toLowerCase()),
  );
  const recordsById = new Map(
    (modelRecords || [])
      .filter(record => typeof record?.id === 'string')
      .map(record => [record.id.toLowerCase(), record]),
  );
  const candidates = [...available]
    .map(id => recordsById.get(id))
    .filter(record => record &&
      /(?:^|[-.])codex(?:$|[-.])/i.test(record.id) &&
      Array.isArray(record.supportedEndpoints) &&
      record.supportedEndpoints.some(endpoint => ['/responses', '/v1/responses', 'responses'].includes(endpoint)) &&
      isModelPermittedByPolicy(
        record.id,
        modelPolicyConfig?.allowedModels,
        modelPolicyConfig?.disallowedModels,
        'copilot',
      ))
    .map(record => record.id)
    .sort(compareByVersion);
  if (candidates.length === 0) return null;

  const parsed = parseBodyAsObject(body);
  const originalModel = parsed.model;
  const resolvedModel = candidates[0];
  parsed.model = resolvedModel;
  return {
    body: Buffer.from(JSON.stringify(parsed), 'utf8'),
    originalModel,
    resolvedModel,
    candidates,
    log: [`[model-resolver] Copilot Responses auto: "${originalModel}" → "${resolvedModel}"`],
  };
}

module.exports = {
  rewriteModelInBody,
  stripRedundantModelPrefixInBody,
  isCopilotAutoResponsesRequest,
  rewriteCopilotAutoResponsesModelInBody,
};
