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
 *
 * All configuration lives in GOOGLE_PROVIDER_SPECS.gemini (google-provider-specs.js).
 */

const { createGoogleProviderAdapter } = require('./google-adapter');

/**
 * Create the Google Gemini provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform?: ((body: Buffer) => (Buffer | null | Promise<Buffer | null>))|null }} [deps={}] - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createGeminiAdapter(env, deps = {}) {
  return createGoogleProviderAdapter('gemini', env, deps);
}

module.exports = { createGeminiAdapter };
