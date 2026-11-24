'use strict';

const { OidcTokenProvider } = require('../oidc-token-provider');
const {
  createOidcRuntimeAdapterMethods,
  resolveAuthHeadersWithFallback,
} = require('../oidc-adapter-utils');
const { getTargetHostname } = require('../proxy-utils');
const { logRequest } = require('../logging');

const CLOUD_OIDC_PROVIDERS = new Set(['azure', 'aws', 'gcp', 'databricks']);

function targetOrigin(target) {
  if (typeof target !== 'string' || !target.trim()) return null;
  const value = target.trim();
  try {
    const url = new URL(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function matchesTargetOrigin(target, configuredTarget) {
  const origin = targetOrigin(target);
  return !!origin && origin === targetOrigin(configuredTarget);
}

function explicitCloudOidcTargets(env) {
  return [
    env.OPENAI_API_TARGET,
    env.ANTHROPIC_API_TARGET,
    env.COPILOT_API_TARGET,
    env.GEMINI_API_TARGET,
    env.VERTEX_API_TARGET,
  ].filter(value => typeof value === 'string' && value.trim());
}

function hasSelectedCloudOidcTarget(env) {
  return !!(env.COPILOT_PROVIDER_BASE_URL || '').trim() || explicitCloudOidcTargets(env).length > 0;
}

function isSelectedCloudOidcTarget(env, targetHost) {
  const byokTarget = (env.COPILOT_PROVIDER_BASE_URL || '').trim();
  if (byokTarget) return matchesTargetOrigin(targetHost, byokTarget);

  const targets = explicitCloudOidcTargets(env);
  if (!targets.length) return true;
  const origins = targets.map(targetOrigin);
  return origins.every(origin => origin && origin === origins[0])
    && matchesTargetOrigin(targetHost, targets[0]);
}

/**
 * Hosts operated by first-party model providers that never accept
 * cloud-issued (Azure/AWS/GCP) workload identity tokens.
 */
const CLOUD_OIDC_DENIED_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'githubcopilot.com',
]);

/**
 * Return true when a cloud-issued OIDC token may be attached to requests for
 * `targetHost`. First-party OpenAI, Anthropic and GitHub Copilot hosts are
 * rejected; unparseable or empty targets are rejected (fail closed).
 *
 * @param {string|undefined} targetHost
 * @returns {boolean}
 */
function isCloudOidcTargetAllowed(targetHost) {
  const hostname = (getTargetHostname(targetHost) || '').toLowerCase().replace(/\.$/, '');
  if (!hostname) return false;
  if (CLOUD_OIDC_DENIED_HOSTS.has(hostname)) return false;
  if (hostname.endsWith('.githubcopilot.com')) return false;
  if (hostname.startsWith('copilot-api.') && hostname.endsWith('.ghe.com')) return false;
  return true;
}

/**
 * @typedef {object} OidcAuthProvider
 * @property {() => boolean} isReady
 * @property {() => string} getToken
 */

/**
 * Resolve cloud and native OpenAI OIDC providers from environment variables.
 *
 * Cloud providers (Azure/AWS/GCP) are opt-in per adapter: they are only
 * resolved when the caller sets `allowCloudOidc` (the adapter's upstream is the
 * explicitly configured cloud target), `targetHost` passes
 * `isCloudOidcTargetAllowed`, and it matches the selected upstream origin.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ skipWhen?: boolean, allowOpenAiWif?: boolean, allowCloudOidc?: boolean, targetHost?: string, adapterName?: string }} [options]
 * @returns {{ authProvider: string, oidcProvider: any, awsOidcProvider: any, oidcConfigured: boolean }}
 */
function resolveCloudOidcProviders(env, options = {}) {
  const {
    skipWhen = false,
    allowOpenAiWif = false,
    allowCloudOidc = false,
    targetHost = undefined,
    adapterName = undefined,
  } = options;
  const authType = (env.AWF_AUTH_TYPE || '').trim().toLowerCase();
  const authProvider = (env.AWF_AUTH_PROVIDER || 'azure').trim().toLowerCase();
  let oidcProvider = null;
  let awsOidcProvider = null;

  let databricksConfig, databricksProvider;
  if (authType === 'github-oidc' && authProvider === 'databricks' && !skipWhen) {
    const { DatabricksOidcTokenProvider } = require('../databricks-oidc-token-provider');
    databricksConfig = {
      host: env.AWF_AUTH_DATABRICKS_HOST,
      clientId: env.AWF_AUTH_DATABRICKS_CLIENT_ID,
      oidcAudience: env.AWF_AUTH_OIDC_AUDIENCE,
      requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
      requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    };
    // Validate even on unbound adapters: incomplete configuration must not fall back to static auth.
    databricksProvider = new DatabricksOidcTokenProvider(databricksConfig);
  }

  let cloudOidcPermitted = true;
  if (authType === 'github-oidc' && !skipWhen && CLOUD_OIDC_PROVIDERS.has(authProvider)) {
    if (!allowCloudOidc) {
      cloudOidcPermitted = false;
      logRequest('info', 'cloud_oidc_not_bound', {
        message: `${authProvider} OIDC is not bound to this adapter; upstream is not the configured cloud target`,
        adapter: adapterName,
        target: databricksConfig ? undefined : targetHost,
      });
    } else if (!isCloudOidcTargetAllowed(targetHost)) {
      cloudOidcPermitted = false;
      logRequest('warn', 'cloud_oidc_target_refused', {
        message: `Refusing to attach ${authProvider} OIDC token to a non-${authProvider} upstream`,
        adapter: adapterName,
        target: databricksConfig ? undefined : targetHost,
      });
    } else if (!isSelectedCloudOidcTarget(env, targetHost)) {
      cloudOidcPermitted = false;
      logRequest('info', 'cloud_oidc_not_bound', {
        message: `${authProvider} OIDC is not bound to this adapter; upstream is not the configured cloud target`,
        adapter: adapterName,
        target: databricksConfig ? undefined : targetHost,
      });
    }
    const databricksTargets = databricksConfig
      ? [...explicitCloudOidcTargets(env), env.COPILOT_PROVIDER_BASE_URL]
        .filter(value => typeof value === 'string' && value.trim())
      : [];
    if (cloudOidcPermitted && databricksConfig
      && (!databricksTargets.length
        || !databricksTargets.every(target => matchesTargetOrigin(target, databricksConfig.host))
        || !matchesTargetOrigin(targetHost, databricksConfig.host))) {
      cloudOidcPermitted = false;
      logRequest('warn', 'cloud_oidc_target_refused', {
        message: 'Databricks OIDC requires an explicit target matching the workspace origin',
        adapter: adapterName,
      });
    }
  }

  if (authType === 'github-oidc' && !skipWhen && cloudOidcPermitted) {
    const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    if (requestUrl && requestToken) {
      if (authProvider === 'databricks') {
        oidcProvider = databricksProvider;
      } else if (authProvider === 'aws') {
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
      } else if (authProvider === 'openai' && allowOpenAiWif) {
        const identityProviderId = env.AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID;
        const serviceAccountId = env.AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID;
        if (identityProviderId && serviceAccountId) {
          const { OpenAIOidcTokenProvider } = require('../openai-oidc-token-provider');
          oidcProvider = new OpenAIOidcTokenProvider({
            requestUrl,
            requestToken,
            identityProviderId,
            serviceAccountId,
            oidcAudience: env.AWF_AUTH_OIDC_AUDIENCE,
          });
        }
      } else if (authProvider === 'azure') {
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

  if (databricksProvider && !oidcProvider) databricksProvider.shutdown();
  return {
    authProvider,
    oidcProvider,
    awsOidcProvider,
    oidcConfigured: !!(oidcProvider || awsOidcProvider),
  };
}

/**
 * Create the OIDC auth bundle for a provider adapter.
 *
 * Bundles provider resolution, runtime adapter methods, and header-resolution
 * helpers into a single call so each provider adapter does not need to repeat
 * the same three-step OIDC setup.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {object} [options]
 * @param {string|undefined} [options.staticAuthToken]
 *   Static credential used by `runtimeMethods.isEnabled()`.
 * @param {boolean} [options.skipWhen=false]
 *   Skip cloud OIDC initialisation (e.g. when static auth takes precedence).
 *   Only used when `oidcProviderFactory` is not provided.
 * @param {boolean} [options.allowOpenAiWif=false]
 *   Allow native OpenAI WIF initialization for the OpenAI adapter only.
 * @param {boolean} [options.allowCloudOidc=false]
 *   Bind Azure/AWS/GCP OIDC to this adapter. Set only when the adapter's
 *   upstream is the explicitly configured cloud target.
 * @param {string} [options.targetHost]
 *   The adapter's upstream target, checked by `isCloudOidcTargetAllowed`.
 * @param {string} [options.adapterName]
 *   Adapter name used in refusal logs.
 * @param {((env: Record<string, string|undefined>) => OidcAuthProvider|null|undefined)|null} [options.oidcProviderFactory]
 *   Optional factory for providers that use a custom OIDC token class (e.g.
 *   Anthropic). When provided, takes precedence over `resolveCloudOidcProviders`.
 *   The factory receives `env` and should return a provider instance or
 *   `null`/`undefined` when not configured. Returned providers must implement
 *   `isReady()` and `getToken()`.
 * @returns {{
 *   authProvider: string,
 *   oidcProvider: any,
 *   awsOidcProvider: any,
 *   oidcConfigured: boolean,
 *   runtimeMethods: { isEnabled: () => boolean, getOidcProvider: () => any, getAwsOidcProvider: () => any, getRequestSigner: () => (Function|null) },
 *   validationSkip: () => ({ skip: true, reason: string }|null),
 *   skipModelsFetch: () => boolean,
 *   resolveAuthHeaders: (buildOidcHeaders: (token: string) => Record<string, string>, staticHeaders: Record<string, string>) => Record<string, string>,
 * }}
 */
function createProviderOidcAuth(env, {
  staticAuthToken = undefined,
  skipWhen = false,
  allowOpenAiWif = false,
  allowCloudOidc = false,
  targetHost = undefined,
  adapterName = undefined,
  oidcProviderFactory = null,
} = {}) {
  let authProvider, oidcProvider, awsOidcProvider, oidcConfigured;

  if (typeof oidcProviderFactory === 'function') {
    authProvider = (env.AWF_AUTH_PROVIDER || '').trim().toLowerCase() || 'unknown';
    oidcProvider = oidcProviderFactory(env) || null;
    awsOidcProvider = null;
    oidcConfigured = !!oidcProvider;
  } else {
    ({ authProvider, oidcProvider, awsOidcProvider, oidcConfigured } =
      resolveCloudOidcProviders(env, {
        skipWhen, allowOpenAiWif, allowCloudOidc, targetHost, adapterName,
      }));
  }

  const databricksRequested = !skipWhen && (env.AWF_AUTH_TYPE || '').trim().toLowerCase() === 'github-oidc'
    && authProvider === 'databricks';
  const databricksSelected = databricksRequested && (allowCloudOidc
    || !!(env[`${(adapterName || '').toUpperCase()}_API_TARGET`] || '').trim());
  const runtimeMethods = createOidcRuntimeAdapterMethods({
    staticAuthToken: databricksSelected ? undefined : staticAuthToken,
    oidcProvider,
    awsOidcProvider,
  });

  return {
    authProvider,
    oidcProvider,
    awsOidcProvider,
    oidcConfigured,
    runtimeMethods,

    /** Skip startup validation when OIDC is configured; token is acquired asynchronously. */
    validationSkip() {
      return oidcConfigured
        ? { skip: true, reason: 'OIDC auth; validation via token acquisition' }
        : null;
    },

    /** Skip startup model fetch when OIDC is configured; models fetched after OIDC init. */
    skipModelsFetch() {
      return oidcConfigured;
    },

    /**
     * Resolve auth headers for a request: OIDC when configured, otherwise static.
     *
     * Returns the OIDC-built headers when a bearer-compatible token is available,
     * an empty object when OIDC is configured but the token is not yet ready, or
     * `staticHeaders` when OIDC is not configured at all.
     *
     * @param {(token: string) => Record<string, string>} buildOidcHeaders
     * @param {Record<string, string>} staticHeaders
     * @returns {Record<string, string>}
     */
    resolveAuthHeaders(buildOidcHeaders, staticHeaders) {
      if (databricksSelected && !oidcConfigured) return {};
      return resolveAuthHeadersWithFallback({
        oidcProvider,
        awsOidcProvider,
        buildOidcHeaders,
        staticHeaders,
      });
    },
  };
}

/**
 * Build a shared OIDC/static auth-header resolver for provider adapters.
 *
 * @param {object} options
 * @param {(buildOidcHeaders: (token: string) => Record<string, string>, staticHeaders: Record<string, string>) => Record<string, string>} options.resolveAuthHeaders
 * @param {(token: string) => Record<string, string>} options.buildOidcHeaders
 * @param {() => Record<string, string>} options.buildStaticHeaders
 * @returns {{ resolveHeaders: () => Record<string, string> }}
 */
function createProviderOidcHeaderResolver({
  resolveAuthHeaders,
  buildOidcHeaders,
  buildStaticHeaders,
}) {
  return {
    resolveHeaders() {
      return resolveAuthHeaders(
        buildOidcHeaders,
        buildStaticHeaders(),
      );
    },
  };
}

/**
 * Combined OIDC auth initialisation + header resolver for provider adapters.
 *
 * Eliminates the repeated two-step pattern of calling `createProviderOidcAuth`
 * followed by `createProviderOidcHeaderResolver` in every provider adapter.
 * Providers pass their provider-specific header builders; the common
 * credential-resolution lifecycle is handled once in this function.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {object} [oidcAuthOptions] - Options forwarded to createProviderOidcAuth
 * @param {string|undefined} [oidcAuthOptions.staticAuthToken]
 * @param {boolean} [oidcAuthOptions.skipWhen=false]
 * @param {boolean} [oidcAuthOptions.allowOpenAiWif=false]
 * @param {((env: Record<string, string|undefined>) => OidcAuthProvider|null|undefined)|null} [oidcAuthOptions.oidcProviderFactory]
 * @param {object} headerOptions - Provider-specific header builders
 * @param {(token: string) => Record<string, string>} headerOptions.buildOidcHeaders
 * @param {() => Record<string, string>} headerOptions.buildStaticHeaders
 * @returns {{
 *   authProvider: string,
 *   oidcProvider: any,
 *   awsOidcProvider: any,
 *   oidcConfigured: boolean,
 *   runtimeMethods: { isEnabled: () => boolean, getOidcProvider: () => any, getAwsOidcProvider: () => any, getRequestSigner: () => (Function|null) },
 *   validationSkip: () => ({ skip: true, reason: string }|null),
 *   skipModelsFetch: () => boolean,
 *   resolveAuthHeaders: (buildOidcHeaders: (token: string) => Record<string, string>, staticHeaders: Record<string, string>) => Record<string, string>,
 *   resolveHeaders: () => Record<string, string>,
 * }}
 */
function createProviderOidcHeaderStrategy(env, oidcAuthOptions = {}, {
  buildOidcHeaders,
  buildStaticHeaders,
}) {
  const oidcAuth = createProviderOidcAuth(env, oidcAuthOptions);
  const { resolveHeaders } = createProviderOidcHeaderResolver({
    resolveAuthHeaders: oidcAuth.resolveAuthHeaders,
    buildOidcHeaders,
    buildStaticHeaders,
  });
  return { ...oidcAuth, resolveHeaders };
}

module.exports = {
  isCloudOidcTargetAllowed,
  matchesTargetOrigin,
  hasSelectedCloudOidcTarget,
  resolveCloudOidcProviders,
  createProviderOidcAuth,
  createProviderOidcHeaderResolver,
  createProviderOidcHeaderStrategy,
};
