'use strict';

/**
 * Shared factory for Google provider adapters (Gemini, Vertex).
 *
 * Both providers support static API keys via `x-goog-api-key` and GCP
 * Workload Identity Federation via a bearer Authorization header.
 */

const { createProviderAuthScaffold, createOidcAwareProviderAdapter } = require('../adapter-factory');
const { bearerAuthHeaders, providerKeyHeaders } = require('./auth-headers');
const { GOOGLE_PROVIDER_SPECS } = require('./google-provider-specs');
const { buildOidcUnavailableScaffold } = require('../oidc-adapter-utils');

function isGcpOidcRequested(env) {
  return (env.AWF_AUTH_TYPE || '').trim().toLowerCase() === 'github-oidc'
    && (env.AWF_AUTH_PROVIDER || '').trim().toLowerCase() === 'gcp';
}

/**
 * Create a Google provider adapter with static API-key and GCP WIF auth support.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform?: ((body: Buffer) => (Buffer | null | Promise<Buffer | null>))|null }} [deps={}] - Injected dependencies
 * @param {object} opts
 * @param {string} opts.name                    - Provider slug (e.g. 'gemini')
 * @param {string} opts.label                   - Human-readable provider label
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
function createGoogleAuthAdapter(env, deps = {}, opts) {
  const {
    name,
    label,
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
  const buildStaticHeaders = () => providerKeyHeaders('x-goog-api-key', apiKey);
  const gcpOidcRequested = isGcpOidcRequested(env);

  return createOidcAwareProviderAdapter({
    env,
    oidcAuthOptions: { staticAuthToken: apiKey, skipWhen: !gcpOidcRequested },
    buildOidcHeaders: bearerAuthHeaders,
    buildStaticHeaders,
    createAdapterMethodsOptions: ({ authProvider, oidcConfigured, validationSkip, skipModelsFetch }) => ({
      apiKey,
      rawTarget,
      basePath,
      provider: name,
      port,
      defaultTarget,
      validationPath,
      validationHeaders: buildStaticHeaders,
      validationSkip,
      skipModelsFetch,
      modelsPath,
      modelsFetchHeaders: modelsPath ? buildStaticHeaders : null,
      credentialConfigured: !!apiKey || oidcConfigured,
      reflectionConfigured: !!apiKey || oidcConfigured,
      reflectionExtra: () => ({
        auth_type: oidcConfigured ? `github-oidc/${authProvider}` : 'static-key',
      }),
    }),
    buildAdapterOptions: ({ authProvider, oidcConfigured, oidcProvider }) => {
      // When GCP WIF was requested but could not be initialised (missing
      // ACTIONS_ID_TOKEN_REQUEST_* or workload identity provider), report the
      // incomplete configuration instead of falling through to the
      // static-key-only message.
      const oidcScaffold = buildOidcUnavailableScaffold({
        requested: gcpOidcRequested,
        configured: oidcConfigured,
        unavailableMessage: `${label} OIDC token (${authProvider}) unavailable; retry shortly`,
        unconfiguredMessage: `${label} GCP OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (permissions: id-token: write) plus AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER.`,
      });
      return {
        name,
        port,
        isManagementPort: false,
        bodyTransform,
        missingCredentialResponse: {
          kind: 'plain_error',
          statusCode: 503,
          message: unconfiguredErrorMessage,
        },
        unconfiguredResponseWhen: oidcScaffold.unconfiguredResponseWhen,
        healthServiceName,
        missingCredentialMessage: healthErrorMessage,
        unavailableWhen: oidcScaffold.unavailableWhen,
        ...(transformRequestUrl !== undefined ? { transformRequestUrl } : {}),
        extra: {
          _oidcProvider: oidcProvider,
        },
      };
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

  return createGoogleAuthAdapter(env, deps, {
    name: spec.name,
    label: spec.label,
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

/**
 * Create a named Google provider adapter factory.
 *
 * @param {string} providerKey - Key into GOOGLE_PROVIDER_SPECS (e.g. 'gemini')
 * @returns {(env: Record<string, string|undefined>, deps?: { bodyTransform?: ((body: Buffer) => (Buffer | null | Promise<Buffer | null>))|null }) => import('./index').ProviderAdapter}
 */
function makeGoogleProviderFactory(providerKey) {
  return (env, deps = {}) => createGoogleProviderAdapter(providerKey, env, deps);
}

const GOOGLE_PROVIDER_ADAPTER_FACTORIES = Object.fromEntries(
  Object.keys(GOOGLE_PROVIDER_SPECS).map((providerKey) => [
    providerKey,
    makeGoogleProviderFactory(providerKey),
  ]),
);

module.exports = {
  createGoogleAuthAdapter,
  createGoogleProviderAdapter,
  makeGoogleProviderFactory,
  GOOGLE_PROVIDER_ADAPTER_FACTORIES,
};
