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

const { stripGeminiKeyParam } = require('../proxy-utils');
const { GEMINI_ENV } = require('../provider-env-constants');
const { createGoogleApiKeyAdapter } = require('./google-adapter');

/**
 * Create the Google Gemini provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform?: ((body: Buffer) => (Buffer | null | Promise<Buffer | null>))|null }} [deps={}] - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createGeminiAdapter(env, deps = {}) {
  return createGoogleApiKeyAdapter(env, deps, {
    name: 'gemini',
    port: 10003,
    envConstants: GEMINI_ENV,
    defaultTarget: 'generativelanguage.googleapis.com',
    validationPath: '/v1beta/models',
    modelsPath: '/v1beta/models',
    healthServiceName: 'awf-api-proxy-gemini',
    unconfiguredErrorMessage: 'Gemini proxy not configured (no GEMINI_API_KEY). Set GEMINI_API_KEY in the AWF runner environment to enable credential isolation.',
    healthErrorMessage: 'GEMINI_API_KEY not configured in api-proxy sidecar',
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
  });
}

module.exports = { createGeminiAdapter };
