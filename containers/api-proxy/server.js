#!/usr/bin/env node

/**
 * AWF API Proxy Sidecar — Core Engine (Facade)
 *
 * Focused modules:
 *   - model-config.js   (model aliases + fallback policy)
 *   - key-validation.js (key validation + model probing/cache)
 *   - server-factory.js (provider-agnostic HTTP/WebSocket handlers)
 *   - startup.js        (startup orchestration + graceful shutdown)
 */

'use strict';

const { logRequest } = require('./logging');
const {
  MODEL_ALIASES,
  MODEL_FALLBACK,
  parseModelFallbackConfig,
  makeModelBodyTransform: makeModelBodyTransformForProvider,
  filterResolvableAliases,
  filterAvailableModelsToConfiguredProviders,
  getEffectiveModelFallbackForReflect,
} = require('./model-config');
const {
  keyValidationResults,
  cachedModels,
  getRuntimeCatalogSnapshot,
  configureKeyValidation,
  resetKeyValidationState,
  resetModelCacheState,
  isKeyValidationComplete,
  isModelFetchComplete,
  setKeyValidationComplete,
  setModelFetchComplete,
  refreshProviderModelsForResolution,
  probeProvider,
  validateApiKeys,
  fetchStartupModels,
  validateRequestedModel,
} = require('./key-validation');
const { createProviderServer: createProviderServerFactory } = require('./server-factory');
const { bootPrimary } = require('./startup');

const {
  proxyRequest,
  proxyWebSocket,
  checkRateLimit,
  limiter,
  HTTPS_PROXY,
  extractBillingHeaders,
  getEffectiveTokenReflectState,
  getAiCreditsReflectState,
  getMaxRunsReflectState,
  getMaxCacheMissesReflectState,
  getPermissionDeniedReflectState,
} = require('./proxy-request');

const {
  fetchJson,
  httpProbe,
  extractModelIds,
  buildModelsJson: _buildModelsJson,
  writeModelsJson: _writeModelsJson,
} = require('./model-discovery');

const { createManagementHandlers } = require('./management');
const {
  buildUpstreamPath,
  shouldStripHeader,
  composeBodyTransforms,
} = require('./proxy-utils');

let closeLogStream;
try {
  ({ closeLogStream } = require('./token-tracker'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    closeLogStream = () => {};
  } else {
    throw err;
  }
}

let otelShutdown;
try {
  ({ shutdown: otelShutdown } = require('./otel'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    otelShutdown = () => Promise.resolve();
  } else {
    throw err;
  }
}

if (!HTTPS_PROXY) {
  logRequest('warn', 'startup', { message: 'No HTTPS_PROXY configured, requests will go direct' });
}

const { createAllAdapters } = require('./providers');

/**
 * Model cache keys of the provider slots that are actually configured for this
 * run. Alias resolution must never steer a request to a provider that reports
 * `configured: false` — every such call fails with `provider_not_configured`.
 */
function getConfiguredModelCacheKeys(adapters = registeredAdapters) {
  const keys = new Set();
  for (const adapter of adapters) {
    const reflection = adapter.getReflectionInfo();
    if (!reflection.configured) continue;
    const cacheKey = reflection.models_cache_key;
    if (cacheKey) keys.add(cacheKey);
  }
  return keys;
}

function makeModelBodyTransform(provider) {
  return makeModelBodyTransformForProvider(
    provider,
    cachedModels,
    refreshProviderModelsForResolution,
    getConfiguredModelCacheKeys,
  );
}

const registeredAdapters = createAllAdapters(process.env, {
  openaiBodyTransform: makeModelBodyTransform('openai'),
  anthropicBodyTransform: makeModelBodyTransform('anthropic'),
  copilotBodyTransform: makeModelBodyTransform('copilot'),
  geminiBodyTransform: makeModelBodyTransform('gemini'),
});

configureKeyValidation({
  getRegisteredAdapters: () => registeredAdapters,
  getModelAliases: () => MODEL_ALIASES,
});

const { healthResponse, reflectEndpoints, handleManagementEndpoint } = createManagementHandlers({
  getAdapters: () => registeredAdapters,
  getCachedModels: () => cachedModels,
  getRuntimeModelMetadata: () => getRuntimeCatalogSnapshot(),
  isModelFetchComplete: () => isModelFetchComplete(),
  getKeyValidationState: () => ({ complete: isKeyValidationComplete(), results: keyValidationResults }),
  getLimiter: () => limiter,
  httpsProxy: HTTPS_PROXY,
  getModelAliases: () => {
    if (!MODEL_ALIASES) return null;
    const configuredProviders = getConfiguredModelCacheKeys();
    return {
      models: filterResolvableAliases(
        MODEL_ALIASES.models,
        filterAvailableModelsToConfiguredProviders(cachedModels, configuredProviders),
        configuredProviders,
      ),
    };
  },
  getModelFallback: () => MODEL_FALLBACK,
  getEffectiveModelFallback: () => getEffectiveModelFallbackForReflect(registeredAdapters),
  getEffectiveTokenUsage: () => getEffectiveTokenReflectState(),
  getAiCreditsUsage: () => getAiCreditsReflectState(),
  getMaxRunsUsage: () => getMaxRunsReflectState(),
  getMaxCacheMissesUsage: () => getMaxCacheMissesReflectState(),
  getPermissionDeniedUsage: () => getPermissionDeniedReflectState(),
});

function buildModelsJson() {
  const configuredProviders = getConfiguredModelCacheKeys();
  const filteredAliases = MODEL_ALIASES ? {
    models: filterResolvableAliases(
      MODEL_ALIASES.models,
      filterAvailableModelsToConfiguredProviders(cachedModels, configuredProviders),
      configuredProviders,
    ),
  } : null;
  return _buildModelsJson(registeredAdapters, cachedModels, filteredAliases, getRuntimeCatalogSnapshot());
}

function writeModelsJson(logDir) {
  const configuredProviders = getConfiguredModelCacheKeys();
  const filteredAliases = MODEL_ALIASES ? {
    models: filterResolvableAliases(
      MODEL_ALIASES.models,
      filterAvailableModelsToConfiguredProviders(cachedModels, configuredProviders),
      configuredProviders,
    ),
  } : null;
  const modelsJson = _buildModelsJson(
    registeredAdapters,
    cachedModels,
    filteredAliases,
    getRuntimeCatalogSnapshot(),
  );
  return _writeModelsJson(registeredAdapters, cachedModels, filteredAliases, logDir, modelsJson);
}

function createProviderServer(adapter) {
  return createProviderServerFactory(adapter, {
    handleManagementEndpoint,
    reflectEndpoints,
    checkRateLimit,
    proxyRequest,
    proxyWebSocket,
  });
}

if (require.main === module) {
  bootPrimary({
    registeredAdapters,
    createProviderServer,
    validateApiKeys,
    fetchStartupModels,
    writeModelsJson,
    validateRequestedModel,
    setKeyValidationComplete,
    setModelFetchComplete,
    closeLogStream,
    otelShutdown,
    logRequest,
    HTTPS_PROXY,
  });
}

module.exports = {
  proxyRequest,
  proxyWebSocket,
  buildUpstreamPath,
  shouldStripHeader,
  composeBodyTransforms,
  validateApiKeys,
  probeProvider,
  httpProbe,
  fetchStartupModels,
  validateRequestedModel,
  keyValidationResults,
  resetKeyValidationState,
  cachedModels,
  resetModelCacheState,
  extractModelIds,
  fetchJson,
  makeModelBodyTransform,
  MODEL_ALIASES,
  MODEL_FALLBACK,
  parseModelFallbackConfig,
  reflectEndpoints,
  healthResponse,
  buildModelsJson,
  writeModelsJson,
  getConfiguredModelCacheKeys,
  extractBillingHeaders,
  createProviderServer,
};
