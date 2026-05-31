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
  getEffectiveModelFallbackForReflect,
} = require('./model-config');
const {
  keyValidationResults,
  cachedModels,
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
  getMaxRunsReflectState,
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

function makeModelBodyTransform(provider) {
  return makeModelBodyTransformForProvider(provider, cachedModels, refreshProviderModelsForResolution);
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
  isModelFetchComplete: () => isModelFetchComplete(),
  getKeyValidationState: () => ({ complete: isKeyValidationComplete(), results: keyValidationResults }),
  getLimiter: () => limiter,
  httpsProxy: HTTPS_PROXY,
  getModelAliases: () => {
    if (!MODEL_ALIASES) return null;
    return { models: filterResolvableAliases(MODEL_ALIASES.models, cachedModels) };
  },
  getModelFallback: () => MODEL_FALLBACK,
  getEffectiveModelFallback: () => getEffectiveModelFallbackForReflect(registeredAdapters),
  getEffectiveTokenUsage: () => getEffectiveTokenReflectState(),
  getMaxRunsUsage: () => getMaxRunsReflectState(),
});

function buildModelsJson() {
  const filteredAliases = MODEL_ALIASES
    ? { models: filterResolvableAliases(MODEL_ALIASES.models, cachedModels) }
    : null;
  return _buildModelsJson(registeredAdapters, cachedModels, filteredAliases);
}

function writeModelsJson(logDir) {
  const filteredAliases = MODEL_ALIASES
    ? { models: filterResolvableAliases(MODEL_ALIASES.models, cachedModels) }
    : null;
  return _writeModelsJson(registeredAdapters, cachedModels, filteredAliases, logDir);
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
  extractBillingHeaders,
  createProviderServer,
};
