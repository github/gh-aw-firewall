'use strict';

/**
 * Shared factory for Google API-key–based provider adapters (Gemini, Vertex).
 *
 * Both providers authenticate via the `x-goog-api-key` header and share the
 * same scaffold: createProviderAuthScaffold, createAdapterMethods, and
 * buildProviderAdapter.  This factory centralises that boilerplate so each
 * provider only supplies its name, port, env constants, target, paths, and
 * error messages.
 */

const { makeUnconfiguredHealthResponse } = require('../proxy-utils');
const { createProviderAuthScaffold, createAdapterMethods, buildProviderAdapter } = require('../adapter-factory');
const { providerKeyHeaders } = require('./auth-headers');
const { GOOGLE_PROVIDER_SPECS } = require('./google-provider-specs');

/**
 * Create a Google API-key–based provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform?: ((body: Buffer) => (Buffer | null | Promise<Buffer | null>))|null }} [deps={}] - Injected dependencies
 * @param {object} opts
 * @param {string} opts.name                    - Provider slug (e.g. 'gemini')
 * @param {number} opts.port                    - Proxy port (e.g. 10003)
 * @param {{ KEY: string, TARGET: string, BASE_PATH: string }} opts.envConstants - Env var name constants
 * @param {string} opts.defaultTarget           - Default upstream hostname
 * @param {string} opts.validationPath          - URL path for health/validation probe
 * @param {string|null} opts.modelsPath         - URL path for models fetch, or null if unsupported
 * @param {string} opts.healthServiceName       - Service name for health response (e.g. 'awf-api-proxy-gemini')
 * @param {string} opts.unconfiguredErrorMessage - Error body when no API key is configured
 * @param {string} opts.healthErrorMessage      - Health error message when not configured
 * @param {((url: string) => string)} [opts.transformRequestUrl] - Optional URL transformer
 * @returns {import('./index').ProviderAdapter}
 */
function createGoogleApiKeyAdapter(env, deps = {}, opts) {
  const {
    name,
    port,
    envConstants,
    defaultTarget,
    validationPath,
    modelsPath,
    healthServiceName,
    unconfiguredErrorMessage,
    healthErrorMessage,
    transformRequestUrl,
  } = opts;

  const { apiKey, rawTarget, basePath, bodyTransform } = createProviderAuthScaffold(env, deps, {
    keyEnvVar: envConstants.KEY,
    targetEnvVar: envConstants.TARGET,
    basePathEnvVar: envConstants.BASE_PATH,
    defaultTarget,
  });
  const buildAuthHeaders = () => providerKeyHeaders('x-goog-api-key', apiKey);

  const adapterMethods = createAdapterMethods({
    apiKey,
    rawTarget,
    basePath,
    provider: name,
    port,
    defaultTarget,
    validationPath,
    validationHeaders: buildAuthHeaders,
    modelsPath,
    modelsFetchHeaders: modelsPath ? buildAuthHeaders : null,
  });

  return buildProviderAdapter({
    name,
    port,
    isManagementPort: false,
    adapterMethods,
    getAuthHeaders() {
      return buildAuthHeaders();
    },
    bodyTransform,
    isEnabled() { return !!apiKey; },
    ...(transformRequestUrl !== undefined ? { transformRequestUrl } : {}),
    /** Response returned for all requests when no API key is configured. */
    getUnconfiguredResponse() {
      return {
        statusCode: 503,
        body: { error: unconfiguredErrorMessage },
      };
    },
    /** /health response when not configured. */
    getUnconfiguredHealthResponse() {
      return makeUnconfiguredHealthResponse(healthServiceName, healthErrorMessage);
    },
  });
}

/**
 * Create a Google provider adapter from its declarative spec.
 *
 * Error/health messaging is derived from the spec so each Google-family
 * provider only needs a config entry in GOOGLE_PROVIDER_SPECS.
 *
 * @param {string} providerKey - Key into GOOGLE_PROVIDER_SPECS (e.g. 'gemini')
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform?: ((body: Buffer) => (Buffer | null | Promise<Buffer | null>))|null }} [deps={}] - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createGoogleProviderAdapter(providerKey, env, deps = {}) {
  const spec = GOOGLE_PROVIDER_SPECS[providerKey];
  if (!spec) {
    throw new Error(`Unknown Google provider spec: ${providerKey}`);
  }

  const keyEnvVar = spec.envConstants.KEY;

  return createGoogleApiKeyAdapter(env, deps, {
    name: spec.name,
    port: spec.port,
    envConstants: spec.envConstants,
    defaultTarget: spec.defaultTarget,
    validationPath: spec.validationPath,
    modelsPath: spec.modelsPath,
    healthServiceName: `awf-api-proxy-${spec.name}`,
    unconfiguredErrorMessage: `${spec.label} proxy not configured (no ${keyEnvVar}). Set ${keyEnvVar} in the AWF runner environment to enable credential isolation.`,
    healthErrorMessage: `${keyEnvVar} not configured in api-proxy sidecar`,
    ...(spec.transformRequestUrl !== undefined ? { transformRequestUrl: spec.transformRequestUrl } : {}),
  });
}

module.exports = { createGoogleApiKeyAdapter, createGoogleProviderAdapter };
