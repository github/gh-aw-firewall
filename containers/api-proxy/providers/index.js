'use strict';

/**
 * Provider adapter registry.
 *
 * Exports `createAllAdapters()` which creates the ordered list of provider
 * adapters used by the core proxy engine.
 *
 * @see ADDING-A-PROVIDER.md for instructions on adding a new LLM provider.
 */

const { createOpenAIAdapter } = require('./openai');
const { createAnthropicAdapter } = require('./anthropic');
const { createCopilotAdapter } = require('./copilot');
const { createGeminiAdapter } = require('./gemini');
const { createOpenCodeAdapter } = require('./opencode');

/**
 * @typedef {Object} ProbeConfig
 * @property {string} url - URL to probe
 * @property {{ method: string, headers: Record<string,string>, body?: string }} opts - Request options
 */

/**
 * @typedef {Object} SkipProbeConfig
 * @property {true} skip
 * @property {string} reason
 */

/**
 * @typedef {Object} ModelsFetchConfig
 * @property {string} url - URL to fetch
 * @property {{ method: string, headers: Record<string,string> }} opts - Request options
 * @property {string} cacheKey - Key in cachedModels to store the result
 */

/**
 * @typedef {Object} ReflectionInfo
 * @property {string} provider - Provider name
 * @property {number} port - Port number
 * @property {string} base_url - Base URL for the provider
 * @property {boolean} configured - Whether the provider is configured
 * @property {string|null} models_cache_key - Key in cachedModels, or null if not applicable
 * @property {string|null} models_url - URL to fetch models from (for documentation/reflection)
 */

/**
 * @typedef {Object} UnconfiguredResponse
 * @property {number} statusCode - HTTP status code
 * @property {object} body - Response body
 */

/**
 * Provider adapter interface.
 *
 * Each adapter encapsulates all provider-specific knowledge:
 *   - Which port to listen on
 *   - How to authenticate requests (getAuthHeaders)
 *   - How to transform URLs (transformRequestUrl)
 *   - How to transform request bodies (getBodyTransform)
 *   - How to validate credentials at startup (getValidationProbe)
 *   - How to fetch available models at startup (getModelsFetchConfig)
 *   - How to describe the endpoint for /reflect (getReflectionInfo)
 *
 * The core proxy engine (server.js) is completely agnostic of which providers
 * exist — it only calls methods defined in this interface.
 *
 * @typedef {Object} ProviderAdapter
 * @property {string} name - Unique provider identifier (e.g. 'openai')
 * @property {number} port - Port to listen on
 * @property {boolean} isManagementPort - Whether this port serves /health, /metrics, /reflect
 * @property {boolean} alwaysBind - Whether to start even when isEnabled() returns false
 * @property {boolean} participatesInValidation - Whether counted in the startup latch
 *
 * @property {() => boolean} isEnabled - Whether this provider is configured (has credentials)
 * @property {(req?: import('http').IncomingMessage) => string} getTargetHost - Upstream hostname
 * @property {(req?: import('http').IncomingMessage) => string} getBasePath - Base path prefix
 * @property {(req: import('http').IncomingMessage) => Record<string,string>} getAuthHeaders - Auth headers
 * @property {((url: string) => string) | undefined} transformRequestUrl - Optional URL transform
 * @property {() => ((body: Buffer) => Buffer|null)|null} getBodyTransform - Optional body transform
 *
 * @property {() => ProbeConfig|SkipProbeConfig|null} getValidationProbe - Startup validation probe
 * @property {() => ModelsFetchConfig|null} getModelsFetchConfig - Startup model fetch config
 * @property {() => ReflectionInfo} getReflectionInfo - Reflection endpoint metadata
 * @property {() => UnconfiguredResponse} [getUnconfiguredResponse] - Response when not configured (alwaysBind adapters)
 * @property {() => UnconfiguredResponse} [getUnconfiguredHealthResponse] - /health response when not configured
 */

/**
 * Create all provider adapters in port order.
 *
 * The returned array defines both the server start order and the order in
 * which providers appear in /reflect and models.json output.
 *
 * OpenCode's routing priority is controlled by the `candidateAdapters` array
 * passed here — the first enabled adapter in that list is used for each
 * request.  To change routing priority or add a new provider to OpenCode's
 * routing, update the candidateAdapters array below.  No changes to
 * opencode.js itself are needed.
 *
 * @param {Record<string, string|undefined>} env - Environment variables (typically process.env)
 * @param {{ openaiBodyTransform, anthropicBodyTransform, copilotBodyTransform, geminiBodyTransform }} deps
 *   Body-transform functions produced by server.js (to avoid circular dependencies).
 * @returns {ProviderAdapter[]}
 */
function createAllAdapters(env, deps = {}) {
  const openai    = createOpenAIAdapter(env,    { bodyTransform: deps.openaiBodyTransform    || null });
  const anthropic = createAnthropicAdapter(env, { bodyTransform: deps.anthropicBodyTransform || null });
  const copilot   = createCopilotAdapter(env,   { bodyTransform: deps.copilotBodyTransform   || null });
  const gemini    = createGeminiAdapter(env,    { bodyTransform: deps.geminiBodyTransform    || null });

  // OpenCode routes to the first enabled candidate adapter in the order listed.
  // Priority: OpenAI → Anthropic → Copilot
  // To add a new provider to OpenCode routing: add it to this array in the
  // desired priority position.  All listed providers remain independently
  // reachable on their own ports regardless of this setting.
  const opencode  = createOpenCodeAdapter(env, { candidateAdapters: [openai, anthropic, copilot] });

  return [openai, anthropic, copilot, gemini, opencode];
}

module.exports = {
  createAllAdapters,
  createOpenAIAdapter,
  createAnthropicAdapter,
  createCopilotAdapter,
  createGeminiAdapter,
  createOpenCodeAdapter,
};
