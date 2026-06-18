'use strict';

/**
 * Anthropic provider adapter.
 *
 * Port: 10001
 * Auth: x-api-key or Authorization header, plus optional anthropic-version
 *       and anthropic-beta headers
 * Credentials: ANTHROPIC_API_KEY or AWF_AUTH_TYPE=github-oidc + AWF_AUTH_PROVIDER=anthropic
 * Target: ANTHROPIC_API_TARGET  (default: api.anthropic.com)
 * Base path: ANTHROPIC_API_BASE_PATH
 * Body transforms: model alias rewriting + optional prompt-cache optimisations
 */

const {
  composeBodyTransforms,
  makeProviderNotConfiguredResponse,
  makeUnconfiguredHealthResponse,
  validateAuthHeaderEnv,
  resolveOidcAuthHeaders,
} = require('../proxy-utils');
const { createBaseAdapterConfig, createAdapterMethods } = require('../adapter-factory');
const { AnthropicOidcTokenProvider } = require('../anthropic-oidc-token-provider');
const { createProviderOidcAuth } = require('./cloud-oidc-init');

let makeAnthropicTransform, loadCustomTransform, EXTENDED_CACHE_BETA;
try {
  ({ makeAnthropicTransform, loadCustomTransform, EXTENDED_CACHE_BETA } = require('../anthropic-transforms'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    makeAnthropicTransform = () => () => null;
    loadCustomTransform = () => null;
    EXTENDED_CACHE_BETA = undefined;
  } else {
    throw err;
  }
}

/**
 * Create the Anthropic provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createAnthropicAdapter(env, deps = {}) {
  const { apiKey, rawTarget, basePath } = createBaseAdapterConfig(env, {
    keyEnvVar: 'ANTHROPIC_API_KEY',
    targetEnvVar: 'ANTHROPIC_API_TARGET',
    basePathEnvVar: 'ANTHROPIC_API_BASE_PATH',
    defaultTarget: 'api.anthropic.com',
  });
  const authHeaderName = validateAuthHeaderEnv('AWF_ANTHROPIC_AUTH_HEADER', env.AWF_ANTHROPIC_AUTH_HEADER, 'x-api-key');

  // oidcRequested tracks whether the caller asked for Anthropic OIDC, regardless
  // of whether the token env vars (ACTIONS_ID_TOKEN_REQUEST_*) are also present.
  // This lets getUnconfiguredResponse() give a more helpful error message when
  // OIDC was asked for but could not be fully initialised.
  const oidcRequested = (env.AWF_AUTH_TYPE || '').trim().toLowerCase() === 'github-oidc'
    && (env.AWF_AUTH_PROVIDER || '').trim().toLowerCase() === 'anthropic';

  const {
    oidcProvider, oidcConfigured,
    runtimeMethods: oidcRuntimeMethods,
  } = createProviderOidcAuth(env, {
    staticAuthToken: apiKey,
    oidcProviderFactory: oidcRequested ? (env) => {
      const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
      const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
      if (!requestUrl || !requestToken) return null;
      const workspaceId = env.AWF_AUTH_ANTHROPIC_WORKSPACE_ID;
      const tokenEndpoint = (env.AWF_AUTH_ANTHROPIC_TOKEN_URL || '').trim();
      return new AnthropicOidcTokenProvider({
        requestUrl,
        requestToken,
        federationRuleId: env.AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID,
        organizationId: env.AWF_AUTH_ANTHROPIC_ORGANIZATION_ID,
        serviceAccountId: env.AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(tokenEndpoint ? { tokenEndpoint } : {}),
        oidcAudience: env.AWF_AUTH_OIDC_AUDIENCE || 'https://api.anthropic.com',
      });
    } : null,
  });

  const oidcUnavailableError = oidcConfigured
    ? 'Anthropic OIDC token unavailable; retry shortly'
    : 'Anthropic OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (permissions: id-token: write).';

  // ── Anthropic-specific optimisations ──────────────────────────────────────
  const autoCache = (env.AWF_ANTHROPIC_AUTO_CACHE === '1' || env.AWF_ANTHROPIC_AUTO_CACHE === 'true');
  const cacheTailTtl = (() => {
    const raw = (env.AWF_ANTHROPIC_CACHE_TAIL_TTL || '').trim();
    return (raw === '1h' || raw === '5m') ? raw : '5m';
  })();
  const dropTools = (() => {
    const raw = (env.AWF_ANTHROPIC_DROP_TOOLS || '').trim();
    return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  })();
  const stripAnsi = (env.AWF_ANTHROPIC_STRIP_ANSI === '1' || env.AWF_ANTHROPIC_STRIP_ANSI === 'true');
  const transformFile = (env.AWF_ANTHROPIC_TRANSFORM_FILE || '').trim() || undefined;

  const customTransform = loadCustomTransform(transformFile);
  const optimisationsTransform = makeAnthropicTransform({
    autoCache,
    tailTtl: cacheTailTtl,
    dropTools,
    stripAnsiCodes: stripAnsi,
    customTransform,
  });

  const bodyTransform = deps.bodyTransform || null;

  // Build the composed transform once at construction time to avoid
  // re-allocating the wrapper function on every request.
  const composedBodyTransform = composeBodyTransforms(bodyTransform, optimisationsTransform);
  const adapterMethods = createAdapterMethods({
    apiKey,
    rawTarget,
    basePath,
    provider: 'anthropic',
    port: 10001,
    defaultTarget: 'api.anthropic.com',
    validationPath: '/v1/messages',
    validationMethod: 'POST',
    validationBody: '{}',
    validationHeaders: () => {
      if (oidcProvider && oidcProvider.isReady()) {
        return {
          'Authorization': `Bearer ${oidcProvider.getToken()}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        };
      }
      return {
        [authHeaderName]: apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      };
    },
    validationSkip: () => {
      if (!oidcConfigured) return null;
      // After OIDC init, validate using the acquired token
      if (oidcProvider.isReady()) return null;
      return { skip: true, reason: 'OIDC auth; token not yet available' };
    },
    skipModelsFetch: () => oidcConfigured && !oidcProvider?.isReady(),
    modelsPath: '/v1/models',
    modelsFetchHeaders: () => {
      if (oidcProvider && oidcProvider.isReady()) {
        return { 'Authorization': `Bearer ${oidcProvider.getToken()}`, 'anthropic-version': '2023-06-01' };
      }
      return { [authHeaderName]: apiKey, 'anthropic-version': '2023-06-01' };
    },
    reflectionConfigured: !!apiKey || oidcRequested,
    reflectionExtra: () => ({
      auth_type: oidcRequested ? 'github-oidc/anthropic' : 'static-key',
    }),
  });

  return {
    name: 'anthropic',
    port: 10001,
    isManagementPort: false,

    /**
     * Port 10001 always starts so agents get a clear 503 "not configured"
     * error rather than a silent connection-refused.
     */
    alwaysBind: true,

    /**
     * The stub server does NOT count toward the startup validation latch —
     * only the fully-configured server (when ANTHROPIC_API_KEY is set) does.
     */
    ...oidcRuntimeMethods,

    /**
     * Build Anthropic auth headers for this request.
     * Merges in the anthropic-version default and anthropic-beta (for auto-cache)
     * as needed, without overwriting values already set by the client.
     *
     * @param {import('http').IncomingMessage} req
     * @returns {Record<string, string>}
     */
    getAuthHeaders(req) {
      const oidcHeaders = resolveOidcAuthHeaders({
        oidcProvider,
        awsOidcProvider: null,
        buildOidcHeaders: (token) => ({ 'Authorization': 'Bearer ' + token }),
      });

      // oidcHeaders === null  → OIDC not configured; fall through to static key.
      // oidcHeaders === {}    → OIDC configured, token not yet ready; return empty so the
      //                         request fails authentication rather than leaking the static key.
      // oidcHeaders === {...} → OIDC token available; use it.
      if (oidcHeaders !== null && Object.keys(oidcHeaders).length === 0) {
        return {};
      }

      const headers = oidcHeaders !== null ? { ...oidcHeaders } : { [authHeaderName]: apiKey };

      if (!req.headers['anthropic-version']) {
        headers['anthropic-version'] = '2023-06-01';
      }

      if (autoCache) {
        const existing = req.headers['anthropic-beta'];
        if (!existing) {
          headers['anthropic-beta'] = EXTENDED_CACHE_BETA;
        } else {
          const normalizedExisting = Array.isArray(existing) ? existing.join(',') : existing;
          const existingBetas = normalizedExisting.split(',').map(s => s.trim()).filter(Boolean);
          if (!existingBetas.includes(EXTENDED_CACHE_BETA)) {
            headers['anthropic-beta'] = `${normalizedExisting},${EXTENDED_CACHE_BETA}`;
          }
        }
      }

      return headers;
    },

    getBodyTransform() { return composedBodyTransform; },
    ...adapterMethods,

    /** Response returned for all requests when no ANTHROPIC_API_KEY is configured. */
    getUnconfiguredResponse() {
      if (oidcRequested) {
        return {
          statusCode: 503,
          body: { error: oidcUnavailableError },
        };
      }
      return makeProviderNotConfiguredResponse(
        'anthropic',
        10001,
        'Credentials for Anthropic (port 10001) are not configured. Set ANTHROPIC_API_KEY to enable this provider.'
      );
    },

    /** /health response when not configured. */
    getUnconfiguredHealthResponse() {
      if (oidcRequested) {
        return makeUnconfiguredHealthResponse('awf-api-proxy-anthropic', oidcUnavailableError, 'unavailable');
      }
      return makeUnconfiguredHealthResponse('awf-api-proxy-anthropic', 'ANTHROPIC_API_KEY not configured in api-proxy sidecar');
    },

    // Exposed for introspection (logging, tests)
    _autoCache: autoCache,
    _cacheTailTtl: cacheTailTtl,
    _dropTools: dropTools,
    _stripAnsi: stripAnsi,
    _transformFile: transformFile,
    _customTransformLoaded: !!customTransform,
    _optimisationsTransform: optimisationsTransform,
  };
}

module.exports = { createAnthropicAdapter };
