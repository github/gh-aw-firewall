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
 * Additional BYOK parsing and Copilot auth/target helpers live in
 * `copilot-byok.js` and `copilot-auth.js`.
 */

const {
  normalizeBasePath,
  makeProviderNotConfiguredResponse,
  makeUnconfiguredHealthResponse,
  composeBodyTransforms,
  resolveOidcAuthHeaders,
} = require('../proxy-utils');
const { createAdapterMethods } = require('../adapter-factory');
const { sanitizeNullToolCallTypes } = require('../body-transform');
const {
  parseByokExtraHeaders,
  parseByokExtraBodyFields,
  injectByokExtraBodyFields,
} = require('./copilot-byok');
const {
  stripBearerPrefix,
  resolveApiKey,
  resolveCopilotAuthToken,
  deriveCopilotApiTarget,
  isGhesInstance,
} = require('./copilot-auth');
const { createProviderOidcAuth } = require('./cloud-oidc-init');
const { URL } = require('url');

/**
 * Create the GitHub Copilot provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createCopilotAdapter(env, deps = {}) {
  const githubToken = stripBearerPrefix(env.COPILOT_GITHUB_TOKEN);
  // resolveApiKey filters out the AWF placeholder so it is never used as a real BYOK credential.
  const apiKey = resolveApiKey(env);
  const staticAuthToken = resolveCopilotAuthToken(env);
  const integrationId = env.COPILOT_INTEGRATION_ID || 'agentic-workflows';
  const rawTarget = deriveCopilotApiTarget(env);
  const basePath = normalizeBasePath(env.COPILOT_API_BASE_PATH);

  // OIDC auth strategy (Azure OpenAI via Entra, AWS Bedrock, GCP Vertex AI) for
  // BYOK targets pointed at by COPILOT_PROVIDER_BASE_URL. Mirrors the OpenAI
  // adapter's OIDC plumbing so the Copilot CLI's direct-BYOK path can exchange a
  // GitHub Actions OIDC JWT for an upstream cloud token instead of requiring a
  // static COPILOT_PROVIDER_API_KEY.
  // authToken is consumed by the existing validation/models-fetch/auth-header paths.
  // In OIDC mode staticAuthToken is typically undefined; enablement is determined by
  // createOidcRuntimeAdapterMethods + oidcConfigured, and the real token is resolved
  // lazily inside getAuthHeaders.
  const authToken = staticAuthToken;
  const {
    authProvider, oidcProvider, awsOidcProvider, oidcConfigured,
    runtimeMethods: oidcRuntimeMethods,
  } = createProviderOidcAuth(env, { staticAuthToken: authToken, skipWhen: !!staticAuthToken });
  // Extra headers to inject on all requests that use the BYOK API key.
  // Only populated when AWF_BYOK_EXTRA_HEADERS is set; ignored for standard
  // GitHub OAuth (COPILOT_GITHUB_TOKEN-only) requests.
  const byokExtraHeaders = parseByokExtraHeaders(env.AWF_BYOK_EXTRA_HEADERS);
  const byokExtraBodyFields = parseByokExtraBodyFields(env.AWF_BYOK_EXTRA_BODY_FIELDS);
  const providerSessionId = (env.AWF_PROVIDER_SESSION_ID || '').trim() || undefined;
  // `session_id` (and `x-session-id`) are GitHub Copilot API conventions and
  // can be rejected by strict OpenAI-compatible servers (e.g. Azure OpenAI's
  // /openai/v1/responses returns HTTP 400 on unknown body params).  Auto-
  // injection is therefore strictly opt-in: AWF_PROVIDER_SESSION_ID is only
  // forwarded by the host wrapper when the caller sets
  // `apiProxy.targets.copilot.sessionId` (or `AWF_PROVIDER_SESSION_ID`)
  // explicitly — never derived from `GITHUB_RUN_ID`.
  if (providerSessionId) {
    const hasSessionIdHeader = Object.keys(byokExtraHeaders).some(k => k.toLowerCase() === 'x-session-id');
    if (!hasSessionIdHeader) {
      byokExtraHeaders['x-session-id'] = providerSessionId;
    }
    if (!Object.hasOwn(byokExtraBodyFields, 'session_id')) {
      byokExtraBodyFields.session_id = providerSessionId;
    }
  }

  const sanitizedBodyTransform = composeBodyTransforms(
    deps.bodyTransform || null,
    (body) => { const result = sanitizeNullToolCallTypes(body); return result ? result.body : null; }
  );
  const byokBodyFieldTransform = (apiKey && Object.keys(byokExtraBodyFields).length > 0)
    ? (body) => injectByokExtraBodyFields(body, byokExtraBodyFields)
    : null;
  const bodyTransform = composeBodyTransforms(sanitizedBodyTransform, byokBodyFieldTransform);

  // Pre-computed models path used by getModelsFetchConfig and getReflectionInfo.
  // For BYOK/custom providers the base path prefix is included (e.g. /api/v1/models
  // for COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1).
  // A basePath of '/' (normalizeBasePath returns '/') is treated as no prefix to
  // avoid producing '//models'.
  const modelsPath = (basePath && basePath !== '/') ? `${basePath}/models` : '/models';
  // Copilot has dual auth modes (GitHub OAuth vs BYOK) with different validation
  // and model-fetch rules, so we override those two methods while still sharing
  // the common reflection method shape from createAdapterMethods.
  const adapterMethods = createAdapterMethods({
    apiKey: authToken,
    rawTarget,
    basePath,
    provider: 'copilot',
    port: 10002,
    modelsPath,
    reflectionConfigured: !!authToken || oidcConfigured,
    reflectionModelsPath: modelsPath,
    getValidationProbe() {
      if (oidcConfigured) {
        return { skip: true, reason: `OIDC auth (${authProvider}); validation via token acquisition` };
      }
      if (!authToken) return null;

      // Only COPILOT_GITHUB_TOKEN has a probe endpoint (/models).
      // COPILOT_PROVIDER_API_KEY alone cannot be validated at startup.
      if (!githubToken) {
        return {
          skip: true,
          reason: 'COPILOT_PROVIDER_API_KEY configured but startup validation is not supported for this auth mode',
        };
      }

      if (rawTarget !== 'api.githubcopilot.com') {
        return { skip: true, reason: `Custom target ${rawTarget}; validation skipped` };
      }

      return {
        url: `https://${rawTarget}/models`,
        opts: {
          method: 'GET',
          headers: {
            'Authorization': ['Bearer', githubToken].join(' '),
            'Copilot-Integration-Id': integrationId,
          },
        },
      };
    },
    getModelsFetchConfig() {
      // OIDC mode: skip startup model fetch — the token isn't available yet at this
      // point and the upstream BYOK target typically isn't api.githubcopilot.com.
      if (oidcConfigured) return null;
      if (!authToken) return null;

      // Standard Copilot API (api.githubcopilot.com):
      // The /models endpoint only accepts GitHub OAuth tokens (COPILOT_GITHUB_TOKEN).
      // Skip startup model fetch when only a BYOK API key is configured.
      if (rawTarget === 'api.githubcopilot.com') {
        if (!githubToken) return null;
        return {
          url: `https://${rawTarget}/models`,
          opts: {
            method: 'GET',
            headers: {
              'Authorization': ['Bearer', githubToken].join(' '),
              'Copilot-Integration-Id': integrationId,
            },
          },
          cacheKey: 'copilot',
        };
      }

      // BYOK / custom provider (e.g. OpenRouter):
      // Use the explicit BYOK API key (COPILOT_PROVIDER_API_KEY) rather than authToken
      // to ensure we never send a GitHub OAuth token to third-party providers.
      // Skip the fetch when no BYOK key is configured.
      if (!apiKey) return null;
      return {
        url: `https://${rawTarget}${modelsPath}`,
        opts: {
          method: 'GET',
          headers: {
            'Authorization': ['Bearer', apiKey].join(' '),
          },
        },
        cacheKey: 'copilot',
      };
    },
  });

  return {
    name: 'copilot',
    port: 10002,
    isManagementPort: false,

    /**
     * Port 10002 always starts so agents get a clear 503 "not configured"
     * error rather than a silent connection-refused.
     */
    alwaysBind: true,

    /**
     * The stub server does NOT count toward the startup validation latch —
     * only the fully-configured server (when credentials are present) does.
     */
    ...oidcRuntimeMethods,

    /**
     * Build Copilot auth headers for this request.
     *
     * The Copilot /models endpoint only accepts COPILOT_GITHUB_TOKEN (GitHub OAuth).
     * All other requests use the resolved auth token (COPILOT_PROVIDER_API_KEY when real, otherwise COPILOT_GITHUB_TOKEN).
     *
     * @param {import('http').IncomingMessage} req
     * @returns {Record<string, string>}
     */
    getAuthHeaders(req) {
      let reqPathname;
      try {
        reqPathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        reqPathname = req.url || '';
      }

      // Enterprise Copilot API (GHES) requires 'token <value>' for GitHub OAuth tokens;
      // BYOK API keys always use 'Bearer <value>' regardless of target.
      // Standard api.githubcopilot.com and GHEC (*.ghe.com) use 'Bearer' for all credentials.
      const isEnterprise = isGhesInstance(rawTarget, env);

      const isModelsPath = reqPathname === '/models' || reqPathname.startsWith('/models/');
      if (isModelsPath && req.method === 'GET' && githubToken) {
        // /models always uses the GitHub OAuth token (not BYOK key)
        const prefix = isEnterprise ? 'token' : 'Bearer';
        return {
          'Authorization': [prefix, githubToken].join(' '),
          'Copilot-Integration-Id': integrationId,
        };
      }

      const oidcHeaders = resolveOidcAuthHeaders({
        oidcProvider,
        awsOidcProvider,
        buildOidcHeaders: (token) => ({
          'Authorization': ['Bearer', token].join(' '),
          'Copilot-Integration-Id': integrationId,
        }),
      });
      if (oidcHeaders !== null) {
        return oidcHeaders;
      }

      // For inference: BYOK keys use 'Bearer'; GitHub tokens use 'token' on GHES
      const authPrefix = (isEnterprise && !apiKey) ? 'token' : 'Bearer';
      return {
        ...(apiKey ? byokExtraHeaders : {}),
        'Authorization': [authPrefix, authToken].join(' '),
        'Copilot-Integration-Id': integrationId,
      };
    },

    getBodyTransform() { return bodyTransform; },
    ...adapterMethods,

    /** Response returned for all requests when no Copilot credentials are configured. */
    getUnconfiguredResponse() {
      if (oidcConfigured) {
        return makeProviderNotConfiguredResponse(
          'copilot',
          10002,
          `Copilot OIDC token (${authProvider}) unavailable; retry shortly`
        );
      }
      return makeProviderNotConfiguredResponse(
        'copilot',
        10002,
        'Credentials for GitHub Copilot (port 10002) are not configured. Set COPILOT_GITHUB_TOKEN or COPILOT_PROVIDER_API_KEY to enable this provider.'
      );
    },

    /** /health response when not configured. */
    getUnconfiguredHealthResponse() {
      if (oidcConfigured) {
        return makeUnconfiguredHealthResponse('awf-api-proxy-copilot', `Copilot OIDC token (${authProvider}) not yet available in api-proxy sidecar`);
      }
      return makeUnconfiguredHealthResponse('awf-api-proxy-copilot', 'COPILOT_GITHUB_TOKEN or COPILOT_PROVIDER_API_KEY not configured in api-proxy sidecar');
    },

    // Exposed for introspection / testing
    _githubToken: githubToken,
    _apiKey: apiKey,
    _integrationId: integrationId,
    _rawTarget: rawTarget,
    _basePath: basePath,
    _oidcProvider: oidcProvider,
    _awsOidcProvider: awsOidcProvider,
  };
}

module.exports = {
  createCopilotAdapter,
};
