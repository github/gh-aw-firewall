'use strict';

/**
 * Google Gemini provider adapter.
 *
 * Port: 10003  (always bound — returns 503 when no key is configured)
 * Auth: x-goog-api-key header
 * Credentials: GEMINI_API_KEY
 * Target: GEMINI_API_TARGET  (default: generativelanguage.googleapis.com)
 * Base path: GEMINI_API_BASE_PATH
 *
 * URL transform: strips ?key=, ?apiKey=, ?api_key= query params that some
 *   Gemini SDK versions append alongside the header.
 */

const { stripGeminiKeyParam, createBaseAdapterConfig } = require('../proxy-utils');

/**
 * Create the Google Gemini provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createGeminiAdapter(env, deps = {}) {
  const { apiKey, rawTarget, basePath } = createBaseAdapterConfig(env, {
    keyEnvVar: 'GEMINI_API_KEY',
    targetEnvVar: 'GEMINI_API_TARGET',
    basePathEnvVar: 'GEMINI_API_BASE_PATH',
    defaultTarget: 'generativelanguage.googleapis.com',
  });

  const bodyTransform = deps.bodyTransform || null;

  return {
    name: 'gemini',
    port: 10003,
    isManagementPort: false,

    /**
     * Port 10003 always starts so the Gemini CLI gets a clear 503 "not configured"
     * error rather than a silent connection-refused.
     */
    alwaysBind: true,

    /**
     * The 503-fallback server does NOT count toward the startup validation latch —
     * only the fully-configured server (when GEMINI_API_KEY is set) does.
     */
    get participatesInValidation() { return this.isEnabled(); },

    isEnabled() { return !!apiKey; },
    getTargetHost() { return rawTarget; },
    getBasePath() { return basePath; },

    getAuthHeaders() {
      return { 'x-goog-api-key': apiKey };
    },

    /**
     * Strip Gemini SDK auth query parameters before forwarding.
     * The SDK injects ?key= (or ?apiKey=, ?api_key=) alongside the header;
     * forwarding both causes API_KEY_INVALID errors on the upstream.
     *
     * @param {string} url
     * @returns {string}
     */
    transformRequestUrl(url) {
      return stripGeminiKeyParam(url);
    },

    getBodyTransform() { return bodyTransform; },

    getValidationProbe() {
      if (!apiKey) return null;
      if (rawTarget !== 'generativelanguage.googleapis.com') {
        return { skip: true, reason: `Custom target ${rawTarget}; validation skipped` };
      }
      return {
        url: `https://${rawTarget}/v1beta/models`,
        opts: { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
      };
    },

    getModelsFetchConfig() {
      if (!apiKey) return null;
      // Use the configured base path so Gemini-compatible endpoints with a
      // path prefix populate /reflect and models.json correctly.
      const modelsPath = basePath ? `${basePath}/models` : '/v1beta/models';
      return {
        url: `https://${rawTarget}${modelsPath}`,
        opts: { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
        cacheKey: 'gemini',
      };
    },

    getReflectionInfo() {
      return {
        provider: 'gemini',
        port: 10003,
        base_url: 'http://api-proxy:10003',
        configured: !!apiKey,
        models_cache_key: 'gemini',
        models_url: 'http://api-proxy:10003/v1beta/models',
      };
    },

    /** Response returned for all requests when no GEMINI_API_KEY is configured. */
    getUnconfiguredResponse() {
      return {
        statusCode: 503,
        body: { error: 'Gemini proxy not configured (no GEMINI_API_KEY). Set GEMINI_API_KEY in the AWF runner environment to enable credential isolation.' },
      };
    },

    /** /health response when not configured. */
    getUnconfiguredHealthResponse() {
      return {
        statusCode: 503,
        body: { status: 'not_configured', service: 'awf-api-proxy-gemini', error: 'GEMINI_API_KEY not configured in api-proxy sidecar' },
      };
    },
  };
}

module.exports = { createGeminiAdapter };
