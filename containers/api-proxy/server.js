#!/usr/bin/env node

/**
 * AWF API Proxy Sidecar — Core Engine
 *
 * Responsibilities:
 *   1. Generic HTTP/WebSocket proxy (proxyRequest / proxyWebSocket)
 *   2. Rate limiting, metrics, logging
 *   3. Management endpoints (/health, /metrics, /reflect) on the designated port
 *   4. Provider-agnostic server factory (createProviderServer)
 *   5. Startup orchestration: creates provider servers from registered adapters
 *
 * All provider-specific knowledge (credentials, URLs, auth headers, body
 * transforms, model lists) lives exclusively in providers/*.js.
 * This file contains ZERO hard-coded provider names, ports, or env-var reads.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { generateRequestId, sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');
const rateLimiter = require('./rate-limiter');
const { parseModelAliases, rewriteModelInBody } = require('./model-resolver');

// ── Optional modules (graceful degradation when not bundled) ─────────────────
let trackTokenUsage;
let trackWebSocketTokenUsage;
let closeLogStream;
try {
  ({ trackTokenUsage, trackWebSocketTokenUsage, closeLogStream } = require('./token-tracker'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    trackTokenUsage = () => {};
    trackWebSocketTokenUsage = () => {};
    closeLogStream = () => {};
  } else {
    throw err;
  }
}

// ── Shared utility functions ─────────────────────────────────────────────────
const {
  buildUpstreamPath,
  shouldStripHeader,
  composeBodyTransforms,
  normalizeApiTarget,
} = require('./proxy-utils');

// ── Rate limiter ─────────────────────────────────────────────────────────────
const limiter = rateLimiter.create();

// ── Request size cap (10 MB) to prevent DoS via large payloads ───────────────
const MAX_BODY_SIZE = 10 * 1024 * 1024;

// ── Squid proxy agent ────────────────────────────────────────────────────────
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const proxyAgent = HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined;

if (!proxyAgent) {
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

// ── Utility: validate request IDs ────────────────────────────────────────────
function isValidRequestId(id) {
  return typeof id === 'string' && id.length <= 128 && /^[\w\-\.]+$/.test(id);
}

// ── Rate-limit helper ─────────────────────────────────────────────────────────
/**
 * Check the rate limit for a provider and send a 429 if exceeded.
 * Returns true if the request was rate-limited (caller should return early).
 */
function checkRateLimit(req, res, provider, requestBytes) {
  const check = limiter.check(provider, requestBytes);
  if (!check.allowed) {
    const clientRequestId = req.headers['x-request-id'];
    const requestId = (typeof clientRequestId === 'string' &&
      clientRequestId.length <= 128 &&
      /^[\w\-\.]+$/.test(clientRequestId))
      ? clientRequestId : generateRequestId();
    const limitLabels = { rpm: 'requests per minute', rph: 'requests per hour', bytes_pm: 'bytes per minute' };
    const windowLabel = limitLabels[check.limitType] || check.limitType;

    metrics.increment('rate_limit_rejected_total', { provider, limit_type: check.limitType });
    logRequest('warn', 'rate_limited', {
      request_id: requestId,
      provider,
      limit_type: check.limitType,
      limit: check.limit,
      retry_after: check.retryAfter,
    });

    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(check.retryAfter),
      'X-RateLimit-Limit': String(check.limit),
      'X-RateLimit-Remaining': String(check.remaining),
      'X-RateLimit-Reset': String(check.resetAt),
      'X-Request-ID': requestId,
    });
    res.end(JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: `Rate limit exceeded for ${provider} provider. Limit: ${check.limit} ${windowLabel}. Retry after ${check.retryAfter} seconds.`,
        provider,
        limit: check.limit,
        window: check.limitType === 'rpm' ? 'per_minute' : check.limitType === 'rph' ? 'per_hour' : 'per_minute_bytes',
        retry_after: check.retryAfter,
      },
    }));
    return true;
  }
  return false;
}

// ── Core proxy: HTTP ──────────────────────────────────────────────────────────
/**
 * Forward a request to the target API, injecting auth headers and routing through Squid.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} targetHost - Upstream hostname
 * @param {object} injectHeaders - Auth headers to inject
 * @param {string} provider - Provider name for logging and metrics
 * @param {string} [basePath=''] - Optional base-path prefix
 * @param {((body: Buffer) => Buffer | null) | null} [bodyTransform=null]
 */
function proxyRequest(req, res, targetHost, injectHeaders, provider, basePath = '', bodyTransform = null) {
  const clientRequestId = req.headers['x-request-id'];
  const requestId = isValidRequestId(clientRequestId) ? clientRequestId : generateRequestId();
  const startTime = Date.now();

  res.setHeader('X-Request-ID', requestId);
  metrics.gaugeInc('active_requests', { provider });

  logRequest('info', 'request_start', {
    request_id: requestId,
    provider,
    method: req.method,
    path: sanitizeForLog(req.url),
    upstream_host: targetHost,
  });

  if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) {
    const duration = Date.now() - startTime;
    metrics.gaugeDec('active_requests', { provider });
    metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
    logRequest('warn', 'request_complete', {
      request_id: requestId,
      provider,
      method: req.method,
      path: sanitizeForLog(req.url),
      status: 400,
      duration_ms: duration,
      upstream_host: targetHost,
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Request', message: 'URL must be a relative path' }));
    return;
  }

  const upstreamPath = buildUpstreamPath(req.url, targetHost, basePath);

  req.on('error', (err) => {
    if (errored) return;
    errored = true;
    const duration = Date.now() - startTime;
    metrics.gaugeDec('active_requests', { provider });
    metrics.increment('requests_errors_total', { provider });
    logRequest('error', 'request_error', {
      request_id: requestId, provider, method: req.method,
      path: sanitizeForLog(req.url), duration_ms: duration,
      error: sanitizeForLog(err.message), upstream_host: targetHost,
    });
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Client error', message: err.message }));
  });

  const chunks = [];
  let totalBytes = 0;
  let rejected = false;
  let errored = false;

  req.on('data', chunk => {
    if (rejected || errored) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_SIZE) {
      rejected = true;
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
      logRequest('warn', 'request_complete', {
        request_id: requestId, provider, method: req.method,
        path: sanitizeForLog(req.url), status: 413, duration_ms: duration,
        request_bytes: totalBytes, upstream_host: targetHost,
      });
      if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large', message: 'Request body exceeds 10 MB limit' }));
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (rejected || errored) return;
    let body = Buffer.concat(chunks);
    const inboundBytes = body.length;

    if (bodyTransform && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
      const transformed = bodyTransform(body);
      if (transformed) body = transformed;
    }

    const requestBytes = body.length;
    metrics.increment('request_bytes_total', { provider }, requestBytes);

    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!shouldStripHeader(name)) headers[name] = value;
    }
    headers['x-request-id'] = requestId;
    Object.assign(headers, injectHeaders);

    if (body.length !== inboundBytes) {
      headers['content-length'] = String(body.length);
      delete headers['transfer-encoding'];
    }

    const injectedKey = Object.entries(injectHeaders).find(([k]) =>
      ['x-api-key', 'authorization', 'x-goog-api-key'].includes(k.toLowerCase())
    )?.[1];
    if (injectedKey) {
      const keyPreview = injectedKey.length > 8
        ? `${injectedKey.substring(0, 8)}...${injectedKey.substring(injectedKey.length - 4)}`
        : '(short)';
      logRequest('debug', 'auth_inject', {
        request_id: requestId, provider,
        key_length: injectedKey.length, key_preview: keyPreview,
        has_anthropic_version: !!headers['anthropic-version'],
      });
    }

    const options = {
      hostname: targetHost, port: 443, path: upstreamPath,
      method: req.method, headers,
      agent: proxyAgent,
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let responseBytes = 0;
      proxyRes.on('data', (chunk) => { responseBytes += chunk.length; });

      proxyRes.on('error', (err) => {
        const duration = Date.now() - startTime;
        metrics.gaugeDec('active_requests', { provider });
        metrics.increment('requests_errors_total', { provider });
        logRequest('error', 'request_error', {
          request_id: requestId, provider, method: req.method,
          path: sanitizeForLog(req.url), duration_ms: duration,
          error: sanitizeForLog(err.message), upstream_host: targetHost,
        });
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Response stream error', message: err.message }));
      });

      proxyRes.on('end', () => {
        const duration = Date.now() - startTime;
        const sc = metrics.statusClass(proxyRes.statusCode);
        metrics.gaugeDec('active_requests', { provider });
        metrics.increment('requests_total', { provider, method: req.method, status_class: sc });
        metrics.increment('response_bytes_total', { provider }, responseBytes);
        metrics.observe('request_duration_ms', duration, { provider });
        logRequest('info', 'request_complete', {
          request_id: requestId, provider, method: req.method,
          path: sanitizeForLog(req.url), status: proxyRes.statusCode,
          duration_ms: duration, request_bytes: requestBytes,
          response_bytes: responseBytes, upstream_host: targetHost,
        });
      });

      const resHeaders = { ...proxyRes.headers, 'x-request-id': requestId };

      if (proxyRes.statusCode === 400 || proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
        const message = proxyRes.statusCode === 400
          ? `Upstream returned 400 — possible malformed Authorization header; check that the API key does not include a "Bearer " prefix (BYOK mode)`
          : `Upstream returned ${proxyRes.statusCode} — check that the API key is valid and has not expired`;
        logRequest('warn', 'upstream_auth_error', {
          request_id: requestId, provider, status: proxyRes.statusCode,
          upstream_host: targetHost, path: sanitizeForLog(req.url),
          message,
        });
      }

      res.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(res);

      trackTokenUsage(proxyRes, { requestId, provider, path: sanitizeForLog(req.url), startTime, metrics });
    });

    proxyReq.on('error', (err) => {
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_errors_total', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('error', 'request_error', {
        request_id: requestId, provider, method: req.method,
        path: sanitizeForLog(req.url), duration_ms: duration,
        error: sanitizeForLog(err.message), upstream_host: targetHost,
      });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
}

// ── Core proxy: WebSocket ─────────────────────────────────────────────────────
/**
 * Handle a WebSocket upgrade request by tunnelling through the Squid proxy.
 *
 * @param {http.IncomingMessage} req - The incoming HTTP Upgrade request
 * @param {import('net').Socket} socket - Raw TCP socket to the WebSocket client
 * @param {Buffer} head - Any bytes already buffered after the upgrade headers
 * @param {string} targetHost - Upstream hostname
 * @param {Object} injectHeaders - Auth headers to inject
 * @param {string} provider - Provider name for logging and metrics
 * @param {string} [basePath=''] - Optional base-path prefix
 */
function proxyWebSocket(req, socket, head, targetHost, injectHeaders, provider, basePath = '') {
  const startTime = Date.now();
  const clientRequestId = req.headers['x-request-id'];
  const requestId = isValidRequestId(clientRequestId) ? clientRequestId : generateRequestId();

  const upgradeType = (req.headers['upgrade'] || '').toLowerCase();
  if (upgradeType !== 'websocket') {
    logRequest('warn', 'websocket_upgrade_rejected', {
      request_id: requestId, provider, path: sanitizeForLog(req.url),
      reason: 'unsupported upgrade type',
      upgrade: sanitizeForLog(req.headers['upgrade'] || ''),
    });
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//')) {
    logRequest('warn', 'websocket_upgrade_rejected', {
      request_id: requestId, provider, path: sanitizeForLog(req.url),
      reason: 'URL must be a relative path',
    });
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstreamPath = buildUpstreamPath(req.url, targetHost, basePath);

  const rateCheck = limiter.check(provider, 0);
  if (!rateCheck.allowed) {
    metrics.increment('rate_limit_rejected_total', { provider, limit_type: rateCheck.limitType });
    logRequest('warn', 'rate_limited', {
      request_id: requestId, provider, limit_type: rateCheck.limitType,
      limit: rateCheck.limit, retry_after: rateCheck.retryAfter,
    });
    socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rateCheck.retryAfter}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  logRequest('info', 'websocket_upgrade_start', {
    request_id: requestId, provider, path: sanitizeForLog(req.url), upstream_host: targetHost,
  });
  metrics.gaugeInc('active_requests', { provider });

  let finalized = false;
  function finalize(isError, description) {
    if (finalized) return;
    finalized = true;
    const duration = Date.now() - startTime;
    metrics.gaugeDec('active_requests', { provider });
    if (isError) {
      metrics.increment('requests_errors_total', { provider });
      logRequest('error', 'websocket_upgrade_failed', {
        request_id: requestId, provider, path: sanitizeForLog(req.url),
        duration_ms: duration, error: sanitizeForLog(String(description || 'unknown error')),
      });
    } else {
      metrics.increment('requests_total', { provider, method: 'GET', status_class: '1xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('info', 'websocket_upgrade_complete', {
        request_id: requestId, provider, path: sanitizeForLog(req.url), duration_ms: duration,
      });
    }
  }

  function abort(reason, ...extra) {
    finalize(true, reason);
    if (!socket.destroyed && socket.writable) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    socket.destroy();
    for (const s of extra) { if (s && !s.destroyed) s.destroy(); }
  }

  if (!HTTPS_PROXY) {
    abort('No Squid proxy configured (HTTPS_PROXY not set)');
    return;
  }

  let proxyUrl;
  try {
    proxyUrl = new URL(HTTPS_PROXY);
  } catch (err) {
    abort(`Invalid proxy URL: ${err.message}`);
    return;
  }

  const proxyHost = proxyUrl.hostname;
  const proxyPort = parseInt(proxyUrl.port, 10) || 3128;

  const connectReq = http.request({
    host: proxyHost, port: proxyPort, method: 'CONNECT',
    path: `${targetHost}:443`,
    headers: { 'Host': `${targetHost}:443` },
  });

  connectReq.once('error', (err) => abort(`CONNECT error: ${err.message}`));

  connectReq.once('connect', (connectRes, tunnel) => {
    if (connectRes.statusCode !== 200) {
      abort(`CONNECT failed: HTTP ${connectRes.statusCode}`, tunnel);
      return;
    }

    const tlsSocket = tls.connect({ socket: tunnel, servername: targetHost, rejectUnauthorized: true });
    const onTlsError = (err) => abort(`TLS handshake error: ${err.message}`, tunnel);
    tlsSocket.once('error', onTlsError);

    tlsSocket.once('secureConnect', () => {
      tlsSocket.removeListener('error', onTlsError);

      const forwardHeaders = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!shouldStripHeader(name)) forwardHeaders[name] = value;
      }
      Object.assign(forwardHeaders, injectHeaders);
      forwardHeaders['host'] = targetHost;

      let upgradeReqStr = `GET ${upstreamPath} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(forwardHeaders)) {
        upgradeReqStr += `${name}: ${value}\r\n`;
      }
      upgradeReqStr += '\r\n';
      tlsSocket.write(upgradeReqStr);

      if (head && head.length > 0) tlsSocket.write(head);

      tlsSocket.pipe(socket);
      socket.pipe(tlsSocket);

      trackWebSocketTokenUsage(tlsSocket, { requestId, provider, path: sanitizeForLog(req.url), startTime, metrics });

      socket.once('close', () => { finalize(false); tlsSocket.destroy(); });
      tlsSocket.once('close', () => { finalize(false); socket.destroy(); });
      socket.on('error', () => socket.destroy());
      tlsSocket.on('error', () => tlsSocket.destroy());
    });
  });

  connectReq.end();
}

// ── Management endpoints (port 10000 only) ────────────────────────────────────

function healthResponse() {
  const providers = {};
  for (const adapter of registeredAdapters) {
    providers[adapter.name] = adapter.isEnabled();
  }
  return {
    status: 'healthy',
    service: 'awf-api-proxy',
    squid_proxy: HTTPS_PROXY || 'not configured',
    providers,
    key_validation: { complete: keyValidationComplete, results: keyValidationResults },
    models_fetch_complete: modelFetchComplete,
    metrics_summary: metrics.getSummary(),
    rate_limits: limiter.getAllStatus(),
  };
}

/**
 * Build the reflection response describing all proxy endpoints and their available models.
 *
 * @returns {{ endpoints: Array<object>, models_fetch_complete: boolean, model_aliases: object|null }}
 */
function reflectEndpoints() {
  return {
    endpoints: registeredAdapters.map(adapter => {
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
    models_fetch_complete: modelFetchComplete,
    model_aliases: MODEL_ALIASES ? MODEL_ALIASES.models : null,
  };
}

/**
 * Handle management endpoints on port 10000 (/health, /metrics, /reflect).
 * Returns true if the request was handled, false otherwise.
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

// ── models.json snapshot ──────────────────────────────────────────────────────

const MODELS_LOG_DIR = process.env.AWF_API_PROXY_LOG_DIR || '/var/log/api-proxy';

/**
 * Build the models.json payload from current cached state.
 *
 * @returns {object}
 */
function buildModelsJson() {
  const providers = {};
  for (const adapter of registeredAdapters) {
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
    model_aliases: MODEL_ALIASES ? MODEL_ALIASES.models : null,
  };
}

/**
 * Write the current model availability snapshot to models.json.
 *
 * @param {string} [logDir] - Directory to write models.json to (default: MODELS_LOG_DIR)
 */
function writeModelsJson(logDir = MODELS_LOG_DIR) {
  const filePath = path.join(logDir, 'models.json');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(buildModelsJson(), null, 2) + '\n', 'utf8');
    logRequest('info', 'models_json_written', { path: filePath });
  } catch (err) {
    logRequest('warn', 'models_json_write_failed', {
      message: 'Failed to write models.json',
      logDir, path: filePath,
      error: err instanceof Error ? (err.stack || err.message) : String(err),
    });
  }
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
      keyValidationResults[provider] = { status: 'auth_rejected', message: `HTTP ${status} — token expired or invalid` };
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
 * Make an HTTPS request through the proxy and return the HTTP status code.
 *
 * @param {string} url
 * @param {{ method: string, headers: Record<string,string>, body?: string }} opts
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
function httpProbe(url, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
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
    let parsed;
    try { parsed = new URL(url); } catch { resolve(null); return; }

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

/**
 * Extract model IDs from a provider API response.
 * Handles:
 *   - OpenAI / Anthropic / Copilot: { data: [{ id }, ...] }
 *   - Gemini: { models: [{ name: "models/gemini-..." }, ...] }
 *
 * @param {object|null} json
 * @returns {string[]|null}
 */
const GEMINI_MODEL_NAME_PREFIX = 'models/';

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

// ── Adapter-based validation & model fetching ─────────────────────────────────
//
// When adapters array is provided (production), iterate over adapter probes.
// When an overrides object is provided (tests), use the legacy inline logic.
// The duck-type check (Array.isArray) keeps backward compat with existing tests.

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
        message: `${provider.toUpperCase()} API key validation failed — ${result.message}. Rotate the secret and re-run.`,
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
  // Core proxy
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
  // Model utils
  extractModelIds,
  fetchJson,
  makeModelBodyTransform,
  MODEL_ALIASES,
  // Management
  reflectEndpoints,
  healthResponse,
  buildModelsJson,
  writeModelsJson,
  // Server factory
  createProviderServer,
};
