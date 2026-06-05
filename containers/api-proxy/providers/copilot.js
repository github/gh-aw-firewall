'use strict';

/**
 * GitHub Copilot provider adapter.
 *
 * Port: 10002
 * Auth: Bearer token (COPILOT_GITHUB_TOKEN or COPILOT_PROVIDER_API_KEY)
 * Credentials: COPILOT_GITHUB_TOKEN (GitHub OAuth, higher trust) or COPILOT_PROVIDER_API_KEY (BYOK)
 * Target: COPILOT_API_TARGET  (auto-derived from GITHUB_SERVER_URL if not set)
 * Base path: optional `COPILOT_API_BASE_PATH` for prefixed BYOK routers
 *
 * Special routing: GET /models (and /models/*) always uses COPILOT_GITHUB_TOKEN
 * regardless of which auth mode is active, because the /models endpoint only
 * accepts OAuth tokens, not API keys.
 *
 * BYOK extra headers: AWF_BYOK_EXTRA_HEADERS (JSON object) injects supplemental
 * headers (e.g. x-session-id, HTTP-Referer) into upstream requests when the
 * BYOK API key is in use.  Auth-critical header names are rejected at parse time.
 *
 * BYOK extra body fields: AWF_BYOK_EXTRA_BODY_FIELDS (JSON object) injects
 * supplemental top-level JSON fields (e.g. session_id) into upstream requests
 * when the BYOK API key is in use.
 */

const {
  normalizeApiTarget,
  normalizeBasePath,
  makeProviderNotConfiguredResponse,
  createAdapterMethods,
  composeBodyTransforms,
} = require('../proxy-utils');
const { sanitizeNullToolCallTypes } = require('../body-transform');
const { parseBodyAsObject } = require('../body-utils');
const { OidcTokenProvider } = require('../oidc-token-provider');
const { URL } = require('url');

/**
 * Header names that must never be overridden by caller-supplied extra headers.
 * These are the auth/proxy headers stripped or injected by the proxy itself.
 */
const PROTECTED_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'proxy-authorization',
]);

/**
 * Parse the AWF_BYOK_EXTRA_HEADERS environment variable into a plain header map.
 *
 * The value must be a JSON object whose keys are valid HTTP header names and
 * whose values are strings.  Invalid entries are skipped with a console warning;
 * the function always returns a (possibly empty) object rather than throwing.
 *
 * Auth-critical header names (authorization, x-api-key, etc.) are rejected to
 * prevent accidental credential injection via this configuration path.
 *
 * @param {string|undefined} raw - Raw value of AWF_BYOK_EXTRA_HEADERS
 * @returns {Record<string, string>} Validated header map (may be empty)
 */
function parseByokExtraHeaders(raw) {
  if (!raw || !raw.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    console.warn('AWF_BYOK_EXTRA_HEADERS: invalid JSON; ignoring extra headers');
    return {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    console.warn('AWF_BYOK_EXTRA_HEADERS: expected a JSON object; ignoring extra headers');
    return {};
  }

  const result = {};
  const http = require('http');
  for (const [name, value] of Object.entries(parsed)) {
    const lowerName = name.toLowerCase();

    // Prevent prototype pollution / special keys in header maps.
    if (lowerName === '__proto__' || lowerName === 'constructor' || lowerName === 'prototype') {
      console.warn(`AWF_BYOK_EXTRA_HEADERS: "${name}" is not an allowed header name; skipping`);
      continue;
    }

    if (PROTECTED_HEADER_NAMES.has(lowerName)) {
      console.warn(`AWF_BYOK_EXTRA_HEADERS: "${name}" is an auth-critical header and cannot be overridden; skipping`);
      continue;
    }
    try {
      http.validateHeaderName(name);
    } catch {
      console.warn(`AWF_BYOK_EXTRA_HEADERS: "${name}" is not a valid HTTP header name; skipping`);
      continue;
    }
    if (typeof value !== 'string') {
      console.warn(`AWF_BYOK_EXTRA_HEADERS: value for "${name}" must be a string; skipping`);
      continue;
    }
    result[name] = value;
  }

  return result;
}

/**
 * Parse AWF_BYOK_EXTRA_BODY_FIELDS into a plain string map.
 *
 * @param {string|undefined} raw - Raw value of AWF_BYOK_EXTRA_BODY_FIELDS
 * @returns {Record<string, string>} Validated body field map (may be empty)
 */
function parseByokExtraBodyFields(raw) {
  if (!raw || !raw.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    console.warn('AWF_BYOK_EXTRA_BODY_FIELDS: invalid JSON; ignoring extra body fields');
    return {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    console.warn('AWF_BYOK_EXTRA_BODY_FIELDS: expected a JSON object; ignoring extra body fields');
    return {};
  }

  const result = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      console.warn(`AWF_BYOK_EXTRA_BODY_FIELDS: "${name}" is not an allowed field name; skipping`);
      continue;
    }
    if (typeof value !== 'string') {
      console.warn(`AWF_BYOK_EXTRA_BODY_FIELDS: value for "${name}" must be a string; skipping`);
      continue;
    }
    result[name] = value;
  }

  return result;
}

/**
 * Inject non-overriding top-level JSON fields into a request body.
 *
 * @param {Buffer} body
 * @param {Record<string, string>} fields
 * @returns {Buffer|null}
 */
function injectByokExtraBodyFields(body, fields) {
  if (!fields || Object.keys(fields).length === 0) return null;

  const parsed = parseBodyAsObject(body);
  if (!parsed) return null;

  let changed = false;
  for (const [field, value] of Object.entries(fields)) {
    if (!Object.hasOwn(parsed, field)) {
      parsed[field] = value;
      changed = true;
    }
  }

  if (!changed) return null;
  return Buffer.from(JSON.stringify(parsed));
}

// AWF injects this sentinel value into the *agent* environment for credential isolation.
// The ghu_ prefix is intentional: it matches the GitHub token shape that Copilot CLI
// auth pre-checks expect, but the 36 repeated 'a' characters make it unambiguous as
// a non-real placeholder.  It is defined in src/constants/placeholders.ts and must
// stay in sync.
const COPILOT_PLACEHOLDER_TOKEN = 'ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Strip any accidental "Bearer " or "token " prefix from a raw credential
 * value and trim
 * surrounding whitespace.  Returns undefined when the result is empty so that
 * callers can use `|| undefined` fall-through cleanly.
 *
 * A value like "Bearer " (prefix with nothing after it) reduces to undefined
 * rather than "Bearer", which is why the prefix is removed before trimming.
 *
 * @param {string|undefined} value - Raw credential string
 * @returns {string|undefined}
 */
function stripBearerPrefix(value) {
  return ((value || '').replace(/^\s*(?:Bearer|token)\s+/i, '').trim()) || undefined;
}

/**
 * Returns the COPILOT_PROVIDER_API_KEY value from env if it is a real BYOK credential,
 * or undefined in two cases:
 *   1. COPILOT_PROVIDER_API_KEY is not set (or is empty/whitespace-only).
 *   2. COPILOT_PROVIDER_API_KEY equals the known AWF placeholder sentinel — it was injected
 *      by AWF for credential isolation and is not a usable BYOK credential.
 *
 * The case-(2) placeholder check is defense-in-depth: in AWF's normal flow the placeholder
 * is never written into the sidecar's own COPILOT_PROVIDER_API_KEY (src/services/api-proxy-
 * service-config.ts only forwards a real user-supplied BYOK key). If a future refactor,
 * misconfiguration, or standalone use of the sidecar image ever caused the agent's env
 * (which does contain the placeholder) to be passed through to the sidecar, we must treat
 * it as absent so that the placeholder is not used as a real Authorization credential
 * against an upstream provider.
 *
 * @param {Record<string, string|undefined>} env - Environment variables to inspect
 * @returns {string|undefined} The real BYOK key, or undefined when absent or placeholder.
 */
function resolveApiKey(env) {
  const key = stripBearerPrefix(env.COPILOT_PROVIDER_API_KEY);
  return key === COPILOT_PLACEHOLDER_TOKEN ? undefined : key;
}

/**
 * Resolves the Copilot auth token from environment variables.
 * COPILOT_PROVIDER_API_KEY (direct BYOK key) takes precedence over COPILOT_GITHUB_TOKEN (GitHub OAuth).
 *
 * The AWF placeholder token is treated as absent (via resolveApiKey) so that when AWF
 * injects it as a dummy COPILOT_PROVIDER_API_KEY the sidecar falls back to COPILOT_GITHUB_TOKEN.
 * This ensures that when a real BYOK key is configured alongside a GitHub token, the BYOK
 * key is used for inference rather than inadvertently sending a GitHub OAuth token to a
 * third-party provider.
 *
 * Any accidental "Bearer " prefix is stripped via stripBearerPrefix so that
 * the injected Authorization header is exactly "Bearer <token>" rather than
 * the double-prefixed "Bearer Bearer <token>" that would be rejected by
 * external providers in BYOK mode.
 *
 * @param {Record<string, string|undefined>} env - Environment variables to inspect
 * @returns {string|undefined} The resolved auth token, or undefined if neither is set
 */
function resolveCopilotAuthToken(env = process.env) {
  return resolveApiKey(env) || stripBearerPrefix(env.COPILOT_GITHUB_TOKEN);
}

/**
 * Derive the Copilot API target hostname from environment variables.
 *
 * Priority:
 *   1. Explicit COPILOT_API_TARGET env var
 *   2. Auto-derived from GITHUB_SERVER_URL:
 *      - *.ghe.com (GHEC tenant) → copilot-api.<subdomain>.ghe.com
 *      - Other non-github.com  (GHES)   → api.enterprise.githubcopilot.com
 *   3. Default: api.githubcopilot.com
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @returns {string} Copilot API target hostname
 */
function deriveCopilotApiTarget(env = process.env) {
  if (env.COPILOT_API_TARGET) {
    const target = normalizeApiTarget(env.COPILOT_API_TARGET);
    // Only use the explicit value if it parsed into a valid hostname;
    // fall through to auto-derivation when the value is malformed.
    if (target) return target;
  }
  const serverUrl = env.GITHUB_SERVER_URL;
  if (serverUrl) {
    try {
      const hostname = new URL(serverUrl).hostname;
      if (hostname !== 'github.com') {
        if (hostname.endsWith('.ghe.com')) {
          const subdomain = hostname.slice(0, -8); // Remove '.ghe.com'
          return `copilot-api.${subdomain}.ghe.com`;
        }
        return 'api.enterprise.githubcopilot.com';
      }
    } catch {
      // Invalid URL — fall through to default
    }
  }
  return 'api.githubcopilot.com';
}

/**
 * Derive the GitHub REST API target hostname (used for GHES/GHEC endpoints).
 *
 * Priority:
 *   1. Explicit GITHUB_API_URL env var (hostname extracted)
 *   2. Auto-derived from GITHUB_SERVER_URL for GHEC tenants (*.ghe.com)
 *   3. Default: api.github.com
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @returns {string} GitHub REST API target hostname
 */
function deriveGitHubApiTarget(env = process.env) {
  if (env.GITHUB_API_URL) {
    const target = normalizeApiTarget(env.GITHUB_API_URL);
    if (target) return target;
  }
  const serverUrl = env.GITHUB_SERVER_URL;
  if (serverUrl) {
    try {
      const hostname = new URL(serverUrl).hostname;
      if (hostname !== 'github.com' && hostname.endsWith('.ghe.com')) {
        const subdomain = hostname.slice(0, -8);
        return `api.${subdomain}.ghe.com`;
      }
    } catch {
      // Invalid URL — fall through to default
    }
  }
  return 'api.github.com';
}

/**
 * Extract the base path from GITHUB_API_URL for GHES deployments
 * (e.g. https://ghes.example.com/api/v3 → '/api/v3').
 * Returns '' for github.com or when no path component is present.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @returns {string} Base path or ''
 */
function deriveGitHubApiBasePath(env = process.env) {
  const raw = env.GITHUB_API_URL;
  if (!raw) return '';
  try {
    const parsed = new URL(raw.trim().startsWith('http') ? raw.trim() : `https://${raw.trim()}`);
    const p = parsed.pathname.replace(/\/+$/, '');
    return p === '/' ? '' : p;
  } catch {
    return '';
  }
}

function isGithubCopilotCatalogTarget(rawTarget) {
  const target = normalizeApiTarget(rawTarget);
  if (!target) return true;
  return target === 'api.githubcopilot.com'
    || target === 'api.enterprise.githubcopilot.com'
    || target.endsWith('.githubcopilot.com')
    || target.endsWith('.ghe.com');
}

function getCopilotModelFallbackPolicy(modelFallback, env = process.env) {
  if (!modelFallback.enabled) {
    return { effective: modelFallback, suppressed: false };
  }

  const hasByokHints = Boolean(
    (env.COPILOT_PROVIDER_TYPE || '').trim()
    || (env.COPILOT_PROVIDER_BASE_URL || '').trim()
    || (env.COPILOT_PROVIDER_API_KEY || '').trim()
  );

  // Standard Copilot (no BYOK hints): suppress fallback because Copilot is
  // authoritative for its own model catalogue. Rewriting a retired/restricted
  // model to a middle-power fallback obscures the real error.
  if (!hasByokHints) {
    return {
      effective: { ...modelFallback, enabled: false },
      suppressed: true,
      suppression_reason: 'copilot_standard_authoritative',
    };
  }

  // BYOK pointing at a GitHub Copilot catalog target — still suppress because
  // the catalog is authoritative.
  if (isGithubCopilotCatalogTarget(env.COPILOT_API_TARGET)) {
    return {
      effective: { ...modelFallback, enabled: false },
      suppressed: true,
      suppression_reason: 'copilot_catalog_target_authoritative',
    };
  }

  // BYOK pointing at a non-GitHub target (Azure, custom OpenAI, etc.)
  return {
    effective: { ...modelFallback, enabled: false },
    suppressed: true,
    suppression_reason: 'copilot_byok_non_githubcopilot_target',
  };
}

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
  const integrationId = env.COPILOT_INTEGRATION_ID || 'copilot-developer-cli';
  const rawTarget = deriveCopilotApiTarget(env);
  const basePath = normalizeBasePath(env.COPILOT_API_BASE_PATH);

  // OIDC auth strategy (Azure OpenAI via Entra, AWS Bedrock, GCP Vertex AI) for
  // BYOK targets pointed at by COPILOT_PROVIDER_BASE_URL. Mirrors the OpenAI
  // adapter's OIDC plumbing so the Copilot CLI's direct-BYOK path can exchange a
  // GitHub Actions OIDC JWT for an upstream cloud token instead of requiring a
  // static COPILOT_PROVIDER_API_KEY.
  const authType = (env.AWF_AUTH_TYPE || '').trim().toLowerCase();
  const authProvider = (env.AWF_AUTH_PROVIDER || 'azure').trim().toLowerCase();
  let oidcProvider = null;
  let awsOidcProvider = null;
  if (authType === 'github-oidc' && !staticAuthToken) {
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

  // authToken is consumed by the existing validation/models-fetch/auth-header paths.
  // For OIDC mode the token isn't available synchronously at construction time, so
  // we surface a non-empty marker here to keep alwaysBind/isEnabled probes happy and
  // resolve the real token lazily inside getAuthHeaders.
  const authToken = staticAuthToken;
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
            'Authorization': `Bearer ${githubToken}`,
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
              'Authorization': `Bearer ${githubToken}`,
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
            'Authorization': `Bearer ${apiKey}`,
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
    isEnabled() {
      return !!authToken || !!oidcProvider?.isReady() || !!awsOidcProvider?.isReady();
    },

    /**
     * Get the OIDC token provider (Azure or GCP — Bearer-token compatible).
     * Used by startup.js to initialize OIDC on startup.
     */
    getOidcProvider() { return oidcProvider; },

    /**
     * Get the AWS OIDC credential provider (SigV4-based).
     * Used by startup.js to initialize AWS OIDC on startup and sign requests.
     */
    getAwsOidcProvider() { return awsOidcProvider; },

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

      const isModelsPath = reqPathname === '/models' || reqPathname.startsWith('/models/');
      if (isModelsPath && req.method === 'GET' && githubToken) {
        return {
          'Authorization': `Bearer ${githubToken}`,
          'Copilot-Integration-Id': integrationId,
        };
      }

      // OIDC (Bearer): Azure Entra / GCP. Acquired lazily, refreshed by the provider.
      if (oidcProvider) {
        const token = oidcProvider.getToken();
        if (token) {
          return {
            'Authorization': `Bearer ${token}`,
            'Copilot-Integration-Id': integrationId,
          };
        }
        // Token not yet available — return no auth header. The proxy layer will
        // fall back to getUnconfiguredResponse and emit a clear 503.
        return {};
      }
      // AWS OIDC: SigV4 signing is handled at the request layer; emit no static header here.
      if (awsOidcProvider) {
        return {};
      }

      return {
        ...(apiKey ? byokExtraHeaders : {}),
        'Authorization': `Bearer ${authToken}`,
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
        return {
          statusCode: 503,
          body: { status: 'not_configured', service: 'awf-api-proxy-copilot', error: `Copilot OIDC token (${authProvider}) not yet available in api-proxy sidecar` },
        };
      }
      return {
        statusCode: 503,
        body: { status: 'not_configured', service: 'awf-api-proxy-copilot', error: 'COPILOT_GITHUB_TOKEN or COPILOT_PROVIDER_API_KEY not configured in api-proxy sidecar' },
      };
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
  getCopilotModelFallbackPolicy,
  // Exported for unit-test access only; not part of the public API.
  _testing: {
    resolveCopilotAuthToken,
    resolveApiKey,
    stripBearerPrefix,
    deriveCopilotApiTarget,
    deriveGitHubApiTarget,
    deriveGitHubApiBasePath,
    isGithubCopilotCatalogTarget,
    COPILOT_PLACEHOLDER_TOKEN,
    parseByokExtraHeaders,
    parseByokExtraBodyFields,
    injectByokExtraBodyFields,
  },
};
