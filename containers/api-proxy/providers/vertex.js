'use strict';

/**
 * Google Vertex AI provider adapter.
 *
 * Port: 10004  (always bound — returns 503 when no key is configured)
 * Auth: x-goog-api-key header
 * Credentials: GOOGLE_API_KEY
 * Target: VERTEX_API_TARGET  (default: aiplatform.googleapis.com)
 * Base path: VERTEX_API_BASE_PATH
 *
 * Used by the Gemini CLI (google-gemini/gemini-cli) when authType === USE_VERTEX
 * (i.e. GOOGLE_GENAI_USE_VERTEXAI=true). Setting GOOGLE_VERTEX_BASE_URL routes
 * all Vertex AI traffic through the api-proxy sidecar instead of calling
 * aiplatform.googleapis.com directly, enabling credential isolation.
 *
 * All configuration lives in GOOGLE_PROVIDER_SPECS.vertex (google-provider-specs.js).
 */

const { createGoogleProviderAdapter } = require('./google-adapter');

/**
 * Create the Google Vertex AI provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform?: ((body: Buffer) => (Buffer | null | Promise<Buffer | null>))|null }} [deps={}] - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createVertexAdapter(env, deps = {}) {
  return createGoogleProviderAdapter('vertex', env, deps);
}

module.exports = { createVertexAdapter };
