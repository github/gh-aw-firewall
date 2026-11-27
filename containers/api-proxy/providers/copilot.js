'use strict';

/**
 * GitHub Copilot provider adapter.
 *
 * Port: 10002
 * Auth: bearer token (COPILOT_GITHUB_TOKEN or COPILOT_PROVIDER_API_KEY)
 * Credentials: COPILOT_GITHUB_TOKEN (GitHub OAuth, higher trust) or COPILOT_PROVIDER_API_KEY (BYOK)
 * Target: COPILOT_API_TARGET  (auto-derived from GITHUB_SERVER_URL if not set)
 * Base path: optional `COPILOT_API_BASE_PATH` for prefixed BYOK routers
 *
 * Special routing: GET /models (and /models/*) always uses COPILOT_GITHUB_TOKEN
 * regardless of which auth mode is active, because the /models endpoint only
 * accepts OAuth tokens, not API keys.
 *
 * BYOK configuration, credentials, and startup validation live in
 * `copilot-byok.js`, `copilot-auth.js`, and `copilot-validation.js`.
 */

const {
  normalizeBasePath,
  composeBodyTransforms,
  getTargetScheme,
  stripTargetScheme,
} = require('../proxy-utils');
const { parseBodyAsObject } = require('../body-utils');
const { createOidcAwareProviderAdapter } = require('../adapter-factory');
const { sanitizeNullToolCallTypes } = require('../body-transform');
const {
  resolveCopilotByokConfig,
} = require('./copilot-byok');
const {
  resolveCopilotCredentials,
  deriveCopilotApiTarget,
  isGithubCopilotCatalogTarget,
} = require('./copilot-auth');
const {
  COPILOT_MODELS_API_VERSION,
  buildCopilotModelsRequest,
  getCopilotValidationProbe,
} = require('./copilot-validation');
const { bearerAuthHeaders, tokenAuthHeaders, buildAuthHeaderFn, withCopilotIntegration } = require('./auth-headers');
const { URL } = require('url');
const { COPILOT_ENV } = require('../provider-env-constants');
const { attachCopilotAuthDiagnostic } = require('../copilot-auth-diagnostics');
const { isTokenBrokerEnabled } = require('./token-broker');
const { createCopilotTokenBrokerAdapter } = require('./copilot-token-broker');

const COPILOT_LEGACY_AUTO_API_VERSION = '2025-07-16';
const COPILOT_AUTO_API_VERSION = '2026-08-01';

function hasRequestHeader(req, name) {
  return Object.keys(req.headers || {}).some(header => header.toLowerCase() === name.toLowerCase());
}

function getDefaultAutoApiVersion(req, pathname, rawTarget) {
  if (
    req.method !== 'POST'
    || hasRequestHeader(req, 'x-github-api-version')
    || !isGithubCopilotCatalogTarget(rawTarget)
  ) {
    return undefined;
  }

  if (pathname === '/auto') return COPILOT_AUTO_API_VERSION;
  if (pathname === '/models/session' || pathname === '/models/session/intent') {
    return COPILOT_LEGACY_AUTO_API_VERSION;
  }
  return undefined;
}

function omitUnsupportedAutoModel(body, req, rawTarget) {
  if (!isGithubCopilotCatalogTarget(rawTarget)) return null;

  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return null;
  }
  if (pathname !== '/chat/completions' && pathname !== '/v1/chat/completions') return null;

  const parsed = parseBodyAsObject(body);
  if (!parsed || parsed.model !== 'auto') return null;

  delete parsed.model;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/**
 * Create the GitHub Copilot provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createCopilotAdapter(env, deps = {}) {
  if (isTokenBrokerEnabled(env)) return createCopilotTokenBrokerAdapter(env, deps);
  const rawTarget = deriveCopilotApiTarget(env);
  const basePath = normalizeBasePath(env[COPILOT_ENV.API_BASE_PATH]);
  const {
    githubToken, apiKey, staticAuthToken, integrationId, integrationIdSource,
    databricksSelected, githubTokenAuthPrefix, authPrefix, inferenceCredentialSource,
    oidcAuthOptions, reflectionExtra,
  } = resolveCopilotCredentials(env, rawTarget);
  const authToken = staticAuthToken;
  const { byokExtraHeaders, byokBodyFieldTransform } = resolveCopilotByokConfig(env, apiKey);

  const sanitizedBodyTransform = composeBodyTransforms(
    deps.bodyTransform || null,
    (body) => { const result = sanitizeNullToolCallTypes(body); return result ? result.body : null; }
  );
  // NOTE: Codex custom-tool translation (`translateCodexCustomToolsForCopilot`)
  // is deliberately NOT part of this chain. It does not follow the
  // `Buffer | null` body-transform contract — it returns
  // `{ body, compatibility }` — so composing it here would hand a plain object
  // to the request pipeline (yielding `Content-Length: undefined` and an empty
  // upstream body). It is applied separately, with its compatibility metadata
  // threaded through the request/retry context, in body-handler.js.
  const bodyTransform = composeBodyTransforms(
    composeBodyTransforms(sanitizedBodyTransform, byokBodyFieldTransform),
    (body, req) => omitUnsupportedAutoModel(body, req, rawTarget)
  );
  // Pre-computed models path used by getModelsFetchConfig and getReflectionInfo.
  // For BYOK/custom providers the base path prefix is included (e.g. /api/v1/models
  // for COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1).
  // A basePath of '/' (normalizeBasePath returns '/') is treated as no prefix to
  // avoid producing '//models'.
  const modelsPath = (basePath && basePath !== '/') ? `${basePath}/models` : '/models';
  const modelsRequestContext = { rawTarget, githubTokenAuthPrefix, githubToken, integrationId };

  // Copilot has dual auth modes (GitHub OAuth vs BYOK) with different validation
  // and model-fetch rules, so we override those two methods while still sharing
  // the common reflection method shape from createAdapterMethods.
  return createOidcAwareProviderAdapter({
    env,
    oidcAuthOptions,
    buildOidcHeaders: (token) => withCopilotIntegration(bearerAuthHeaders(token), integrationId),
    buildStaticHeaders: () => withCopilotIntegration(
      buildAuthHeaderFn({ prefix: authPrefix })(authToken, apiKey ? byokExtraHeaders : undefined),
      integrationId
    ),
    createAdapterMethodsOptions: ({ oidcConfigured, authProvider, oidcProvider, resolveHeaders }) => ({
      apiKey: authToken,
      rawTarget,
      basePath,
      provider: 'copilot',
      port: 10002,
      modelsPath,
      reflectionConfigured: !!authToken || oidcConfigured,
      reflectionModelsPath: modelsPath,
      reflectionExtra,
      getValidationProbe() {
        return getCopilotValidationProbe({
          ...modelsRequestContext, oidcConfigured, authProvider, databricksSelected, authToken,
        });
      },
      getModelsFetchConfig() {
        if (databricksSelected) {
          if (!oidcConfigured || !oidcProvider?.isReady()) return null;
          return {
            url: `${getTargetScheme(rawTarget)}://${stripTargetScheme(rawTarget)}${modelsPath}`,
            opts: { method: 'GET', headers: resolveHeaders() },
            cacheKey: 'copilot',
            modelMetadataFormat: 'openai',
          };
        }
        // OIDC mode: skip startup model fetch — the token isn't available yet at this
        // point and the upstream BYOK target typically isn't api.githubcopilot.com.
        if (oidcConfigured) return null;
        if (!authToken) return null;

        // GitHub-hosted Copilot endpoints:
        // The /models endpoint only accepts GitHub OAuth tokens (COPILOT_GITHUB_TOKEN).
        // Skip startup model fetch when only a BYOK API key is configured.
        if (isGithubCopilotCatalogTarget(rawTarget)) {
          if (!githubToken) return null;
          return buildCopilotModelsRequest(modelsRequestContext, { cacheKey: 'copilot' });
        }

        // BYOK / custom provider (e.g. OpenRouter):
        // Use the explicit BYOK API key (COPILOT_PROVIDER_API_KEY) rather than authToken
        // to ensure we never send a GitHub OAuth token to third-party providers.
        // Skip the fetch when no BYOK key is configured.
        if (!apiKey) return null;
        return {
          url: `${getTargetScheme(rawTarget)}://${stripTargetScheme(rawTarget)}${modelsPath}`,
          opts: {
            method: 'GET',
            headers: bearerAuthHeaders(apiKey),
          },
          cacheKey: 'copilot',
          modelMetadataFormat: 'openai',
        };
      },
    }),
    buildAdapterOptions: ({ authProvider, oidcConfigured, oidcProvider, awsOidcProvider }) => ({
      name: 'copilot',
      port: 10002,
      isManagementPort: false,
      bodyTransform,
      missingCredentialResponse: {
        kind: 'provider_not_configured',
        message: 'Credentials for GitHub Copilot (port 10002) are not configured. Set COPILOT_GITHUB_TOKEN or COPILOT_PROVIDER_API_KEY to enable this provider.',
      },
      unconfiguredResponseWhen: () => (oidcConfigured
        ? {
            kind: 'provider_not_configured',
            message: `Copilot OIDC token (${authProvider}) unavailable; retry shortly`,
            retryable: true,
          }
        : databricksSelected ? {
            kind: 'provider_not_configured',
            message: 'Databricks OIDC requires an explicit target matching the HTTPS workspace origin; first-party and conflicting targets are refused.',
          } : null),
      healthServiceName: 'awf-api-proxy-copilot',
      missingCredentialMessage: 'COPILOT_GITHUB_TOKEN or COPILOT_PROVIDER_API_KEY not configured in api-proxy sidecar',
      unavailableWhen: () => oidcConfigured ? { message: `Copilot OIDC token (${authProvider}) not yet available in api-proxy sidecar` } : null,
      extra: {
        getRoutingProviderIdentity: () => (
          !oidcConfigured && githubToken && !apiKey && isGithubCopilotCatalogTarget(rawTarget)
            ? 'github-copilot'
            : null
        ),
        // Exposed for introspection / testing
        _githubToken: githubToken,
        _apiKey: apiKey,
        _integrationId: integrationId,
        _integrationIdSource: integrationIdSource,
        _rawTarget: rawTarget,
        _basePath: basePath,
        _oidcProvider: oidcProvider,
        _awsOidcProvider: awsOidcProvider,
      },
    }),
    /**
     * Build Copilot auth headers for this request.
     *
     * The Copilot /models endpoint only accepts COPILOT_GITHUB_TOKEN (GitHub OAuth).
     * All other requests use the resolved auth token (COPILOT_PROVIDER_API_KEY when real, otherwise COPILOT_GITHUB_TOKEN).
     *
     * @param {{ req: import('http').IncomingMessage, resolveHeaders: () => Record<string,string> }} params
     * @returns {Record<string, string>}
     */
    getAuthHeaders({ req, resolveHeaders }) {
      let reqPathname;
      try {
        reqPathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        reqPathname = req.url || '';
      }

      // Enterprise/Business Copilot API requires 'token <value>' for GitHub OAuth tokens.
      // BYOK API keys use 'Bearer' regardless of target.
      // Standard api.githubcopilot.com and GHEC (*.ghe.com) also use 'Bearer' for all credentials.
      const isModelsPath = reqPathname === '/models' || reqPathname.startsWith('/models/');
      const useGithubToken = !databricksSelected && isModelsPath && req.method === 'GET' && githubToken;
      attachCopilotAuthDiagnostic(req, {
        env,
        source: useGithubToken ? 'github_token' : inferenceCredentialSource,
        token: useGithubToken ? githubToken : staticAuthToken,
        rawTarget, basePath, integrationIdSource,
      });
      if (useGithubToken) {
        // /models always uses the GitHub OAuth token (not BYOK key)
        return withCopilotIntegration(tokenAuthHeaders(
          githubTokenAuthPrefix,
          githubToken,
          isGithubCopilotCatalogTarget(rawTarget) ? { 'X-GitHub-Api-Version': COPILOT_MODELS_API_VERSION } : undefined
        ), integrationId);
      }

      const headers = resolveHeaders();
      const autoApiVersion = getDefaultAutoApiVersion(req, reqPathname, rawTarget);
      if (autoApiVersion) {
        headers['X-GitHub-Api-Version'] = autoApiVersion;
      }
      return headers;
    },
  });
}

module.exports = {
  createCopilotAdapter,
};
