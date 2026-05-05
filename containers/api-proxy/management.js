'use strict';

/**
 * AWF API Proxy — Management Endpoint Handlers
 *
 * Responsibilities:
 *   1. /health — aggregate health and key-validation status
 *   2. /metrics — raw metrics snapshot
 *   3. /reflect — list all proxy endpoints with their models cache
 *   4. handleManagementEndpoint — route the above on the designated management port
 *
 * All functions are returned by createManagementHandlers(), which accepts
 * getter callbacks for the shared server state (adapters, models cache, etc.)
 * so that this module has zero direct dependency on server.js module-level state.
 */

const metrics = require('./metrics');

/**
 * @typedef {object} ManagementDeps
 * @property {() => Array<object>}  getAdapters           - Returns registered adapters array
 * @property {() => Record<string, string[]|null>} getCachedModels - Returns model cache object
 * @property {() => boolean}        isModelFetchComplete  - Whether startup model fetch has run
 * @property {() => { complete: boolean, results: Record<string, object> }} getKeyValidationState
 * @property {() => import('./rate-limiter').RateLimiter} getLimiter
 * @property {string|undefined}     httpsProxy            - Value of HTTPS_PROXY env var at startup
 * @property {() => object|null}    getModelAliases       - Returns parsed MODEL_ALIASES (or null)
 */

/**
 * Create management endpoint handler functions bound to the given server state.
 *
 * Returns: { healthResponse, reflectEndpoints, handleManagementEndpoint }
 *
 * @param {ManagementDeps} deps
 * @returns {{ healthResponse: Function, reflectEndpoints: Function, handleManagementEndpoint: Function }}
 */
function createManagementHandlers(deps) {
  const {
    getAdapters,
    getCachedModels,
    isModelFetchComplete,
    getKeyValidationState,
    getLimiter,
    httpsProxy,
    getModelAliases,
  } = deps;

  /**
   * Build the health response payload.
   *
   * @returns {object}
   */
  function healthResponse() {
    const providers = {};
    for (const adapter of getAdapters()) {
      providers[adapter.name] = adapter.isEnabled();
    }
    const { complete: kvComplete, results: kvResults } = getKeyValidationState();
    return {
      status: 'healthy',
      service: 'awf-api-proxy',
      squid_proxy: httpsProxy || 'not configured',
      providers,
      key_validation: { complete: kvComplete, results: kvResults },
      models_fetch_complete: isModelFetchComplete(),
      metrics_summary: metrics.getSummary(),
      rate_limits: getLimiter().getAllStatus(),
    };
  }

  /**
   * Build the reflection response describing all proxy endpoints and their available models.
   *
   * @returns {{ endpoints: Array<object>, models_fetch_complete: boolean, model_aliases: object|null }}
   */
  function reflectEndpoints() {
    const cachedModels = getCachedModels();
    const modelAliases = getModelAliases();
    return {
      endpoints: getAdapters().map(adapter => {
        const info = adapter.getReflectionInfo();
        return {
          provider:   info.provider,
          port:       info.port,
          base_url:   info.base_url,
          configured: info.configured,
          models:     info.models_cache_key !== null ? (cachedModels[info.models_cache_key] || null) : null,
          models_url: info.models_url,
        };
      }),
      models_fetch_complete: isModelFetchComplete(),
      model_aliases: modelAliases ? modelAliases.models : null,
    };
  }

  /**
   * Handle management endpoints on port 10000 (/health, /metrics, /reflect).
   * Returns true if the request was handled, false otherwise.
   *
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @returns {boolean}
   */
  function handleManagementEndpoint(req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(healthResponse()));
      return true;
    }
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics.getMetrics()));
      return true;
    }
    if (req.method === 'GET' && req.url === '/reflect') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reflectEndpoints()));
      return true;
    }
    return false;
  }

  return { healthResponse, reflectEndpoints, handleManagementEndpoint };
}

module.exports = { createManagementHandlers };
