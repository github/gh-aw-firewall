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

const { createProviderAuthScaffold, createAdapterMethods, buildProviderAdapter } = require('../adapter-factory');
const { VERTEX_ENV } = require('../provider-env-constants');
const { providerKeyHeaders } = require('./auth-headers');

/**
 * Create the Google Vertex AI provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createVertexAdapter(env, deps = {}) {
  const { apiKey, rawTarget, basePath, bodyTransform } = createProviderAuthScaffold(env, deps, {
    keyEnvVar: VERTEX_ENV.KEY,
    targetEnvVar: VERTEX_ENV.TARGET,
    basePathEnvVar: VERTEX_ENV.BASE_PATH,
    defaultTarget: 'aiplatform.googleapis.com',
  });
  const buildAuthHeaders = () => providerKeyHeaders('x-goog-api-key', apiKey);

  const adapterMethods = createAdapterMethods({
    apiKey,
    rawTarget,
    basePath,
    provider: 'vertex',
    port: 10004,
    defaultTarget: 'aiplatform.googleapis.com',
    validationPath: '/v1/projects',
    validationHeaders: buildAuthHeaders,
    modelsPath: null,
    modelsFetchHeaders: null,
  });

  return buildProviderAdapter({
    name: 'vertex',
    port: 10004,
    isManagementPort: false,
    alwaysBind: true,
    adapterMethods,
    getAuthHeaders() {
      return buildAuthHeaders();
    },
    bodyTransform,
    isEnabled() { return !!apiKey; },
    /** Response returned for all requests when no GOOGLE_API_KEY is configured. */
    getUnconfiguredResponse() {
      return {
        statusCode: 503,
        body: { error: 'Vertex AI proxy not configured (no GOOGLE_API_KEY). Set GOOGLE_API_KEY in the AWF runner environment to enable credential isolation.' },
      };
    },
    healthServiceName: 'awf-api-proxy-vertex',
    missingCredentialMessage: 'GOOGLE_API_KEY not configured in api-proxy sidecar',
  });
}

module.exports = { createVertexAdapter };
