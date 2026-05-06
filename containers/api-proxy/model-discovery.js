'use strict';

/**
 * AWF API Proxy — Model Discovery
 *
 * Responsibilities:
 *   1. Fetch JSON from upstream API endpoints (fetchJson)
 *   2. Probe an endpoint and return its HTTP status (httpProbe)
 *   3. Extract model IDs from provider API list responses (extractModelIds)
 *   4. Build the models.json payload from cached state (buildModelsJson)
 *   5. Write the models.json snapshot to disk (writeModelsJson)
 *
 * buildModelsJson / writeModelsJson accept provider state as explicit parameters
 * so that this module has no direct dependency on server.js module-level state.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { sanitizeForLog, logRequest } = require('./logging');

// ── Shared proxy agent (from proxy-request to avoid bootstrap duplication) ────
const { proxyAgent } = require('./proxy-request');

const MODELS_LOG_DIR = process.env.AWF_API_PROXY_LOG_DIR || '/var/log/api-proxy';

const GEMINI_MODEL_NAME_PREFIX = 'models/';

// ── buildRequest ──────────────────────────────────────────────────────────────
/**
 * Shared HTTP/HTTPS request setup used by fetchJson and httpProbe.
 * Parses the URL, selects the appropriate module, and builds request options.
 *
 * @param {string} url
 * @param {{ method: string, headers: Record<string,string> }} opts
 * @param {number} timeoutMs
 * @returns {{ mod: object, reqOpts: object }}
 */
function buildRequest(url, opts, timeoutMs) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const mod = isHttps ? https : http;
  const reqOpts = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: opts.method,
    headers: { ...opts.headers },
    ...(isHttps && proxyAgent ? { agent: proxyAgent } : {}),
    timeout: timeoutMs,
  };
  return { mod, reqOpts };
}

// ── fetchJson ─────────────────────────────────────────────────────────────────
/**
 * Make an HTTPS/HTTP request through the proxy and return parsed JSON response.
 * Returns null on any error, non-2xx status, or parse failure.
 *
 * @param {string} url
 * @param {{ method: string, headers: Record<string,string> }} opts
 * @param {number} timeoutMs
 * @returns {Promise<object|null>}
 */
function fetchJson(url, opts, timeoutMs) {
  return new Promise((resolve) => {
    let mod, reqOpts;
    try {
      ({ mod, reqOpts } = buildRequest(url, opts, timeoutMs));
    } catch (err) {
      if (err && err.code === 'ERR_INVALID_URL') {
        resolve(null);
        return;
      }
      throw err;
    }

    let settled = false;
    const resolveOnce = (value) => { if (settled) return; settled = true; resolve(value); };

    const req = mod.request(reqOpts, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); resolveOnce(null); return; }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try { resolveOnce(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolveOnce(null); }
      });
      res.on('error', (err) => {
        logRequest('debug', 'fetch_json_error', { url: sanitizeForLog(url), error: String(err && err.message ? err.message : err) });
        resolveOnce(null);
      });
      res.on('close', () => resolveOnce(null));
    });

    req.on('timeout', () => {
      const err = new Error(`fetchJson timed out after ${timeoutMs}ms`);
      logRequest('debug', 'fetch_json_timeout', { url: sanitizeForLog(url), timeout_ms: timeoutMs });
      req.destroy(err);
    });
    req.on('error', (err) => {
      logRequest('debug', 'fetch_json_error', { url: sanitizeForLog(url), error: String(err && err.message ? err.message : err) });
      resolveOnce(null);
    });
    req.end();
  });
}

// ── httpProbe ─────────────────────────────────────────────────────────────────
/**
 * Make an HTTPS request through the proxy and return the HTTP status code.
 *
 * @param {string} url
 * @param {{ method: string, headers: Record<string,string>, body?: string }} opts
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
function httpProbe(url, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { mod, reqOpts } = buildRequest(url, opts, timeoutMs);

    let settled = false;
    const resolveOnce = (statusCode) => { if (settled) return; settled = true; resolve(statusCode); };
    const rejectOnce = (err) => { if (settled) return; settled = true; reject(err); };

    const req = mod.request(reqOpts, (res) => {
      res.resume();
      res.on('end', () => resolveOnce(res.statusCode));
      res.on('error', rejectOnce);
      res.on('close', () => resolveOnce(res.statusCode));
    });

    req.on('timeout', () => { req.destroy(new Error(`Probe timed out after ${timeoutMs}ms`)); });
    req.on('error', rejectOnce);

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── extractModelIds ───────────────────────────────────────────────────────────
/**
 * Extract model IDs from a provider API response.
 * Handles:
 *   - OpenAI / Anthropic / Copilot: { data: [{ id }, ...] }
 *   - Gemini: { models: [{ name: "models/gemini-..." }, ...] }
 *
 * @param {object|null} json
 * @returns {string[]|null}
 */
function extractModelIds(json) {
  if (!json || typeof json !== 'object') return null;

  if (Array.isArray(json.data)) {
    const ids = json.data.map((m) => m && (m.id || m.name)).filter(Boolean);
    return ids.length > 0 ? ids.sort() : null;
  }

  if (Array.isArray(json.models)) {
    const ids = json.models
      .map((m) => m && m.name && m.name.startsWith(GEMINI_MODEL_NAME_PREFIX)
        ? m.name.slice(GEMINI_MODEL_NAME_PREFIX.length)
        : (m && m.name) || null)
      .filter(Boolean);
    return ids.length > 0 ? ids.sort() : null;
  }

  return null;
}

// ── buildModelsJson ───────────────────────────────────────────────────────────
/**
 * Build the models.json payload from current cached state.
 *
 * @param {Array<object>} adapters - Registered provider adapters
 * @param {Record<string, string[]|null>} cachedModels - Populated model cache
 * @param {object|null} modelAliases - Parsed MODEL_ALIASES (or null)
 * @returns {object}
 */
function buildModelsJson(adapters, cachedModels, modelAliases) {
  const providers = {};
  for (const adapter of adapters) {
    const info = adapter.getReflectionInfo();
    providers[adapter.name] = {
      configured: adapter.isEnabled(),
      models: info.models_cache_key !== null
        ? (cachedModels[info.models_cache_key] !== undefined ? cachedModels[info.models_cache_key] : null)
        : null,
      target: adapter.isEnabled() ? adapter.getTargetHost() : null,
    };
  }
  return {
    timestamp: new Date().toISOString(),
    providers,
    model_aliases: modelAliases ? modelAliases.models : null,
  };
}

// ── writeModelsJson ───────────────────────────────────────────────────────────
/**
 * Write the current model availability snapshot to models.json.
 *
 * @param {Array<object>} adapters - Registered provider adapters
 * @param {Record<string, string[]|null>} cachedModels - Populated model cache
 * @param {object|null} modelAliases - Parsed MODEL_ALIASES (or null)
 * @param {string} [logDir] - Directory to write models.json to (default: MODELS_LOG_DIR)
 */
function writeModelsJson(adapters, cachedModels, modelAliases, logDir = MODELS_LOG_DIR) {
  const filePath = path.join(logDir, 'models.json');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(buildModelsJson(adapters, cachedModels, modelAliases), null, 2) + '\n', 'utf8');
    logRequest('info', 'models_json_written', { path: filePath });
  } catch (err) {
    logRequest('warn', 'models_json_write_failed', {
      message: 'Failed to write models.json',
      logDir, path: filePath,
      error: err instanceof Error ? (err.stack || err.message) : String(err),
    });
  }
}

module.exports = {
  fetchJson,
  httpProbe,
  extractModelIds,
  buildModelsJson,
  writeModelsJson,
};
