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
const {
  getModelApiMappingReflect,
  lookupModelEndpoints,
  lookupModelRoutingMetadata,
} = require('./model-api-mapping');
const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');
const { normalizeModel } = require('./routing-catalogue');
const { getModelRoutingChoices } = require('./routing-candidates');
const { reflectScopedAuto } = require('./scoped-auto-model');

function filterModelCatalogue(entries, provider, modelPolicy, getModel) {
  if (!Array.isArray(entries) || !modelPolicy ||
      (!modelPolicy.allowedModels?.length && !modelPolicy.disallowedModels?.length)) {
    return entries;
  }
  return entries.filter(entry => {
    const model = getModel(entry);
    return typeof model !== 'string' || isModelPermittedByPolicy(
      model,
      modelPolicy.allowedModels ?? null,
      modelPolicy.disallowedModels ?? null,
      provider,
    );
  });
}

function buildRoutingModelMetadata(provider, modelIds, runtimeRecords) {
  if (!Array.isArray(modelIds)) return null;
  const runtimeById = new Map(
    (Array.isArray(runtimeRecords) ? runtimeRecords : [])
      .filter(record => typeof record?.id === 'string')
      .map(record => [record.id.toLowerCase(), record]),
  );
  return modelIds.map(id => {
    const runtime = runtimeById.get(id.toLowerCase());
    const maintained = lookupModelRoutingMetadata(id, provider);
    const endpointMapping = lookupModelEndpoints(id, provider);
    const normalized = normalizeModel(id, runtime, provider);
    const efforts = Array.isArray(normalized.efforts) ? normalized.efforts : null;
    const endpoints = Array.isArray(runtime?.supportedEndpoints)
      ? runtime.supportedEndpoints
      : (endpointMapping?.endpoints || []);
    const runtimeHasMetadata = Array.isArray(runtime?.supportedReasoningEfforts) ||
      Array.isArray(runtime?.capabilities?.supports?.reasoning_effort) ||
      runtime?.capabilities?.supports?.reasoningEffort === false ||
      Array.isArray(runtime?.supportedEndpoints) ||
      typeof runtime?.modelPickerEnabled === 'boolean' ||
      (Number.isInteger(runtime?.capabilities?.limits?.max_context_window_tokens) &&
        runtime.capabilities.limits.max_context_window_tokens > 0);
    const hasMaintainedMetadata = maintained !== null;
    const candidateMetadataComplete = getModelRoutingChoices(normalized, provider).length > 0;
    return {
      model_id: id,
      source: runtimeHasMetadata && hasMaintainedMetadata
        ? 'provider+maintained'
        : (runtimeHasMetadata ? 'provider' : (hasMaintainedMetadata ? 'maintained' : 'incomplete')),
      supported_endpoints: endpoints,
      supported_reasoning_efforts: efforts,
      context_window_tokens: normalized.contextWindow ?? null,
      candidate_metadata_complete: candidateMetadataComplete,
      ...(provider === 'copilot' && runtime?.modelPickerEnabled === false
        ? { candidate_metadata_reason: 'Model is not enabled in the Copilot model picker' }
        : {}),
    };
  });
}

/**
 * @typedef {object} ManagementDeps
 * @property {() => Array<object>}  getAdapters           - Returns registered adapters array
 * @property {() => Record<string, string[]|null>} getCachedModels - Returns model cache object
 * @property {() => Record<string, object[]>} getRuntimeModelMetadata - Returns sanitized runtime metadata
 * @property {() => Record<string, object[]>} [getRoutingModelMetadata] - Returns private runtime metadata for routing normalization
 * @property {() => boolean}        isModelFetchComplete  - Whether startup model fetch has run
 * @property {() => { complete: boolean, results: Record<string, object> }} getKeyValidationState
 * @property {() => import('./rate-limiter').RateLimiter} getLimiter
 * @property {string|undefined}     httpsProxy            - Value of HTTPS_PROXY env var at startup
 * @property {() => object|null}    getModelAliases       - Returns parsed MODEL_ALIASES (or null)
 * @property {() => { enabled: boolean, strategy: string }} getModelFallback - Returns fallback config
 * @property {() => Record<string, { enabled: boolean, strategy: string, suppressed: boolean, suppression_reason?: string }>} getEffectiveModelFallback - Returns provider-effective fallback summary
 * @property {() => object}         getAiCreditsUsage     - Returns AI credits usage summary
 * @property {() => object}         getMaxRunsUsage        - Returns max-runs usage summary
 * @property {() => object}         getMaxCacheMissesUsage - Returns max-cache-misses usage summary
 * @property {() => object}         getPermissionDeniedUsage - Returns permission-denied usage summary
 * @property {{ allowedModels?: string[]|null, disallowedModels?: string[]|null }|null} [modelPolicy]
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
    getRuntimeModelMetadata = () => ({}),
    getRoutingModelMetadata,
    isModelFetchComplete,
    getKeyValidationState,
    getLimiter,
    httpsProxy,
    getModelAliases,
    getModelFallback,
    getEffectiveModelFallback,
    getAiCreditsUsage,
    getMaxRunsUsage,
    getMaxCacheMissesUsage,
    getPermissionDeniedUsage,
    getRoutingState = () => null,
    modelPolicy = null,
  } = deps;
  const getPrivateRoutingModelMetadata = getRoutingModelMetadata || getRuntimeModelMetadata;

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
    const runtimeModelMetadata = getRuntimeModelMetadata();
    const routingModelMetadata = getPrivateRoutingModelMetadata();
    const modelAliases = getModelAliases();
    return {
      endpoints: getAdapters().map(adapter => {
        const info = adapter.getReflectionInfo();
        const providerModels = info.models_cache_key !== null
          ? (cachedModels[info.models_cache_key] || null)
          : null;
        const models = filterModelCatalogue(providerModels, adapter.name, modelPolicy, model => model);
        const modelMetadata = filterModelCatalogue(
          runtimeModelMetadata[adapter.name] || null,
          adapter.name,
          modelPolicy,
          record => record?.id,
        );
        const privateRoutingModelMetadata = filterModelCatalogue(
          routingModelMetadata[adapter.name] || null,
          adapter.name,
          modelPolicy,
          record => record?.id,
        );
        return {
          provider:   info.provider,
          port:       info.port,
          base_url:   info.base_url,
          configured: info.configured,
          models,
          model_metadata: modelMetadata,
          automatic_model_selection: reflectScopedAuto(
            adapter.name, models, privateRoutingModelMetadata, modelPolicy,
          ),
          routing_models: buildRoutingModelMetadata(
            adapter.name,
            models,
            privateRoutingModelMetadata,
          ),
          models_url: info.models_url,
          ...(info.credential_kind !== undefined && { credential_kind: info.credential_kind }),
          ...(info.selected_scheme !== undefined && { selected_scheme: info.selected_scheme }),
          ...(info.inference_credential_source !== undefined && { inference_credential_source: info.inference_credential_source }),
          ...(info.inference_selected_scheme !== undefined && { inference_selected_scheme: info.inference_selected_scheme }),
          ...(info.integration_id_source !== undefined && { integration_id_source: info.integration_id_source }),
        };
      }),
      models_fetch_complete: isModelFetchComplete(),
      model_aliases: modelAliases ? modelAliases.models : null,
      model_fallback: getModelFallback(),
      model_fallback_effective: getEffectiveModelFallback(),
      ai_credits: getAiCreditsUsage(),
      runs: getMaxRunsUsage(),
      cache_misses: getMaxCacheMissesUsage(),
      permission_denied: getPermissionDeniedUsage(),
      model_api_mapping: getModelApiMappingReflect(),
      routing: getRoutingState(),
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

module.exports = { buildRoutingModelMetadata, createManagementHandlers };
