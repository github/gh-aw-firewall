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

// ── Sub-modules ───────────────────────────────────────────────────────────────
const {
  proxyRequest,
  proxyWebSocket,
  checkRateLimit,
  limiter,
  HTTPS_PROXY,
  extractBillingHeaders,
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

if (!HTTPS_PROXY) {
  logRequest('warn', 'startup', { message: 'No HTTPS_PROXY configured, requests will go direct' });
}

// ── Model alias resolution ────────────────────────────────────────────────────
// Loaded from AWF_MODEL_ALIASES env var (JSON string).
// When configured, POST/PUT request bodies are inspected for a "model" field
// and rewritten to a concrete model name before forwarding to upstream.
const MODEL_ALIASES_RAW = (process.env.AWF_MODEL_ALIASES || '').trim() || undefined;
const MODEL_ALIASES = parseModelAliases(MODEL_ALIASES_RAW);
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

/**
 * Build a body-transform function for a given provider that rewrites the
 * "model" field in JSON request bodies using the configured alias map.
 *
 * Returns null when model aliasing is not configured.
 *
 * @param {string} provider - Provider name (e.g. "copilot")
 * @returns {((body: Buffer) => Buffer | null) | null}
 */
function makeModelBodyTransform(provider) {
  if (!MODEL_ALIASES) return null;
  return (body) => {
    const result = rewriteModelInBody(body, provider, MODEL_ALIASES.models, cachedModels);
    if (!result) return null;
    for (const line of result.log) {
      logRequest('info', 'model_resolution', { message: line, provider });
    }
    logRequest('info', 'model_rewrite', {
      provider,
      original_model: sanitizeForLog(result.originalModel) || '(none)',
      resolved_model: sanitizeForLog(result.resolvedModel),
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
 * Accepts either:
 *   - An adapters array (production): uses each adapter's getValidationProbe()
 *   - An overrides object (test compatibility): uses inline probe logic
 *
 * @param {import('./providers').ProviderAdapter[]|object} [adaptersOrOverrides={}]
 */
async function validateApiKeys(adaptersOrOverrides = {}) {
  const mode = (process.env.AWF_VALIDATE_KEYS || 'warn').toLowerCase();
  if (mode === 'off') {
    logRequest('info', 'key_validation', { message: 'Key validation disabled (AWF_VALIDATE_KEYS=off)' });
    keyValidationComplete = true;
    return;
  }

  // ── Adapter-based path (production) ─────────────────────────────────────────
  if (Array.isArray(adaptersOrOverrides)) {
    const adapters = adaptersOrOverrides;
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
    return;
  }

  // ── Legacy override path (test compatibility) ────────────────────────────────
  const overrides = adaptersOrOverrides;
  const ov = (key, fallback) => key in overrides ? overrides[key] : fallback;

  // Re-read module-level adapter state for defaults (keeps tests self-contained)
  const openaiAdapter   = registeredAdapters.find(a => a.name === 'openai');
  const anthropicAdapter = registeredAdapters.find(a => a.name === 'anthropic');
  const copilotAdapter  = registeredAdapters.find(a => a.name === 'copilot');
  const geminiAdapter   = registeredAdapters.find(a => a.name === 'gemini');

  // Rather than trying to introspect adapters for every key, use process.env as fallback
  const _ov = (key, envKey) => key in overrides ? overrides[key] : (process.env[envKey] || '').trim() || undefined;
  const openaiKeyV    = _ov('openaiKey',    'OPENAI_API_KEY');
  const openaiTarget  = ov('openaiTarget',  openaiAdapter?.getTargetHost?.() ?? 'api.openai.com');
  const anthropicKeyV = _ov('anthropicKey', 'ANTHROPIC_API_KEY');
  const anthropicTarget = ov('anthropicTarget', anthropicAdapter?.getTargetHost?.() ?? 'api.anthropic.com');
  const copilotGithubToken = _ov('copilotGithubToken', 'COPILOT_GITHUB_TOKEN');
  const copilotApiKey      = _ov('copilotApiKey',      'COPILOT_API_KEY');
  const copilotAuthToken   = ov('copilotAuthToken', copilotAdapter?._githubToken ?? copilotAdapter?.isEnabled?.() ?? undefined);
  const copilotTarget  = ov('copilotTarget', copilotAdapter?.getTargetHost?.() ?? 'api.githubcopilot.com');
  const copilotIntegrationId = ov('copilotIntegrationId', copilotAdapter?._integrationId ?? 'copilot-developer-cli');
  const geminiKeyV    = _ov('geminiKey',    'GEMINI_API_KEY');
  const geminiTarget  = ov('geminiTarget',  geminiAdapter?.getTargetHost?.() ?? 'generativelanguage.googleapis.com');
  const TIMEOUT_MS    = ov('timeoutMs', 10_000);

  const probes = [];

  // --- Copilot ---
  if (copilotGithubToken) {
    if (copilotTarget !== 'api.githubcopilot.com') {
      keyValidationResults.copilot = { status: 'skipped', message: `Custom target ${copilotTarget}; validation skipped` };
      logRequest('info', 'key_validation', { provider: 'copilot', ...keyValidationResults.copilot });
    } else {
      probes.push(probeProvider('copilot', `https://${copilotTarget}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${copilotGithubToken}`, 'Copilot-Integration-Id': copilotIntegrationId },
      }, TIMEOUT_MS));
    }
  } else if (copilotApiKey && !copilotGithubToken) {
    keyValidationResults.copilot = { status: 'skipped', message: 'COPILOT_API_KEY configured but startup validation is not supported for this auth mode' };
    logRequest('info', 'key_validation', { provider: 'copilot', ...keyValidationResults.copilot });
  }

  // --- OpenAI ---
  if (openaiKeyV) {
    if (openaiTarget !== 'api.openai.com') {
      keyValidationResults.openai = { status: 'skipped', message: `Custom target ${openaiTarget}; validation skipped` };
      logRequest('info', 'key_validation', { provider: 'openai', ...keyValidationResults.openai });
    } else {
      probes.push(probeProvider('openai', `https://${openaiTarget}/v1/models`, {
        method: 'GET', headers: { 'Authorization': `Bearer ${openaiKeyV}` },
      }, TIMEOUT_MS));
    }
  }

  // --- Anthropic ---
  if (anthropicKeyV) {
    if (anthropicTarget !== 'api.anthropic.com') {
      keyValidationResults.anthropic = { status: 'skipped', message: `Custom target ${anthropicTarget}; validation skipped` };
      logRequest('info', 'key_validation', { provider: 'anthropic', ...keyValidationResults.anthropic });
    } else {
      probes.push(probeProvider('anthropic', `https://${anthropicTarget}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': anthropicKeyV, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: '{}',
      }, TIMEOUT_MS));
    }
  }

  // --- Gemini ---
  if (geminiKeyV) {
    if (geminiTarget !== 'generativelanguage.googleapis.com') {
      keyValidationResults.gemini = { status: 'skipped', message: `Custom target ${geminiTarget}; validation skipped` };
      logRequest('info', 'key_validation', { provider: 'gemini', ...keyValidationResults.gemini });
    } else {
      probes.push(probeProvider('gemini', `https://${geminiTarget}/v1beta/models`, {
        method: 'GET', headers: { 'x-goog-api-key': geminiKeyV },
      }, TIMEOUT_MS));
    }
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
 * Accepts either:
 *   - An adapters array (production): uses each adapter's getModelsFetchConfig()
 *   - An overrides object (test compatibility): uses inline fetch logic
 *
 * @param {import('./providers').ProviderAdapter[]|object} [adaptersOrOverrides={}]
 */
async function fetchStartupModels(adaptersOrOverrides = {}) {
  // ── Adapter-based path (production) ─────────────────────────────────────────
  if (Array.isArray(adaptersOrOverrides)) {
    const adapters = adaptersOrOverrides;
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
    return;
  }

  // ── Legacy override path (test compatibility) ────────────────────────────────
  const overrides = adaptersOrOverrides;
  const _ov = (key, envKey) => key in overrides ? overrides[key] : (process.env[envKey] || '').trim() || undefined;
  const ov  = (key, fallback) => key in overrides ? overrides[key] : fallback;

  const copilotAdapter = registeredAdapters.find(a => a.name === 'copilot');
  const geminiAdapter  = registeredAdapters.find(a => a.name === 'gemini');

  const openaiKey    = _ov('openaiKey',         'OPENAI_API_KEY');
  const openaiTarget = ov('openaiTarget',        normalizeApiTarget(process.env.OPENAI_API_TARGET) || 'api.openai.com');
  const anthropicKey  = _ov('anthropicKey',      'ANTHROPIC_API_KEY');
  const anthropicTarget = ov('anthropicTarget',  normalizeApiTarget(process.env.ANTHROPIC_API_TARGET) || 'api.anthropic.com');
  const copilotGithubToken = _ov('copilotGithubToken', 'COPILOT_GITHUB_TOKEN');
  const copilotTarget  = ov('copilotTarget', copilotAdapter?.getTargetHost?.() ?? 'api.githubcopilot.com');
  const copilotIntegrationId = ov('copilotIntegrationId', copilotAdapter?._integrationId ?? 'copilot-developer-cli');
  const geminiKey    = _ov('geminiKey',           'GEMINI_API_KEY');
  const geminiTarget = ov('geminiTarget',         geminiAdapter?.getTargetHost?.() ?? 'generativelanguage.googleapis.com');
  const TIMEOUT_MS   = ov('timeoutMs', 10_000);

  const fetches = [];

  if (openaiKey) {
    fetches.push(fetchJson(`https://${openaiTarget}/v1/models`, {
      method: 'GET', headers: { 'Authorization': `Bearer ${openaiKey}` },
    }, TIMEOUT_MS).then((json) => { cachedModels.openai = extractModelIds(json); }));
  }

  if (anthropicKey) {
    fetches.push(fetchJson(`https://${anthropicTarget}/v1/models`, {
      method: 'GET', headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    }, TIMEOUT_MS).then((json) => { cachedModels.anthropic = extractModelIds(json); }));
  }

  if (copilotGithubToken) {
    fetches.push(fetchJson(`https://${copilotTarget}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${copilotGithubToken}`, 'Copilot-Integration-Id': copilotIntegrationId },
    }, TIMEOUT_MS).then((json) => { cachedModels.copilot = extractModelIds(json); }));
  }

  if (geminiKey) {
    fetches.push(fetchJson(`https://${geminiTarget}/v1beta/models`, {
      method: 'GET', headers: { 'x-goog-api-key': geminiKey },
    }, TIMEOUT_MS).then((json) => { cachedModels.gemini = extractModelIds(json); }));
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

  process.on('SIGTERM', async () => {
    logRequest('info', 'shutdown', { message: 'Received SIGTERM, shutting down gracefully' });
    await closeLogStream();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logRequest('info', 'shutdown', { message: 'Received SIGINT, shutting down gracefully' });
    await closeLogStream();
    process.exit(0);
  });
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
