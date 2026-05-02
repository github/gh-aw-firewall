'use strict';

/**
 * GitHub Copilot provider adapter.
 *
 * Port: 10002
 * Auth: Bearer token (COPILOT_GITHUB_TOKEN or COPILOT_API_KEY)
 * Credentials: COPILOT_GITHUB_TOKEN (GitHub OAuth, higher trust) or COPILOT_API_KEY (BYOK)
 * Target: COPILOT_API_TARGET  (auto-derived from GITHUB_SERVER_URL if not set)
 * Base path: none (Copilot inference API manages its own path layout)
 *
 * Special routing: GET /models (and /models/*) always uses COPILOT_GITHUB_TOKEN
 * regardless of which auth mode is active, because the /models endpoint only
 * accepts OAuth tokens, not API keys.
 */

const { normalizeApiTarget } = require('../proxy-utils');
const { URL } = require('url');

/**
 * Resolves the Copilot auth token from environment variables.
 * COPILOT_GITHUB_TOKEN (GitHub OAuth) takes precedence over COPILOT_API_KEY (direct key).
 *
 * @param {Record<string, string|undefined>} env - Environment variables to inspect
 * @returns {string|undefined} The resolved auth token, or undefined if neither is set
 */
function resolveCopilotAuthToken(env = process.env) {
  const githubToken = (env.COPILOT_GITHUB_TOKEN || '').trim() || undefined;
  const apiKey = (env.COPILOT_API_KEY || '').trim() || undefined;
  return githubToken || apiKey;
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

/**
 * Create the GitHub Copilot provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ bodyTransform: ((body: Buffer) => Buffer|null)|null }} deps - Injected dependencies
 * @returns {import('./index').ProviderAdapter}
 */
function createCopilotAdapter(env, deps = {}) {
  const githubToken = (env.COPILOT_GITHUB_TOKEN || '').trim() || undefined;
  const apiKey = (env.COPILOT_API_KEY || '').trim() || undefined;
  const authToken = resolveCopilotAuthToken(env);
  const integrationId = env.COPILOT_INTEGRATION_ID || 'copilot-developer-cli';
  const rawTarget = deriveCopilotApiTarget(env);

  const bodyTransform = deps.bodyTransform || null;

  return {
    name: 'copilot',
    port: 10002,
    isManagementPort: false,
    alwaysBind: false,
    get participatesInValidation() { return this.isEnabled(); },

    isEnabled() { return !!authToken; },
    getTargetHost() { return rawTarget; },
    getBasePath() { return ''; },

    /**
     * Build Copilot auth headers for this request.
     *
     * The Copilot /models endpoint only accepts COPILOT_GITHUB_TOKEN (GitHub OAuth).
     * All other requests use the resolved auth token (COPILOT_GITHUB_TOKEN or COPILOT_API_KEY).
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

      return {
        'Authorization': `Bearer ${authToken}`,
        'Copilot-Integration-Id': integrationId,
      };
    },

    getBodyTransform() { return bodyTransform; },

    getValidationProbe() {
      if (!authToken) return null;

      // Only COPILOT_GITHUB_TOKEN has a probe endpoint (/models).
      // COPILOT_API_KEY alone cannot be validated at startup.
      if (!githubToken) {
        return {
          skip: true,
          reason: 'COPILOT_API_KEY configured but startup validation is not supported for this auth mode',
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
      // Only COPILOT_GITHUB_TOKEN is accepted by the /models endpoint
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
    },

    getReflectionInfo() {
      return {
        provider: 'copilot',
        port: 10002,
        base_url: 'http://api-proxy:10002',
        configured: !!authToken,
        models_cache_key: 'copilot',
        models_url: 'http://api-proxy:10002/models',
      };
    },

    // Exposed for introspection / testing
    _githubToken: githubToken,
    _apiKey: apiKey,
    _integrationId: integrationId,
    _rawTarget: rawTarget,
  };
}

module.exports = {
  createCopilotAdapter,
  resolveCopilotAuthToken,
  deriveCopilotApiTarget,
  deriveGitHubApiTarget,
  deriveGitHubApiBasePath,
};
