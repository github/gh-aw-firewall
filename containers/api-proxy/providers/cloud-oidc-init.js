'use strict';

const { OidcTokenProvider } = require('../oidc-token-provider');
const {
  createOidcRuntimeAdapterMethods,
  resolveOidcAuthHeaders,
} = require('../oidc-adapter-utils');

/**
 * @typedef {object} OidcAuthProvider
 * @property {() => boolean} isReady
 * @property {() => string} getToken
 */

/**
 * Resolve cloud OIDC providers (Azure/AWS/GCP) from environment variables.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ skipWhen?: boolean }} [options]
 * @returns {{ authProvider: string, oidcProvider: any, awsOidcProvider: any, oidcConfigured: boolean }}
 */
function resolveCloudOidcProviders(env, options = {}) {
  const { skipWhen = false } = options;
  const authType = (env.AWF_AUTH_TYPE || '').trim().toLowerCase();
  const authProvider = (env.AWF_AUTH_PROVIDER || 'azure').trim().toLowerCase();
  let oidcProvider = null;
  let awsOidcProvider = null;

  if (authType === 'github-oidc' && !skipWhen) {
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
 *   runtimeMethods: { isEnabled: () => boolean, getOidcProvider: () => any, getAwsOidcProvider: () => any },
 *   validationSkip: () => ({ skip: true, reason: string }|null),
 *   skipModelsFetch: () => boolean,
 *   resolveAuthHeaders: (buildOidcHeaders: (token: string) => Record<string, string>, staticHeaders: Record<string, string>) => Record<string, string>,
 * }}
 */
function createProviderOidcAuth(env, {
  staticAuthToken = undefined,
  skipWhen = false,
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
      resolveCloudOidcProviders(env, { skipWhen }));
  }

  const runtimeMethods = createOidcRuntimeAdapterMethods({
    staticAuthToken,
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
      const oidcHeaders = resolveOidcAuthHeaders({ oidcProvider, awsOidcProvider, buildOidcHeaders });
      return oidcHeaders !== null ? oidcHeaders : staticHeaders;
    },
  };
}

module.exports = {
  resolveCloudOidcProviders,
  createProviderOidcAuth,
};
