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
 */

const { VERTEX_ENV } = require('../provider-env-constants');
const { createGoogleApiKeyAdapter } = require('./google-adapter');

/**
 * Create the Google Vertex AI provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform?: ((body: Buffer) => (Buffer | null | Promise<Buffer | null>))|null }} [deps={}] - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createVertexAdapter(env, deps = {}) {
  return createGoogleApiKeyAdapter(env, deps, {
    name: 'vertex',
    port: 10004,
    envConstants: VERTEX_ENV,
    defaultTarget: 'aiplatform.googleapis.com',
    validationPath: '/v1/projects',
    modelsPath: null,
    healthServiceName: 'awf-api-proxy-vertex',
    unconfiguredErrorMessage: 'Vertex AI proxy not configured (no GOOGLE_API_KEY). Set GOOGLE_API_KEY in the AWF runner environment to enable credential isolation.',
    healthErrorMessage: 'GOOGLE_API_KEY not configured in api-proxy sidecar',
  });
}

module.exports = { createVertexAdapter };
