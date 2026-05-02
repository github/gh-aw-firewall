'use strict';

/**
 * OpenCode provider adapter.
 *
 * Port: 10004  (only started when AWF_ENABLE_OPENCODE=true)
 * Auth: dynamic — resolved at request time based on available credentials
 * Credentials: OPENAI_API_KEY > ANTHROPIC_API_KEY > COPILOT_GITHUB_TOKEN / COPILOT_API_KEY
 *
 * OpenCode gets its own isolated port rather than sharing with Claude (10001)
 * or Codex (10000) to enable per-engine rate limiting and metrics isolation.
 *
 * Credential priority (first available wins):
 *   1. OPENAI_API_KEY → OpenAI/Copilot-compatible route (OPENAI_API_TARGET)
 *   2. ANTHROPIC_API_KEY → Anthropic BYOK route (ANTHROPIC_API_TARGET)
 *   3. COPILOT_GITHUB_TOKEN / COPILOT_API_KEY → Copilot route (COPILOT_API_TARGET)
 */

const { normalizeApiTarget, normalizeBasePath } = require('../proxy-utils');
const { deriveCopilotApiTarget, resolveCopilotAuthToken } = require('./copilot');
const COPILOT_INTEGRATION_ID_DEFAULT = 'copilot-developer-cli';

/**
 * Resolve the upstream route for an OpenCode request based on available credentials.
 *
 * @param {string|undefined} openaiKey
 * @param {string|undefined} anthropicKey
 * @param {string|undefined} copilotToken
 * @param {string} openaiTarget
 * @param {string} anthropicTarget
 * @param {string} copilotTarget
 * @param {string} [openaiBasePath]
 * @param {string} [anthropicBasePath]
 * @param {string} [integrationId]
 * @returns {{ target: string, headers: Record<string,string>, basePath: string|undefined, needsAnthropicVersion: boolean } | null}
 */
function resolveOpenCodeRoute(
  openaiKey, anthropicKey, copilotToken,
  openaiTarget, anthropicTarget, copilotTarget,
  openaiBasePath, anthropicBasePath,
  integrationId
) {
  if (openaiKey) {
    return { target: openaiTarget, headers: { 'Authorization': `Bearer ${openaiKey}` }, basePath: openaiBasePath, needsAnthropicVersion: false };
  }
  if (anthropicKey) {
    return { target: anthropicTarget, headers: { 'x-api-key': anthropicKey }, basePath: anthropicBasePath, needsAnthropicVersion: true };
  }
  if (copilotToken) {
    return {
      target: copilotTarget,
      headers: { 'Authorization': `Bearer ${copilotToken}`, 'Copilot-Integration-Id': integrationId || COPILOT_INTEGRATION_ID_DEFAULT },
      basePath: undefined,
      needsAnthropicVersion: false,
    };
  }
  return null;
}

/**
 * Create the OpenCode provider adapter.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @returns {import('./index').ProviderAdapter}
 */
function createOpenCodeAdapter(env) {
  const enabled = env.AWF_ENABLE_OPENCODE === 'true';

  const openaiKey = (env.OPENAI_API_KEY || '').trim() || undefined;
  const anthropicKey = (env.ANTHROPIC_API_KEY || '').trim() || undefined;
  const copilotToken = resolveCopilotAuthToken(env);
  const integrationId = env.COPILOT_INTEGRATION_ID || COPILOT_INTEGRATION_ID_DEFAULT;

  const openaiTarget = normalizeApiTarget(env.OPENAI_API_TARGET) || 'api.openai.com';
  const anthropicTarget = normalizeApiTarget(env.ANTHROPIC_API_TARGET) || 'api.anthropic.com';
  const copilotTarget = deriveCopilotApiTarget(env);

  // OpenAI path has a /v1 default (same logic as the OpenAI adapter)
  const explicitOpenAIBasePath = normalizeBasePath(env.OPENAI_API_BASE_PATH);
  const openaiBasePath = explicitOpenAIBasePath || (openaiTarget === 'api.openai.com' ? '/v1' : '');
  const anthropicBasePath = normalizeBasePath(env.ANTHROPIC_API_BASE_PATH);

  /**
   * Resolve the current route.  Called per-request so that if credentials are
   * rotated without restarting the container, the new values are picked up.
   * In practice env vars don't change at runtime; this keeps the adapter pure.
   */
  function resolveRoute() {
    return resolveOpenCodeRoute(
      openaiKey, anthropicKey, copilotToken,
      openaiTarget, anthropicTarget, copilotTarget,
      openaiBasePath, anthropicBasePath,
      integrationId
    );
  }

  const startupRoute = enabled ? resolveRoute() : null;

  return {
    name: 'opencode',
    port: 10004,
    isManagementPort: false,
    alwaysBind: false,
    get participatesInValidation() { return this.isEnabled(); },

    isEnabled() { return enabled && !!resolveRoute(); },

    getTargetHost(req) {
      const route = resolveRoute();
      return route ? route.target : '';
    },

    getBasePath(req) {
      const route = resolveRoute();
      return route ? (route.basePath || '') : '';
    },

    /**
     * Build auth headers for the resolved upstream provider.
     * Adds anthropic-version default when routing to the Anthropic target.
     *
     * @param {import('http').IncomingMessage} req
     * @returns {Record<string, string>}
     */
    getAuthHeaders(req) {
      const route = resolveRoute();
      if (!route) return {};

      const headers = Object.assign({}, route.headers);
      if (route.needsAnthropicVersion && !req.headers['anthropic-version']) {
        headers['anthropic-version'] = '2023-06-01';
      }
      return headers;
    },

    getBodyTransform() { return null; },

    // OpenCode is a routing layer over the base providers; those providers
    // handle their own startup validation and model fetching.
    getValidationProbe() { return null; },
    getModelsFetchConfig() { return null; },

    getReflectionInfo() {
      return {
        provider: 'opencode',
        port: 10004,
        base_url: 'http://api-proxy:10004',
        configured: enabled && !!startupRoute,
        models_cache_key: null,
        models_url: null,
      };
    },

    // Exposed for introspection / testing
    _startupRoute: startupRoute,
  };
}

module.exports = { createOpenCodeAdapter, resolveOpenCodeRoute };
