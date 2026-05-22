#!/usr/bin/env node

/**
 * AWF API Proxy Sidecar — Core Engine
 *
 * Responsibilities:
 *   1. Model alias resolution and body-transform wiring
 *   2. Startup orchestration: key validation and model prefetching
 *   3. Provider-agnostic server factory (createProviderServer)
 *   4. Signal handling and graceful shutdown
 *
 * Focused modules handle the individual concerns:
 *   proxy-request.js    — HTTP/WebSocket proxy, rate-limit enforcement
 *   model-discovery.js  — fetchJson, httpProbe, extractModelIds, buildModelsJson
 *   management.js       — /health, /metrics, /reflect endpoint handlers
 *   rate-limiter.js     — sliding-window rate limiter
 *
 * All provider-specific knowledge (credentials, URLs, auth headers, body
 * transforms, model lists) lives exclusively in providers/*.js.
 * This file contains ZERO hard-coded provider names, ports, or env-var reads.
 */

'use strict';

const http = require('http');
const { sanitizeForLog, logRequest } = require('./logging');
const { parseModelAliases, rewriteModelInBody } = require('./model-resolver');
const { diag } = require('./token-persistence');

// ── Sub-modules ───────────────────────────────────────────────────────────────
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

// ── Re-export proxy-utils helpers for backward compatibility ──────────────────
const {
  buildUpstreamPath,
  shouldStripHeader,
  composeBodyTransforms,
  normalizeApiTarget,
} = require('./proxy-utils');

// ── Optional modules (graceful degradation when not bundled) ─────────────────
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

// ── Model alias resolution ────────────────────────────────────────────────────
// Loaded from AWF_MODEL_ALIASES env var (JSON string).
// When configured, POST/PUT request bodies are inspected for a "model" field
// and rewritten to a concrete model name before forwarding to upstream.
const MODEL_ALIASES_RAW = (process.env.AWF_MODEL_ALIASES || '').trim() || undefined;
const MODEL_ALIASES = parseModelAliases(MODEL_ALIASES_RAW);
const DEFAULT_MODEL_FALLBACK = Object.freeze({ enabled: true, strategy: 'middle_power' });

function parseModelFallbackConfig(rawConfig) {
  if (!rawConfig) return { ...DEFAULT_MODEL_FALLBACK };
  try {
    const parsed = JSON.parse(rawConfig);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_MODEL_FALLBACK };
    const enabled = parsed.enabled === undefined ? true : Boolean(parsed.enabled);
    const strategy = typeof parsed.strategy === 'string' && parsed.strategy.trim()
      ? parsed.strategy.trim()
      : DEFAULT_MODEL_FALLBACK.strategy;
    return { enabled, strategy };
  } catch {
    return { ...DEFAULT_MODEL_FALLBACK };
  }
}

const MODEL_FALLBACK_RAW = (process.env.AWF_MODEL_FALLBACK || '').trim() || undefined;
const MODEL_FALLBACK = parseModelFallbackConfig(MODEL_FALLBACK_RAW);
if (MODEL_ALIASES) {
  logRequest('info', 'startup', {
    message: 'Model aliases loaded',
    alias_count: Object.keys(MODEL_ALIASES.models).length,
    aliases: Object.keys(MODEL_ALIASES.models),
  });
} else if (MODEL_ALIASES_RAW) {
  logRequest('warn', 'startup', {
    message: 'AWF_MODEL_ALIASES is set but could not be parsed — model aliasing disabled',
  });
}
logRequest('info', 'startup', {
  message: 'Model fallback policy loaded',
  model_fallback: MODEL_FALLBACK,
});

/**
 * Build a body-transform function for a given provider that rewrites the
 * "model" field in JSON request bodies using the configured alias map.
 *
 * Returns null when model aliasing is not configured.
 *
 * @param {string} provider - Provider name (e.g. "copilot")
 * @returns {((body: Buffer) => (Buffer | null | Promise<Buffer | null>)) | null}
 */
function makeModelBodyTransform(provider) {
  if (!MODEL_ALIASES) return null;
  return async (body) => {
    let result = rewriteModelInBody(body, provider, MODEL_ALIASES.models, cachedModels, MODEL_FALLBACK);
    if (!result || (result.fallback && result.fallback.activated)) {
      await refreshProviderModelsForResolution(provider);
      result = rewriteModelInBody(body, provider, MODEL_ALIASES.models, cachedModels, MODEL_FALLBACK);
    }
    if (!result) return null;
    const originalModel = sanitizeForLog(result.originalModel) || '(none)';
    const resolvedModel = sanitizeForLog(result.resolvedModel);
    if (MODEL_FALLBACK.enabled && result.fallback) {
      if (result.fallback.activated) {
        logRequest('warn', 'model_fallback_activated', {
          provider,
          original_model: originalModel,
          fallback_model: resolvedModel,
          reason: result.fallback.reason,
          available_models_count: result.fallback.available_models_count,
          selection_method: result.fallback.selection_method,
        });
        logRequest('debug', 'model_fallback_candidates', {
          provider,
          original_model: originalModel,
          candidates: result.fallback.candidates,
          selection_method: result.fallback.selection_method,
        });
      } else {
        logRequest('info', 'model_fallback_skipped', {
          provider,
          original_model: originalModel,
          reason: result.fallback.reason,
          selection_method: result.fallback.selection_method,
        });
      }
    }
    for (const line of result.log) {
      logRequest('info', 'model_resolution', { message: line, provider });
      diag('MODEL_ALIAS_RESOLUTION_STEP', {
        provider,
        original_model: originalModel,
        resolved_model: resolvedModel,
        step: line,
      });
    }
    logRequest('info', 'model_rewrite', {
      provider,
      original_model: originalModel,
      resolved_model: resolvedModel,
    });
    diag('MODEL_ALIAS_REWRITE', {
      provider,
      original_model: originalModel,
      resolved_model: resolvedModel,
      resolution_steps: result.log,
    });
    return result.body;
  };
}

// ── Provider adapters ─────────────────────────────────────────────────────────
// createAllAdapters is called at module load so that module-level functions
// (reflectEndpoints, healthResponse, buildModelsJson) work correctly in tests.
const { createAllAdapters } = require('./providers');

const registeredAdapters = createAllAdapters(process.env, {
  openaiBodyTransform:    makeModelBodyTransform('openai'),
  anthropicBodyTransform: makeModelBodyTransform('anthropic'),
  copilotBodyTransform:   makeModelBodyTransform('copilot'),
  geminiBodyTransform:    makeModelBodyTransform('gemini'),
});

// ── Cached model lists (populated at startup by fetchStartupModels) ───────────
/**
 * @type {Record<string, string[]|null>}
 * null = fetch failed or not attempted for this provider.
 */
const cachedModels = {};

/** Set to true once fetchStartupModels() has run (regardless of success). */
let modelFetchComplete = false;

async function refreshProviderModelsForResolution(provider) {
  const adapter = registeredAdapters.find(a => a.name === provider);
  const config = adapter?.getModelsFetchConfig?.();
  if (!config) return;

  try {
    const json = await fetchJson(config.url, config.opts, 10_000);
    const extracted = extractModelIds(json);
    if (Array.isArray(extracted) && extracted.length > 0) {
      cachedModels[config.cacheKey] = extracted;
      logRequest('debug', 'model_cache_refresh', {
        provider,
        cache_key: config.cacheKey,
        models_count: extracted.length,
      });
    }
  } catch (err) {
    logRequest('debug', 'model_cache_refresh_failed', {
      provider,
      error: String(err && err.message ? err.message : err),
    });
  }
}

/** Reset model cache state (used in tests). */
function resetModelCacheState() {
  for (const key of Object.keys(cachedModels)) {
    delete cachedModels[key];
  }
  modelFetchComplete = false;
}

// ── Startup key validation state ─────────────────────────────────────────────
/**
 * @typedef {'pending'|'valid'|'auth_rejected'|'network_error'|'inconclusive'|'skipped'} ValidationStatus
 * @typedef {{ status: ValidationStatus, message: string }} ValidationResult
 */

/** @type {Record<string, ValidationResult>} */
const keyValidationResults = {};

let keyValidationComplete = false;

function resetKeyValidationState() {
  for (const key of Object.keys(keyValidationResults)) {
    delete keyValidationResults[key];
  }
  keyValidationComplete = false;
}

// ── Management endpoint handlers ──────────────────────────────────────────────
// Created via factory so that healthResponse/reflectEndpoints read shared state
// through getter functions rather than stale captured values.
const { healthResponse, reflectEndpoints, handleManagementEndpoint } = createManagementHandlers({
  getAdapters:           () => registeredAdapters,
  getCachedModels:       () => cachedModels,
  isModelFetchComplete:  () => modelFetchComplete,
  getKeyValidationState: () => ({ complete: keyValidationComplete, results: keyValidationResults }),
  getLimiter:            () => limiter,
  httpsProxy:            HTTPS_PROXY,
  getModelAliases:       () => MODEL_ALIASES,
  getModelFallback:      () => MODEL_FALLBACK,
  getEffectiveTokenUsage: () => getEffectiveTokenReflectState(),
  getMaxRunsUsage:       () => getMaxRunsReflectState(),
});

// ── models.json snapshot wrappers ─────────────────────────────────────────────
// Thin wrappers that bind the current server state to the model-discovery
// functions, preserving the zero-argument calling convention expected by callers
// and tests that import from server.js.

/**
 * Build the models.json payload from current cached state.
 *
 * @returns {object}
 */
function buildModelsJson() {
  return _buildModelsJson(registeredAdapters, cachedModels, MODEL_ALIASES);
}

/**
 * Write the current model availability snapshot to models.json.
 *
 * @param {string} [logDir] - Directory to write models.json to
 */
function writeModelsJson(logDir) {
  return _writeModelsJson(registeredAdapters, cachedModels, MODEL_ALIASES, logDir);
}

// ── Startup: key validation ────────────────────────────────────────────────────

/**
 * Probe a single provider to check if the API key is accepted.
 *
 * @param {string} provider
 * @param {string} url
 * @param {{ method: string, headers: Record<string,string>, body?: string }} opts
 * @param {number} timeoutMs
 */
async function probeProvider(provider, url, opts, timeoutMs) {
  keyValidationResults[provider] = { status: 'pending', message: 'Validating...' };
  try {
    const status = await httpProbe(url, opts, timeoutMs);

    if (status >= 200 && status < 300) {
      keyValidationResults[provider] = { status: 'valid', message: `HTTP ${status}` };
      logRequest('info', 'key_validation', { provider, status: 'valid', httpStatus: status });
    } else if (status === 401 || status === 403) {
      keyValidationResults[provider] = { status: 'auth_rejected', message: `HTTP ${status} \u2014 token expired or invalid` };
      logRequest('warn', 'key_validation', { provider, status: 'auth_rejected', httpStatus: status });
    } else if (status === 400) {
      // 400 for Anthropic means key is valid but request body was bad — expected
      keyValidationResults[provider] = { status: 'valid', message: `HTTP ${status} (auth accepted, probe body rejected)` };
      logRequest('info', 'key_validation', { provider, status: 'valid', httpStatus: status, note: 'probe body rejected but auth accepted' });
    } else {
      keyValidationResults[provider] = { status: 'inconclusive', message: `HTTP ${status}` };
      logRequest('warn', 'key_validation', { provider, status: 'inconclusive', httpStatus: status });
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    keyValidationResults[provider] = { status: 'network_error', message };
    logRequest('warn', 'key_validation', { provider, status: 'network_error', error: message });
  }
}

/**
 * Validate configured API keys by probing each provider's endpoint.
 *
 * @param {import('./providers').ProviderAdapter[]} [adapters=[]]
 */
async function validateApiKeys(adapters = []) {
  const mode = (process.env.AWF_VALIDATE_KEYS || 'warn').toLowerCase();
  if (mode === 'off') {
    logRequest('info', 'key_validation', { message: 'Key validation disabled (AWF_VALIDATE_KEYS=off)' });
    keyValidationComplete = true;
    return;
  }

  const TIMEOUT_MS = 10_000;
  const probes = [];

  for (const adapter of adapters) {
    const probe = adapter.getValidationProbe?.();
    if (!probe) continue;

    if (probe.skip) {
      keyValidationResults[adapter.name] = { status: 'skipped', message: probe.reason };
      logRequest('info', 'key_validation', { provider: adapter.name, ...keyValidationResults[adapter.name] });
      continue;
    }

    probes.push(probeProvider(adapter.name, probe.url, probe.opts, TIMEOUT_MS));
  }

  if (probes.length === 0) {
    logRequest('info', 'key_validation', { message: 'No providers to validate' });
    keyValidationComplete = true;
    return;
  }

  await Promise.allSettled(probes);
  keyValidationComplete = true;
  _summarizeValidationFailures(mode);
}

function _summarizeValidationFailures(mode) {
  const failures = Object.entries(keyValidationResults)
    .filter(([, r]) => r.status === 'auth_rejected');

  if (failures.length > 0) {
    for (const [provider, result] of failures) {
      logRequest('error', 'key_validation_failed', {
        provider,
        message: `${provider.toUpperCase()} API key validation failed \u2014 ${result.message}. Rotate the secret and re-run.`,
      });
    }
    if (mode === 'strict') {
      logRequest('error', 'key_validation_strict_exit', {
        message: `AWF_VALIDATE_KEYS=strict: exiting due to ${failures.length} auth failure(s)`,
        providers: failures.map(([p]) => p),
      });
      process.exit(1);
    }
  } else {
    logRequest('info', 'key_validation', { message: 'All configured API keys validated successfully' });
  }
}

/**
 * Fetch available models for each configured provider and cache them.
 *
 * @param {import('./providers').ProviderAdapter[]} [adapters=[]]
 */
async function fetchStartupModels(adapters = []) {
  const TIMEOUT_MS = 10_000;
  const fetches = [];

  for (const adapter of adapters) {
    const config = adapter.getModelsFetchConfig?.();
    if (!config) continue;

    fetches.push(
      fetchJson(config.url, config.opts, TIMEOUT_MS).then((json) => {
        cachedModels[config.cacheKey] = extractModelIds(json);
      })
    );
  }

  await Promise.allSettled(fetches);
  modelFetchComplete = true;
}

// ── Generic provider server factory ──────────────────────────────────────────
/**
 * Create an HTTP server for a provider adapter.
 *
 * The factory is completely agnostic of provider details — all provider-specific
 * behaviour (auth, URL transforms, body transforms) is delegated to the adapter.
 *
 * @param {import('./providers').ProviderAdapter} adapter
 * @returns {http.Server}
 */
function createProviderServer(adapter) {
  const server = http.createServer((req, res) => {
    // ── Management endpoints (designated port only) ──────────────────────────
    if (adapter.isManagementPort && handleManagementEndpoint(req, res)) return;

    // ── Provider-local health endpoint ───────────────────────────────────────
    if (req.url === '/health' && req.method === 'GET') {
      if (adapter.isEnabled()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', service: `awf-api-proxy-${adapter.name}` }));
      } else if (adapter.getUnconfiguredHealthResponse) {
        const { statusCode, body } = adapter.getUnconfiguredHealthResponse();
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not_configured', service: `awf-api-proxy-${adapter.name}` }));
      }
      return;
    }

    // ── Provider-local reflect endpoint ──────────────────────────────────────
    if (req.url === '/reflect' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reflectEndpoints()));
      return;
    }

    // ── Disabled adapter: return provider-specific error ─────────────────────
    if (!adapter.isEnabled()) {
      const response = adapter.getUnconfiguredResponse
        ? adapter.getUnconfiguredResponse()
        : { statusCode: 503, body: { error: `${adapter.name} proxy not configured` } };
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body));
      return;
    }

    // ── Rate limiting ─────────────────────────────────────────────────────────
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (checkRateLimit(req, res, adapter.name, contentLength)) return;

    // ── Optional URL transform ────────────────────────────────────────────────
    if (adapter.transformRequestUrl) {
      req.url = adapter.transformRequestUrl(req.url);
    }

    // ── Proxy ─────────────────────────────────────────────────────────────────
    proxyRequest(
      req, res,
      adapter.getTargetHost(req),
      adapter.getAuthHeaders(req),
      adapter.name,
      adapter.getBasePath(req),
      adapter.getBodyTransform()
    );
  });

  // ── WebSocket upgrade ─────────────────────────────────────────────────────
  server.on('upgrade', (req, socket, head) => {
    if (!adapter.isEnabled()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (adapter.transformRequestUrl) {
      req.url = adapter.transformRequestUrl(req.url);
    }

    proxyWebSocket(
      req, socket, head,
      adapter.getTargetHost(req),
      adapter.getAuthHeaders(req),
      adapter.name,
      adapter.getBasePath(req)
    );
  });

  return server;
}

// ── Startup ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  // Log startup configuration (provider-agnostic; adapters report their own details)
  logRequest('info', 'startup', {
    message: 'Starting AWF API proxy sidecar',
    squid_proxy: HTTPS_PROXY || 'not configured',
    providers_configured: registeredAdapters.filter(a => a.isEnabled()).map(a => a.name),
  });

  // ── Initialize OIDC token providers (if any adapter uses them) ────────────
  const oidcInitPromises = [];
  for (const adapter of registeredAdapters) {
    if (typeof adapter.getOidcProvider === 'function') {
      const provider = adapter.getOidcProvider();
      if (provider) {
        logRequest('info', 'oidc_startup', {
          message: `Initializing OIDC token provider for ${adapter.name}`,
        });
        oidcInitPromises.push(
          provider.initialize().catch((err) => {
            logRequest('error', 'oidc_startup_failed', {
              adapter: adapter.name,
              error: String(err),
            });
          })
        );
      }
    }
    if (typeof adapter.getAwsOidcProvider === 'function') {
      const awsProvider = adapter.getAwsOidcProvider();
      if (awsProvider) {
        logRequest('info', 'oidc_startup', {
          message: `Initializing AWS OIDC credential provider for ${adapter.name}`,
        });
        oidcInitPromises.push(
          awsProvider.initialize().catch((err) => {
            logRequest('error', 'oidc_startup_failed', {
              adapter: adapter.name,
              provider: 'aws',
              error: String(err),
            });
          })
        );
      }
    }
  }

  // Determine which adapters to bind and count validation participants
  const adaptersToStart = registeredAdapters.filter(a => a.alwaysBind || a.isEnabled());
  const expectedListeners = adaptersToStart.filter(a => a.participatesInValidation).length;
  let readyListeners = 0;

  function onListenerReady() {
    readyListeners++;
    if (readyListeners === expectedListeners) {
      logRequest('info', 'startup_complete', {
        message: `All ${expectedListeners} validation-participating listeners ready, starting key validation`,
      });

      // Wait for OIDC init before key validation (OIDC providers need tokens to probe)
      Promise.all(oidcInitPromises).then(() => {
        validateApiKeys(adaptersToStart).catch((err) => {
          logRequest('error', 'key_validation_error', { message: 'Unexpected error during key validation', error: String(err) });
          keyValidationComplete = true;
        });
        fetchStartupModels(adaptersToStart).then(() => {
          writeModelsJson();
        }).catch((err) => {
          logRequest('error', 'model_fetch_error', { message: 'Unexpected error fetching startup models', error: String(err) });
          modelFetchComplete = true;
          writeModelsJson();
        });
      });
    }
  }

  for (const adapter of adaptersToStart) {
    const server = createProviderServer(adapter);
    server.listen(adapter.port, '0.0.0.0', () => {
      logRequest('info', 'server_start', {
        message: `${adapter.name} proxy listening on port ${adapter.port}`,
        target: adapter.isEnabled() ? adapter.getTargetHost() : '(not configured)',
      });
      if (adapter.participatesInValidation) {
        onListenerReady();
      }
    });
  }

  async function shutdownGracefully(signal) {
    logRequest('info', 'shutdown', { message: `Received ${signal}, shutting down gracefully` });
    for (const adapter of registeredAdapters) {
      if (typeof adapter.getOidcProvider === 'function') {
        adapter.getOidcProvider()?.shutdown();
      }
      if (typeof adapter.getAwsOidcProvider === 'function') {
        adapter.getAwsOidcProvider()?.shutdown();
      }
    }
    await closeLogStream();
    await otelShutdown();
    process.exit(0);
  }

  process.on('SIGTERM', async () => shutdownGracefully('SIGTERM'));
  process.on('SIGINT', async () => shutdownGracefully('SIGINT'));
}

// ── Exports (for testing) ─────────────────────────────────────────────────────
module.exports = {
  // Core proxy (re-exported from proxy-request.js)
  proxyRequest,
  proxyWebSocket,
  // Utility re-exports (proxy-utils)
  buildUpstreamPath,
  shouldStripHeader,
  composeBodyTransforms,
  // Startup
  validateApiKeys,
  probeProvider,
  httpProbe,
  fetchStartupModels,
  // State
  keyValidationResults,
  resetKeyValidationState,
  cachedModels,
  resetModelCacheState,
  // Model utils (re-exported from model-discovery.js)
  extractModelIds,
  fetchJson,
  makeModelBodyTransform,
  MODEL_ALIASES,
  MODEL_FALLBACK,
  parseModelFallbackConfig,
  // Management (re-exported from management.js via factory)
  reflectEndpoints,
  healthResponse,
  buildModelsJson,
  writeModelsJson,
  // Billing
  extractBillingHeaders,
  // Server factory
  createProviderServer,
};
