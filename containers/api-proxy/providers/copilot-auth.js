'use strict';

const { normalizeApiTarget } = require('../proxy-utils');
const { COPILOT_PLACEHOLDER_TOKEN } = require('./copilot-byok');
const { URL } = require('url');

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
 * the injected Authorization header contains a single bearer token value rather
 * than a malformed double-prefixed value that external providers would reject
 * in BYOK mode.
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

module.exports = {
  stripBearerPrefix,
  resolveApiKey,
  resolveCopilotAuthToken,
  deriveCopilotApiTarget,
  deriveGitHubApiTarget,
  deriveGitHubApiBasePath,
  isGithubCopilotCatalogTarget,
  getCopilotModelFallbackPolicy,
  // Exported for unit-test access only; not part of the public API.
  _testing: {
    stripBearerPrefix,
    resolveApiKey,
    resolveCopilotAuthToken,
    deriveCopilotApiTarget,
    deriveGitHubApiTarget,
    deriveGitHubApiBasePath,
    isGithubCopilotCatalogTarget,
    getCopilotModelFallbackPolicy,
  },
};
