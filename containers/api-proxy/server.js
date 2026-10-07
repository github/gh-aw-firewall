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
  MODEL_POLICY_CONFIG,
  parseModelFallbackConfig,
  makeModelBodyTransform: makeModelBodyTransformForProvider,
  filterResolvableAliases,
  filterAvailableModelsToConfiguredProviders,
  getEffectiveModelFallbackForReflect,
} = require('./model-config');
const {
  keyValidationResults,
  cachedModels,
  getRuntimeModels,
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
const { createProductionRoutingSession } = require('./routing-runtime');
const { getFallbackModels, validateFallbackChain } = require('./model-fallback-chain');

const {
  configureFallbackProviders,
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
const {
  resolveApiKey,
  resolveCopilotAuthToken,
  deriveCopilotApiTarget,
  isGithubCopilotCatalogTarget,
} = require('./providers/copilot-auth');

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
    getRuntimeModels,
    provider === 'copilot' &&
      !resolveApiKey(process.env) &&
      Boolean(resolveCopilotAuthToken(process.env)) &&
      isGithubCopilotCatalogTarget(deriveCopilotApiTarget(process.env)),
  );
}

const registeredAdapters = createAllAdapters(process.env, {
  openaiBodyTransform: makeModelBodyTransform('openai'),
  anthropicBodyTransform: makeModelBodyTransform('anthropic'),
  copilotBodyTransform: makeModelBodyTransform('copilot'),
  geminiBodyTransform: makeModelBodyTransform('gemini'),
});
const getRegisteredAdapter = provider => registeredAdapters.find(adapter => adapter.name === provider);
configureFallbackProviders({ getAdapter: getRegisteredAdapter });

/**
 * Validate provider-qualified apiProxy.fallbackModels entries against the
 * configured adapters.
 *
 * @returns {string[]} Actionable configuration errors
 */
function validateFallbackModelsConfig(env = process.env) {
  return validateFallbackChain(getFallbackModels(env), getRegisteredAdapter);
}

const routing = createProductionRoutingSession({
  getAdapter: provider => registeredAdapters.find(adapter => adapter.name === provider),
});

configureKeyValidation({
  getRegisteredAdapters: () => registeredAdapters,
  getModelAliases: () => MODEL_ALIASES,
});

function getFilteredModelAliases() {
  if (!MODEL_ALIASES) return null;
  const configuredProviders = getConfiguredModelCacheKeys();
  return {
    models: filterResolvableAliases(
      MODEL_ALIASES.models,
      filterAvailableModelsToConfiguredProviders(cachedModels, configuredProviders),
      configuredProviders,
    ),
  };
}

function buildModelsSnapshot() {
  const filteredAliases = getFilteredModelAliases();
  return {
    filteredAliases,
    modelsJson: _buildModelsJson(
      registeredAdapters,
      cachedModels,
      filteredAliases,
      getRuntimeCatalogSnapshot(),
    ),
  };
}

const { healthResponse, reflectEndpoints, handleManagementEndpoint } = createManagementHandlers({
  getAdapters: () => registeredAdapters,
  getCachedModels: () => cachedModels,
  getRuntimeModelMetadata: () => getRuntimeCatalogSnapshot(),
  getRoutingModelMetadata: () => Object.fromEntries(
    registeredAdapters.map(adapter => [adapter.name, getRuntimeModels(adapter.name) || []]),
  ),
  isModelFetchComplete: () => isModelFetchComplete(),
  getKeyValidationState: () => ({ complete: isKeyValidationComplete(), results: keyValidationResults }),
  getLimiter: () => limiter,
  httpsProxy: HTTPS_PROXY,
  getModelAliases: getFilteredModelAliases,
  modelPolicy: MODEL_POLICY_CONFIG,
  getModelFallback: () => MODEL_FALLBACK,
  getEffectiveModelFallback: () => getEffectiveModelFallbackForReflect(registeredAdapters),
  getEffectiveTokenUsage: () => getEffectiveTokenReflectState(),
  getAiCreditsUsage: () => getAiCreditsReflectState(),
  getMaxRunsUsage: () => getMaxRunsReflectState(),
  getMaxCacheMissesUsage: () => getMaxCacheMissesReflectState(),
  getPermissionDeniedUsage: () => getPermissionDeniedReflectState(),
  getRoutingState: () => routing?.getReflectState() ?? null,
});

function buildModelsJson() {
  return buildModelsSnapshot().modelsJson;
}

function writeModelsJson(logDir) {
  const { filteredAliases, modelsJson } = buildModelsSnapshot();
  return _writeModelsJson(registeredAdapters, cachedModels, filteredAliases, logDir, modelsJson);
}

function createProviderServer(adapter) {
  return createProviderServerFactory(adapter, {
    handleManagementEndpoint,
    reflectEndpoints,
    checkRateLimit,
    proxyRequest,
    proxyWebSocket,
    routing,
  });
}

if (require.main === module) {
  const fallbackModelErrors = validateFallbackModelsConfig();
  if (fallbackModelErrors.length > 0) {
    for (const message of fallbackModelErrors) {
      logRequest('error', 'fallback_models_invalid', { message });
    }
    process.exit(1);
  }
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
    routing,
  });
}

module.exports = {
  proxyRequest,
  validateFallbackModelsConfig,
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
