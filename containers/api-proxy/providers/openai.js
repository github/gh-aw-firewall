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
  validateAuthHeaderEnv,
  createOidcRuntimeAdapterMethods,
  resolveOidcAuthHeaders,
} = require('../proxy-utils');
const { createBaseAdapterConfig, createAdapterMethods } = require('../adapter-factory');
const { resolveCloudOidcProviders } = require('./cloud-oidc-init');

function parseByokBaseUrl(baseUrl) {
  if (!baseUrl) return { target: undefined, basePath: '' };
  const trimmed = baseUrl.trim();
  if (!trimmed) return { target: undefined, basePath: '' };

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return {
      target: parsed.hostname || undefined,
      basePath: normalizeBasePath(parsed.pathname),
    };
  } catch {
    return { target: undefined, basePath: '' };
  }
}

/**
 * Create the OpenAI provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables (typically process.env)
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createOpenAIAdapter(env, deps = {}) {
  const { apiKey: openaiApiKey, rawTarget: openaiTarget, basePath: openaiBasePath } = createBaseAdapterConfig(env, {
    keyEnvVar: 'OPENAI_API_KEY',
    targetEnvVar: 'OPENAI_API_TARGET',
    basePathEnvVar: 'OPENAI_API_BASE_PATH',
    defaultTarget: 'api.openai.com',
  });
  const providerType = (env.COPILOT_PROVIDER_TYPE || '').trim().toLowerCase();
  const copilotAzureByokEnabled = providerType === 'azure';
  const customAuthHeader = (() => {
    const header = validateAuthHeaderEnv('AWF_OPENAI_AUTH_HEADER', env.AWF_OPENAI_AUTH_HEADER);
    if (header) return header;
    // Azure OpenAI BYOK uses `api-key` header instead of `Authorization: Bearer`
    // (but OIDC auth still requires `Authorization: Bearer` unless explicitly overridden)
    if (copilotAzureByokEnabled && (env.AWF_AUTH_TYPE || '').trim().toLowerCase() !== 'github-oidc') return 'api-key';
    return '';
  })();
  const copilotByokApiKey = (env.COPILOT_PROVIDER_API_KEY || '').trim() || undefined;
  const { target: copilotByokTarget, basePath: copilotByokBasePath } = parseByokBaseUrl(env.COPILOT_PROVIDER_BASE_URL);

  const apiKey = openaiApiKey || (copilotAzureByokEnabled ? copilotByokApiKey : undefined);
  const explicitOpenAITarget = env.OPENAI_API_TARGET ? openaiTarget : undefined;
  const rawTarget = explicitOpenAITarget || (copilotAzureByokEnabled ? copilotByokTarget : undefined) || 'api.openai.com';
  const explicitBasePath = openaiBasePath || (copilotAzureByokEnabled ? copilotByokBasePath : '');

  // For the default OpenAI endpoint, unversioned clients (e.g. Codex CLI sending
  // /responses) need a /v1 prefix to reach the correct versioned API surface.
  // Custom targets manage their own path layout and must not receive an implicit prefix.
  const basePath = explicitBasePath || (rawTarget === 'api.openai.com' ? '/v1' : '');

  const bodyTransform = deps.bodyTransform || null;

  // OIDC auth strategy (Azure OpenAI, AWS Bedrock, GCP Vertex AI)
  const { authProvider, oidcProvider, awsOidcProvider, oidcConfigured } = resolveCloudOidcProviders(env);
  const oidcRuntimeMethods = createOidcRuntimeAdapterMethods({
    staticAuthToken: apiKey,
    oidcProvider,
    awsOidcProvider,
  });
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
    validationSkip: () => (oidcConfigured
      ? { skip: true, reason: 'OIDC auth; validation via token acquisition' }
      : null),
    skipModelsFetch: () => oidcConfigured, // Models fetched after OIDC init
    modelsPath: '/v1/models',
    modelsFetchHeaders: () => buildStaticAuthHeaders(apiKey),
    reflectionConfigured: !!apiKey || oidcConfigured,
    reflectionModelsPath: '/v1/models',
    reflectionExtra: () => ({
      auth_type: oidcConfigured ? `github-oidc/${authProvider}` : 'static-key',
    }),
  });

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

    ...oidcRuntimeMethods,

    getAuthHeaders() {
      const oidcHeaders = resolveOidcAuthHeaders({
        oidcProvider,
        awsOidcProvider,
        buildOidcHeaders: (token) => (customAuthHeader
          ? { [customAuthHeader]: token }
          : { 'Authorization': ['Bearer', token].join(' ') }),
      });
      if (oidcHeaders !== null) {
        return oidcHeaders;
      }
      return buildStaticAuthHeaders(apiKey);
    },

    getBodyTransform() { return bodyTransform; },
    ...adapterMethods,

    /** Port 10000 always counts toward the startup validation latch. */
    participatesInValidation: true,

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
  };
}

module.exports = { createOpenAIAdapter };
