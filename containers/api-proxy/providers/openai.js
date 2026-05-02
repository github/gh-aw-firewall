'use strict';

/**
 * OpenAI provider adapter.
 *
 * Port: 10000  (also serves as the management port for /health, /metrics, /reflect)
 * Auth: Bearer token via Authorization header
 * Credentials: OPENAI_API_KEY
 * Target: OPENAI_API_TARGET  (default: api.openai.com)
 * Base path: OPENAI_API_BASE_PATH  (default: /v1 for the public endpoint)
 */

const { normalizeApiTarget, normalizeBasePath } = require('../proxy-utils');

/**
 * Create the OpenAI provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables (typically process.env)
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createOpenAIAdapter(env, deps = {}) {
  const apiKey = (env.OPENAI_API_KEY || '').trim() || undefined;
  const rawTarget = normalizeApiTarget(env.OPENAI_API_TARGET) || 'api.openai.com';
  const explicitBasePath = normalizeBasePath(env.OPENAI_API_BASE_PATH);

  // For the default OpenAI endpoint, unversioned clients (e.g. Codex CLI sending
  // /responses) need a /v1 prefix to reach the correct versioned API surface.
  // Custom targets manage their own path layout and must not receive an implicit prefix.
  const basePath = explicitBasePath || (rawTarget === 'api.openai.com' ? '/v1' : '');

  const bodyTransform = deps.bodyTransform || null;

  return {
    name: 'openai',
    port: 10000,

    /** Port 10000 is the central management port (/health, /metrics, /reflect). */
    isManagementPort: true,

    /**
     * Port 10000 always starts — even without a key — to serve the management
     * endpoints required by the Docker healthcheck.
     */
    alwaysBind: true,

    /** Port 10000 always counts toward the startup validation latch. */
    participatesInValidation: true,

    isEnabled() { return !!apiKey; },
    getTargetHost() { return rawTarget; },
    getBasePath() { return basePath; },

    getAuthHeaders() {
      return { 'Authorization': `Bearer ${apiKey}` };
    },

    getBodyTransform() { return bodyTransform; },

    /**
     * Returns the validation probe config, or null to skip.
     * Custom targets are skipped — we don't know their probe endpoints.
     *
     * @returns {{ url: string, opts: object }|{ skip: true, reason: string }|null}
     */
    getValidationProbe() {
      if (!apiKey) return null;
      if (rawTarget !== 'api.openai.com') {
        return { skip: true, reason: `Custom target ${rawTarget}; validation skipped` };
      }
      return {
        url: `https://${rawTarget}/v1/models`,
        opts: { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } },
      };
    },

    /**
     * Returns the model-list fetch config for /reflect model population, or null.
     * Uses the configured base path so prefixed OpenAI-compatible deployments
     * (e.g. Databricks, Azure) populate /reflect and models.json correctly.
     *
     * @returns {{ url: string, opts: object, cacheKey: string }|null}
     */
    getModelsFetchConfig() {
      if (!apiKey) return null;
      const modelsPath = basePath ? `${basePath}/models` : '/v1/models';
      return {
        url: `https://${rawTarget}${modelsPath}`,
        opts: { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } },
        cacheKey: 'openai',
      };
    },

    getReflectionInfo() {
      return {
        provider: 'openai',
        port: 10000,
        base_url: 'http://api-proxy:10000',
        configured: !!apiKey,
        models_cache_key: 'openai',
        models_url: 'http://api-proxy:10000/v1/models',
      };
    },

    /** Response returned when port 10000 receives a proxy request but no key is set. */
    getUnconfiguredResponse() {
      return {
        statusCode: 404,
        body: { error: 'OpenAI proxy not configured (no OPENAI_API_KEY)' },
      };
    },
  };
}

module.exports = { createOpenAIAdapter };
