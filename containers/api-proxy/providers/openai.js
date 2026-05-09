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

const { createBaseAdapterConfig } = require('../proxy-utils');
const { OidcTokenProvider } = require('../oidc-token-provider');

/**
 * Create the OpenAI provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables (typically process.env)
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createOpenAIAdapter(env, deps = {}) {
  const { apiKey, rawTarget, basePath: explicitBasePath } = createBaseAdapterConfig(env, {
    keyEnvVar: 'OPENAI_API_KEY',
    targetEnvVar: 'OPENAI_API_TARGET',
    basePathEnvVar: 'OPENAI_API_BASE_PATH',
    defaultTarget: 'api.openai.com',
  });

  // For the default OpenAI endpoint, unversioned clients (e.g. Codex CLI sending
  // /responses) need a /v1 prefix to reach the correct versioned API surface.
  // Custom targets manage their own path layout and must not receive an implicit prefix.
  const basePath = explicitBasePath || (rawTarget === 'api.openai.com' ? '/v1' : '');

  const bodyTransform = deps.bodyTransform || null;

  // OIDC auth strategy (Azure OpenAI, AWS Bedrock, GCP Vertex AI)
  const authType = (env.AWF_AUTH_TYPE || '').trim().toLowerCase();
  const authProvider = (env.AWF_AUTH_PROVIDER || 'azure').trim().toLowerCase();
  let oidcProvider = null;
  let awsOidcProvider = null;
  if (authType === 'github-oidc') {
    const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    if (requestUrl && requestToken) {
      if (authProvider === 'aws') {
        const roleArn = env.AWF_AUTH_AWS_ROLE_ARN;
        const region = env.AWF_AUTH_AWS_REGION;
        if (roleArn && region) {
          const { AwsOidcTokenProvider } = require('../aws-oidc-token-provider');
          awsOidcProvider = new AwsOidcTokenProvider({
            requestUrl,
            requestToken,
            roleArn,
            region,
            roleSessionName: env.AWF_AUTH_AWS_ROLE_SESSION_NAME,
            oidcAudience: env.AWF_AUTH_OIDC_AUDIENCE,
          });
        }
      } else if (authProvider === 'gcp') {
        const workloadIdentityProvider = env.AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER;
        if (workloadIdentityProvider) {
          const { GcpOidcTokenProvider } = require('../gcp-oidc-token-provider');
          oidcProvider = new GcpOidcTokenProvider({
            requestUrl,
            requestToken,
            workloadIdentityProvider,
            serviceAccount: env.AWF_AUTH_GCP_SERVICE_ACCOUNT,
            oidcAudience: env.AWF_AUTH_OIDC_AUDIENCE,
            scope: env.AWF_AUTH_GCP_SCOPE,
          });
        }
      } else {
        // Azure (default)
        const tenantId = env.AWF_AUTH_AZURE_TENANT_ID;
        const clientId = env.AWF_AUTH_AZURE_CLIENT_ID;
        if (tenantId && clientId) {
          oidcProvider = new OidcTokenProvider({
            requestUrl,
            requestToken,
            tenantId,
            clientId,
            oidcAudience: env.AWF_AUTH_OIDC_AUDIENCE || 'api://AzureADTokenExchange',
            azureScope: env.AWF_AUTH_AZURE_SCOPE || 'https://cognitiveservices.azure.com/.default',
            azureCloud: env.AWF_AUTH_AZURE_CLOUD,
          });
        }
      }
    }
  }
  const oidcConfigured = !!(oidcProvider || awsOidcProvider);

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

    /** Port 10000 always counts toward the startup validation latch. */
    participatesInValidation: true,

    isEnabled() { return !!apiKey || !!oidcProvider?.isReady() || !!awsOidcProvider?.isReady(); },
    getTargetHost() { return rawTarget; },
    getBasePath() { return basePath; },

    /**
     * Get the OIDC token provider (Azure or GCP — Bearer-token compatible).
     * Used by server.js to initialize OIDC on startup.
     * @returns {OidcTokenProvider|GcpOidcTokenProvider|null}
     */
    getOidcProvider() { return oidcProvider; },

    /**
     * Get the AWS OIDC credential provider (SigV4-based).
     * Used by server.js to initialize AWS OIDC on startup and sign requests.
     * @returns {AwsOidcTokenProvider|null}
     */
    getAwsOidcProvider() { return awsOidcProvider; },

    getAuthHeaders() {
      // Bearer-token OIDC (Azure, GCP) takes precedence when configured
      if (oidcProvider) {
        const token = oidcProvider.getToken();
        if (token) {
          return { 'Authorization': `Bearer ${token}` };
        }
        return {};
      }
      // AWS OIDC: SigV4 signing is handled separately; return empty headers
      // so server.js can apply SigV4 signing to the finalized request.
      if (awsOidcProvider) {
        return {};
      }
      return { 'Authorization': `Bearer ${apiKey}` };
    },

    getBodyTransform() { return bodyTransform; },

    /**
     * Returns the validation probe config, or null to skip.
     * Custom targets are skipped — we don't know their probe endpoints.
     * OIDC-auth targets are skipped — validation requires an async token mint.
     *
     * @returns {{ url: string, opts: object }|{ skip: true, reason: string }|null}
     */
    getValidationProbe() {
      if (oidcConfigured) {
        return { skip: true, reason: 'OIDC auth; validation via token acquisition' };
      }
      if (!apiKey) return null;
      if (rawTarget !== 'api.openai.com') {
        return { skip: true, reason: `Custom target ${rawTarget}; validation skipped` };
      }
      return {
        url: `https://${rawTarget}/v1/models`,
        opts: { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } },
      };
    },

    /**
     * Returns the model-list fetch config for /reflect model population, or null.
     * Uses the configured base path so prefixed OpenAI-compatible deployments
     * (e.g. Databricks, Azure) populate /reflect and models.json correctly.
     *
     * @returns {{ url: string, opts: object, cacheKey: string }|null}
     */
    getModelsFetchConfig() {
      if (oidcConfigured) return null; // Models fetched after OIDC init
      if (!apiKey) return null;
      const modelsPath = basePath ? `${basePath}/models` : '/v1/models';
      return {
        url: `https://${rawTarget}${modelsPath}`,
        opts: { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } },
        cacheKey: 'openai',
      };
    },

    getReflectionInfo() {
      let authTypeLabel = 'static-key';
      if (oidcConfigured) {
        authTypeLabel = awsOidcProvider ? `github-oidc/${authProvider}` : `github-oidc/${authProvider}`;
      }
      return {
        provider: 'openai',
        port: 10000,
        base_url: 'http://api-proxy:10000',
        configured: !!apiKey || oidcConfigured,
        auth_type: oidcConfigured ? authTypeLabel : 'static-key',
        models_cache_key: 'openai',
        models_url: 'http://api-proxy:10000/v1/models',
      };
    },

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
        body: { error: 'OpenAI proxy not configured (no OPENAI_API_KEY or OIDC auth)' },
      };
    },
  };
}

module.exports = { createOpenAIAdapter };
