'use strict';

/**
 * OpenCode provider adapter.
 *
 * Port: 10004  (only started when AWF_ENABLE_OPENCODE=true)
 * Auth: dynamic — delegated to the first enabled candidate adapter
 *
 * OpenCode gets its own isolated port rather than sharing with Claude (10001)
 * or Codex (10000) to enable per-engine rate limiting and metrics isolation.
 *
 * Routing priority is determined by the order of the `candidateAdapters` array
 * supplied at construction time (see providers/index.js).  The first enabled
 * adapter in the list wins.  No code change to this file is needed when a new
 * provider is added to the candidate list.
 *
 * Default priority (OpenAI > Anthropic > Copilot) is defined in index.js:
 *   createOpenCodeAdapter(env, { candidateAdapters: [openai, anthropic, copilot] })
 *
 * To change the routing order or add a new provider, edit the candidateAdapters
 * array in providers/index.js — this file stays unchanged.
 */

/**
 * Resolve the upstream route for an OpenCode request based on available credentials.
 * This is the legacy low-level helper; the adapter now uses candidateAdapters instead.
 * Kept as an export for backward compatibility with existing tests.
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
  const COPILOT_INTEGRATION_ID_DEFAULT = 'copilot-developer-cli';
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
 * The adapter is a transparent routing layer: all per-request decisions
 * (target host, base path, auth headers, body transforms, URL transforms)
 * are fully delegated to whichever candidate adapter is currently enabled.
 *
 * This means:
 *   - All active providers remain independently reachable on their own ports.
 *   - OpenCode gets the full auth + transform logic of the underlying provider
 *     for free — no duplication.
 *   - Changing the routing order or adding a new provider only requires
 *     updating the `candidateAdapters` array in providers/index.js.
 *
 * @param {Record<string, string|undefined>} env - Environment variables
 * @param {{ candidateAdapters?: import('./index').ProviderAdapter[] }} [opts]
 *   Ordered list of adapters to consider for routing; the first enabled one is used.
 *   Pass an empty array (default) to disable OpenCode regardless of env vars.
 * @returns {import('./index').ProviderAdapter}
 */
function createOpenCodeAdapter(env, { candidateAdapters = [] } = {}) {
  const enabled = env.AWF_ENABLE_OPENCODE === 'true';

  /**
   * Return the first enabled candidate adapter, or null if none is active.
   * Called per-request so that credential changes are picked up without restart.
   *
   * @returns {import('./index').ProviderAdapter | null}
   */
  function resolveActiveAdapter() {
    return candidateAdapters.find(a => a.isEnabled()) || null;
  }

  // Snapshot at startup for reflection info (stable across requests)
  const startupActiveAdapter = enabled ? resolveActiveAdapter() : null;

  return {
    name: 'opencode',
    port: 10004,
    isManagementPort: false,

    /**
     * Port 10004 always starts so agents get a clear 503 "not configured"
     * error rather than a silent connection-refused.
     */
    alwaysBind: true,

    /**
     * The stub server does NOT count toward the startup validation latch —
     * only the fully-configured server (when enabled and a candidate is active) does.
     */
    get participatesInValidation() { return this.isEnabled(); },

    isEnabled() { return enabled && !!resolveActiveAdapter(); },

    /** Delegate to the active candidate adapter. */
    getTargetHost(req) {
      return resolveActiveAdapter()?.getTargetHost(req) || '';
    },

    /** Delegate to the active candidate adapter. */
    getBasePath(req) {
      return resolveActiveAdapter()?.getBasePath(req) || '';
    },

    /**
     * Delegate auth headers to the active candidate adapter.
     * Each provider's full auth logic (token selection, version headers,
     * beta flags, integration IDs) is applied automatically.
     *
     * @param {import('http').IncomingMessage} req
     * @returns {Record<string, string>}
     */
    getAuthHeaders(req) {
      return resolveActiveAdapter()?.getAuthHeaders(req) || {};
    },

    /**
     * Delegate URL transformation to the active candidate adapter.
     * Applies the active provider's URL transform (e.g. Gemini key-param
     * stripping) when one is defined, otherwise returns url unchanged.
     *
     * @param {string} url
     * @returns {string}
     */
    transformRequestUrl(url) {
      const active = resolveActiveAdapter();
      return active?.transformRequestUrl ? active.transformRequestUrl(url) : url;
    },

    /**
     * Delegate body transforms to the active candidate adapter.
     * This gives OpenCode model-alias rewriting and provider-specific
     * optimizations (e.g. Anthropic cache injection) for free.
     *
     * @returns {((body: Buffer) => Buffer|null)|null}
     */
    getBodyTransform() {
      return resolveActiveAdapter()?.getBodyTransform() || null;
    },

    // OpenCode is a routing layer over the base providers; those providers
    // handle their own startup validation and model fetching.
    getValidationProbe() { return null; },
    getModelsFetchConfig() { return null; },

    getReflectionInfo() {
      return {
        provider: 'opencode',
        port: 10004,
        base_url: 'http://api-proxy:10004',
        configured: enabled && !!startupActiveAdapter,
        models_cache_key: null,
        models_url: null,
      };
    },

    /** Response returned for all requests when OpenCode is not configured. */
    getUnconfiguredResponse() {
      if (!enabled) {
        return {
          statusCode: 503,
          body: {
            error: {
              message: 'OpenCode proxy (port 10004) is not enabled. Set AWF_ENABLE_OPENCODE=true and configure at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, or COPILOT_GITHUB_TOKEN.',
              type: 'provider_not_configured',
              provider: 'opencode',
              port: 10004,
            },
          },
        };
      }
      return {
        statusCode: 503,
        body: {
          error: {
            message: 'Credentials for OpenCode (port 10004) are not configured. Set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, or COPILOT_GITHUB_TOKEN.',
            type: 'provider_not_configured',
            provider: 'opencode',
            port: 10004,
          },
        },
      };
    },

    /** /health response when not configured. */
    getUnconfiguredHealthResponse() {
      const reason = !enabled
        ? 'AWF_ENABLE_OPENCODE not set to true'
        : 'no candidate provider credentials configured';
      return {
        statusCode: 503,
        body: { status: 'not_configured', service: 'awf-api-proxy-opencode', error: `OpenCode proxy not configured: ${reason}` },
      };
    },

    // Exposed for introspection / testing
    _startupActiveAdapterName: startupActiveAdapter?.name || null,
    _candidateAdapters: candidateAdapters,
  };
}

module.exports = { createOpenCodeAdapter, resolveOpenCodeRoute };
