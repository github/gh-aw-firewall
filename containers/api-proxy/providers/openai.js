'use strict';

/**
 * OpenAI provider adapter.
 *
 * Port: 10000  (also serves as the management port for /health, /metrics, /reflect)
 * Auth: Bearer token via Authorization header (static key or OIDC)
 * Credentials: OPENAI_API_KEY or AWF_AUTH_TYPE=github-oidc (for Azure Entra or native OpenAI WIF)
 * Target: OPENAI_API_TARGET  (default: api.openai.com)
 * Base path: OPENAI_API_BASE_PATH  (default: /v1 for the public endpoint)
 */

const {
  parseApiTargetAndBasePath,
} = require('../proxy-utils');
const { validateAuthHeaderEnv, buildOidcUnavailableScaffold } = require('../oidc-adapter-utils');
const { buildAuthHeaderFn, buildStaticAuthHeaderFn, validateAuthSchemeEnv } = require('./auth-headers');
const { composeBodyTransforms } = require('../proxy-utils');
const {
  parseCodexHostedWebPolicy,
  makeCodexHostedWebTransform,
} = require('../codex-hosted-web');

const { createStandardProviderAdapter } = require('../adapter-factory');
const { OPENAI_ENV, COPILOT_ENV } = require('../provider-env-constants');
const { bearerAuthHeaders } = require('./auth-headers');
const { matchesTargetOrigin } = require('./cloud-oidc-init');

/**
 * Create the OpenAI provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables (typically process.env)
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createOpenAIAdapter(env, deps = {}) {
  const providerType = (env[COPILOT_ENV.PROVIDER_TYPE] || '').trim().toLowerCase();
  const authType = (env.AWF_AUTH_TYPE || '').trim().toLowerCase();
  const authProvider = (env.AWF_AUTH_PROVIDER || 'azure').trim().toLowerCase();
  const openAiWifRequested = authType === 'github-oidc' && authProvider === 'openai';
  const databricksRequested = authType === 'github-oidc' && authProvider === 'databricks';
  const databricksSelected = databricksRequested && !!(env[OPENAI_ENV.TARGET] || '').trim();
  const staticAuthScheme = validateAuthSchemeEnv(OPENAI_ENV.AUTH_SCHEME, env[OPENAI_ENV.AUTH_SCHEME]);
  const copilotAzureByokEnabled = providerType === 'azure';
  const explicitAuthHeader = validateAuthHeaderEnv(OPENAI_ENV.AUTH_HEADER, env[OPENAI_ENV.AUTH_HEADER]);
  const customAuthHeader = (() => {
    if (explicitAuthHeader) return explicitAuthHeader;
    // Azure OpenAI BYOK uses `api-key` header instead of `Authorization: Bearer`
    // (but OIDC auth still requires `Authorization: Bearer` unless explicitly overridden)
    if (copilotAzureByokEnabled && (env.AWF_AUTH_TYPE || '').trim().toLowerCase() !== 'github-oidc') return 'api-key';
    return '';
  })();
  const copilotByokApiKey = (env[COPILOT_ENV.PROVIDER_API_KEY] || '').trim() || undefined;
  const { target: copilotByokTarget, basePath: copilotByokBasePath } = parseApiTargetAndBasePath(env[COPILOT_ENV.PROVIDER_BASE_URL]);

  const hostedWebPolicy = parseCodexHostedWebPolicy(env.AWF_CODEX_HOSTED_WEB_POLICY);

  // OIDC auth strategy (Azure OpenAI, AWS Bedrock, GCP Vertex AI)
  // Azure OpenAI BYOK uses the `api-key` header instead of `Authorization: Bearer`
  // (but OIDC auth still requires `Authorization: Bearer` unless explicitly overridden);
  // buildAuthHeaderFn centralises that "custom header vs. Bearer" branching.
  const buildTokenAuthHeaders = buildAuthHeaderFn({ headerName: customAuthHeader || undefined });
  const buildStaticAuthHeaders = buildStaticAuthHeaderFn({
    headerName: explicitAuthHeader,
    defaultHeaderName: customAuthHeader,
    scheme: staticAuthScheme,
  });
  return createStandardProviderAdapter(env, deps, {
    envVars: {
      keyEnvVar: OPENAI_ENV.KEY,
      targetEnvVar: OPENAI_ENV.TARGET,
      basePathEnvVar: OPENAI_ENV.BASE_PATH,
    },
    name: 'openai',
    port: 10000,
    defaultTarget: 'api.openai.com',
    isManagementPort: true,
    prepareConfig: ({ apiKey: openaiApiKey, rawTarget: openaiTarget, basePath: openaiBasePath, bodyTransform }) => {
      const explicitOpenAITarget = env[OPENAI_ENV.TARGET] ? openaiTarget : undefined;
      const rawTarget = explicitOpenAITarget || (copilotAzureByokEnabled && !databricksRequested ? copilotByokTarget : undefined) || 'api.openai.com';
      const useCopilotByok = copilotAzureByokEnabled && matchesTargetOrigin(rawTarget, copilotByokTarget);
      const apiKey = openaiApiKey || (useCopilotByok ? copilotByokApiKey : undefined);
      const explicitBasePath = openaiBasePath || (useCopilotByok ? copilotByokBasePath : '');
      const basePath = explicitBasePath || (rawTarget === 'api.openai.com' ? '/v1' : '');
      return {
        apiKey,
        rawTarget,
        basePath,
        bodyTransform: composeBodyTransforms(
          bodyTransform,
          makeCodexHostedWebTransform(hostedWebPolicy),
        ),
      };
    },
    createHeaderBuilders: ({ apiKey }) => {
      if (apiKey) buildStaticAuthHeaders(apiKey);
      return {
        buildOidcHeaders: openAiWifRequested || databricksRequested ? bearerAuthHeaders : buildTokenAuthHeaders,
        buildStaticHeaders: () => buildStaticAuthHeaders(apiKey),
      };
    },
    createOidcAuthOptions: () => ({
      allowOpenAiWif: openAiWifRequested,
      // Cloud OIDC tokens are only bound to an explicitly configured upstream
      // (OPENAI_API_TARGET or the Azure BYOK provider URL), never the default.
      allowCloudOidc: !!(env[OPENAI_ENV.TARGET] || (!databricksRequested && copilotAzureByokEnabled && copilotByokTarget)),
    }),
    createAdapterMethodsOptions: ({
      authProvider,
      oidcConfigured,
      oidcProvider,
      resolveHeaders,
      skipModelsFetch,
      buildStaticHeaders,
    }) => ({
      validationPath: '/v1/models',
      validationHeaders: openAiWifRequested || databricksSelected ? resolveHeaders : buildStaticHeaders,
      modelsPath: '/v1/models',
      modelsFetchHeaders: openAiWifRequested || databricksSelected ? resolveHeaders : buildStaticHeaders,
      skipModelsFetch: openAiWifRequested || databricksSelected
        ? () => !oidcConfigured || !oidcProvider?.isReady()
        : skipModelsFetch,
      reflectionModelsPath: '/v1/models',
      reflectionExtra: () => ({
        auth_type: oidcConfigured ? `github-oidc/${authProvider}` : 'static-key',
      }),
    }),
    buildAdapterOptions: ({ oidcConfigured }) => ({
      missingCredentialResponse: {
        kind: 'plain_error',
        statusCode: 404,
        message: 'OpenAI proxy not configured (no OPENAI_API_KEY/COPILOT_PROVIDER_API_KEY or OIDC auth)',
      },
      unconfiguredResponseWhen: buildOidcUnavailableScaffold({
        requested: openAiWifRequested || databricksSelected || oidcConfigured,
        configured: oidcConfigured,
        unavailableMessage: databricksRequested ? 'Databricks OIDC token unavailable; retry shortly' : 'OpenAI OIDC token unavailable; retry shortly',
        unconfiguredMessage: databricksRequested
          ? 'Databricks OIDC requires an explicit target matching the HTTPS workspace origin; first-party and conflicting targets are refused.'
          : 'OpenAI WIF requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (permissions: id-token: write), AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID, and AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID.',
      }).unconfiguredResponseWhen,
      extra: {
        /** Port 10000 always counts toward the startup validation latch. */
        participatesInValidation: true,
        _hostedWebPolicy: hostedWebPolicy,
      },
    }),
  });
}

module.exports = { createOpenAIAdapter };
