'use strict';

/**
 * OpenAI provider adapter.
 *
 * Port: 10000  (also serves as the management port for /health, /metrics, /reflect)
 * Auth: Bearer token via Authorization header (static key or OIDC)
 * Credentials: OPENAI_API_KEY or AWF_AUTH_TYPE=github-oidc (for Azure OpenAI with Entra)
 * Target: OPENAI_API_TARGET  (default: api.openai.com)
 * Base path: OPENAI_API_BASE_PATH  (default: /v1 for the public endpoint)
 */

const {
  normalizeBasePath,
  parseApiTargetAndBasePath,
} = require('../proxy-utils');
const { validateAuthHeaderEnv } = require('../oidc-adapter-utils');

const { createProviderAuthScaffold, createAdapterMethods, buildProviderAdapter } = require('../adapter-factory');
const { createProviderOidcAuth } = require('./cloud-oidc-init');
const { OPENAI_ENV, COPILOT_ENV } = require('../provider-env-constants');

/**
 * Create the OpenAI provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables (typically process.env)
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createOpenAIAdapter(env, deps = {}) {
  const {
    apiKey: openaiApiKey,
    rawTarget: openaiTarget,
    basePath: openaiBasePath,
    bodyTransform,
  } = createProviderAuthScaffold(env, deps, {
    keyEnvVar: OPENAI_ENV.KEY,
    targetEnvVar: OPENAI_ENV.TARGET,
    basePathEnvVar: OPENAI_ENV.BASE_PATH,
    defaultTarget: 'api.openai.com',
  });
  const providerType = (env[COPILOT_ENV.PROVIDER_TYPE] || '').trim().toLowerCase();
  const copilotAzureByokEnabled = providerType === 'azure';
  const customAuthHeader = (() => {
    const header = validateAuthHeaderEnv(OPENAI_ENV.AUTH_HEADER, env[OPENAI_ENV.AUTH_HEADER]);
    if (header) return header;
    // Azure OpenAI BYOK uses `api-key` header instead of `Authorization: Bearer`
    // (but OIDC auth still requires `Authorization: Bearer` unless explicitly overridden)
    if (copilotAzureByokEnabled && (env.AWF_AUTH_TYPE || '').trim().toLowerCase() !== 'github-oidc') return 'api-key';
    return '';
  })();
  const copilotByokApiKey = (env[COPILOT_ENV.PROVIDER_API_KEY] || '').trim() || undefined;
  const { target: copilotByokTarget, basePath: copilotByokBasePath } = parseApiTargetAndBasePath(env[COPILOT_ENV.PROVIDER_BASE_URL]);

  const apiKey = openaiApiKey || (copilotAzureByokEnabled ? copilotByokApiKey : undefined);
  const explicitOpenAITarget = env[OPENAI_ENV.TARGET] ? openaiTarget : undefined;
  const rawTarget = explicitOpenAITarget || (copilotAzureByokEnabled ? copilotByokTarget : undefined) || 'api.openai.com';
  const explicitBasePath = openaiBasePath || (copilotAzureByokEnabled ? copilotByokBasePath : '');

  // For the default OpenAI endpoint, unversioned clients (e.g. Codex CLI sending
  // /responses) need a /v1 prefix to reach the correct versioned API surface.
  // Custom targets manage their own path layout and must not receive an implicit prefix.
  const basePath = explicitBasePath || (rawTarget === 'api.openai.com' ? '/v1' : '');

  // OIDC auth strategy (Azure OpenAI, AWS Bedrock, GCP Vertex AI)
  const {
    authProvider, oidcConfigured,
    runtimeMethods: oidcRuntimeMethods,
    validationSkip,
    skipModelsFetch,
    resolveAuthHeaders,
  } = createProviderOidcAuth(env, { staticAuthToken: apiKey });
  /**
   * Build a static-key auth header object.
   * When AWF_OPENAI_AUTH_HEADER is set, uses that header name with the raw key.
   * Otherwise uses the standard `Authorization: Bearer <key>` format.
   */
  function buildStaticAuthHeaders(key) {
    if (customAuthHeader) {
      return { [customAuthHeader]: key };
    }
    return { 'Authorization': `Bearer ${key}` };
  }

  const adapterMethods = createAdapterMethods({
    apiKey,
    rawTarget,
    basePath,
    provider: 'openai',
    port: 10000,
    defaultTarget: 'api.openai.com',
    validationPath: '/v1/models',
    validationHeaders: () => buildStaticAuthHeaders(apiKey),
    validationSkip,
    skipModelsFetch,
    modelsPath: '/v1/models',
    modelsFetchHeaders: () => buildStaticAuthHeaders(apiKey),
    reflectionConfigured: !!apiKey || oidcConfigured,
    reflectionModelsPath: '/v1/models',
    reflectionExtra: () => ({
      auth_type: oidcConfigured ? `github-oidc/${authProvider}` : 'static-key',
    }),
  });

  return buildProviderAdapter({
    name: 'openai',
    port: 10000,
    isManagementPort: true,
    adapterMethods,
    getAuthHeaders() {
      return resolveAuthHeaders(
        (token) => (customAuthHeader
          ? { [customAuthHeader]: token }
          : { 'Authorization': ['Bearer', token].join(' ') }),
        buildStaticAuthHeaders(apiKey),
      );
    },
    bodyTransform,
    /** Response returned when port 10000 receives a proxy request but no key is set. */
    getUnconfiguredResponse() {
      if (oidcConfigured) {
        return {
          statusCode: 503,
          body: { error: 'OpenAI OIDC token unavailable; retry shortly' },
        };
      }
      return {
        statusCode: 404,
        body: { error: 'OpenAI proxy not configured (no OPENAI_API_KEY/COPILOT_PROVIDER_API_KEY or OIDC auth)' },
      };
    },
    extra: {
      ...oidcRuntimeMethods,
      /** Port 10000 always counts toward the startup validation latch. */
      participatesInValidation: true,
    },
  });
}

module.exports = { createOpenAIAdapter };
