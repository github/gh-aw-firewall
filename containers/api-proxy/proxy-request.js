'use strict';

/**
 * AWF API Proxy — HTTP and WebSocket Proxy Core
 *
 * Responsibilities:
 *   1. HTTP forward proxy (proxyRequest) — credential injection, header manipulation
 *   2. WebSocket proxy (proxyWebSocket) — separate protocol handler
 *   3. Rate-limit enforcement (checkRateLimit) — per-provider 429 responses
 *
 * This module is intentionally self-contained: it reads HTTPS_PROXY from the
 * environment at load time and creates its own RateLimiter instance, which is
 * exported so that management/health endpoints can read rate-limit status.
 *
 * Security note: proxyRequest is the credential injection path. Any change here
 * should be reviewed carefully for header-injection and SSRF risks.
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { generateRequestId, sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');
const rateLimiter = require('./rate-limiter');
const { buildUpstreamPath, shouldStripHeader } = require('./proxy-utils');

// ── Optional token tracker (graceful degradation when not bundled) ────────────
let trackTokenUsage;
let trackWebSocketTokenUsage;
try {
  ({ trackTokenUsage, trackWebSocketTokenUsage } = require('./token-tracker'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    trackTokenUsage = () => {};
    trackWebSocketTokenUsage = () => {};
  } else {
    throw err;
  }
}

// ── Module-level constants (read from env at load time) ───────────────────────
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const proxyAgent = HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined;

/** Maximum request body size: 10 MB to prevent DoS via large payloads. */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

// ── Billing header extraction ─────────────────────────────────────────────────

/**
 * Extract billing/quota information from upstream response headers.
 *
 * CAPI returns quota snapshots as `X-Quota-Snapshot-<Type>` headers with
 * URL-encoded fields: ent (entitlement), ov (overage), ovPerm (overage allowed),
 * rem (remaining %), rst (reset date).
 *
 * Also captures X-RateLimit-* headers from CAPI responses.
 *
 * @param {Record<string, string|string[]>} headers - Response headers
 * @returns {object|null} Billing info object, or null if no billing headers present
 */
function extractBillingHeaders(headers) {
  const billing = {};
  let hasBilling = false;

  // Extract all X-Quota-Snapshot-* headers
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-quota-snapshot-')) {
      const quotaType = lower.slice('x-quota-snapshot-'.length);
      try {
        const params = new URLSearchParams(String(value));
        const snapshot = {};
        for (const [k, v] of params) snapshot[k] = v;
        billing[`quota_${quotaType}`] = snapshot;
      } catch {
        billing[`quota_${quotaType}_raw`] = String(value);
      }
      hasBilling = true;
    }
  }

  // X-RateLimit headers from CAPI
  if (headers['x-ratelimit-limit']) {
    billing.rate_limit = headers['x-ratelimit-limit'];
    billing.rate_remaining = headers['x-ratelimit-remaining'];
    billing.rate_reset = headers['x-ratelimit-reset'];
    hasBilling = true;
  }

  return hasBilling ? billing : null;
}

/**
 * Shared RateLimiter instance.
 * Exported so that management endpoints (healthResponse) can read getAllStatus().
 */
const limiter = rateLimiter.create();

const ET_WARNING_THRESHOLDS = [50, 75, 90, 95];
const ET_DEFAULT_WEIGHTS = Object.freeze({
  input: 1.0,
  cacheRead: 0.1,
  output: 4.0,
  reasoning: 4.0,
});
let etGuardState = {
  configKey: null,
  totalEffectiveTokens: 0,
  emittedThresholds: new Set(),
};
const effectiveTokenConfigCache = {
  rawMax: undefined,
  rawMultipliers: undefined,
  parsed: { max: null, multipliers: {} },
};

function createEffectiveTokenState(configKey = null) {
  return {
    configKey,
    totalEffectiveTokens: 0,
    emittedThresholds: new Set(),
  };
}

function parseMaxEffectiveTokens(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseModelMultipliers(raw) {
  if (!raw || String(raw).trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const [model, value] of Object.entries(parsed)) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) {
        result[model] = num;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function getEffectiveTokenConfig() {
  const rawMax = process.env.AWF_MAX_EFFECTIVE_TOKENS;
  const rawMultipliers = process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
  if (effectiveTokenConfigCache.rawMax === rawMax && effectiveTokenConfigCache.rawMultipliers === rawMultipliers) {
    return effectiveTokenConfigCache.parsed;
  }

  effectiveTokenConfigCache.rawMax = rawMax;
  effectiveTokenConfigCache.rawMultipliers = rawMultipliers;
  const parsedMultipliers = Object.freeze(parseModelMultipliers(rawMultipliers));
  effectiveTokenConfigCache.parsed = {
    max: parseMaxEffectiveTokens(rawMax),
    multipliers: parsedMultipliers,
  };
  return effectiveTokenConfigCache.parsed;
}

function getEffectiveTokenState(config) {
  if (!config.max) return null;
  const configKey = `${config.max}|${JSON.stringify(config.multipliers)}`;
  if (etGuardState.configKey !== configKey) {
    etGuardState = createEffectiveTokenState(configKey);
  }
  return etGuardState;
}

function calculateEffectiveTokens(normalizedUsage, model, config) {
  const multiplier = config.multipliers[model] ?? 1;
  const baseWeightedTokens =
    (ET_DEFAULT_WEIGHTS.input * (normalizedUsage.input_tokens || 0)) +
    (ET_DEFAULT_WEIGHTS.cacheRead * (normalizedUsage.cache_read_tokens || 0)) +
    (ET_DEFAULT_WEIGHTS.output * (normalizedUsage.output_tokens || 0)) +
    (ET_DEFAULT_WEIGHTS.reasoning * (normalizedUsage.reasoning_tokens || 0));
  return {
    multiplier,
    baseWeightedTokens,
    effectiveTokens: multiplier * baseWeightedTokens,
  };
}

function applyEffectiveTokenUsage(normalizedUsage, model) {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state || !normalizedUsage) return null;

  const previousTotal = state.totalEffectiveTokens;
  const calc = calculateEffectiveTokens(normalizedUsage, model || 'unknown', config);
  state.totalEffectiveTokens += calc.effectiveTokens;
  const percentUsed = (state.totalEffectiveTokens / config.max) * 100;

  const crossedThresholds = [];
  for (const threshold of ET_WARNING_THRESHOLDS) {
    if (percentUsed >= threshold && !state.emittedThresholds.has(threshold)) {
      state.emittedThresholds.add(threshold);
      crossedThresholds.push(threshold);
    }
  }

  return {
    maxEffectiveTokens: config.max,
    previousTotalEffectiveTokens: previousTotal,
    totalEffectiveTokens: state.totalEffectiveTokens,
    effectiveTokensThisResponse: calc.effectiveTokens,
    modelMultiplier: calc.multiplier,
    crossedThresholds,
    maxExceeded: state.totalEffectiveTokens >= config.max,
  };
}

function getEffectiveTokenBlockState() {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state) return null;
  return {
    maxEffectiveTokens: config.max,
    totalEffectiveTokens: state.totalEffectiveTokens,
    maxExceeded: state.totalEffectiveTokens >= config.max,
  };
}

function getEffectiveTokenReflectState() {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state) {
    return {
      enabled: false,
      max_effective_tokens: null,
      total_effective_tokens: 0,
      remaining_effective_tokens: null,
      percent_used: 0,
      thresholds_crossed: [],
    };
  }
  return {
    enabled: true,
    max_effective_tokens: config.max,
    total_effective_tokens: state.totalEffectiveTokens,
    remaining_effective_tokens: Math.max(0, config.max - state.totalEffectiveTokens),
    percent_used: Math.round((state.totalEffectiveTokens / config.max) * 10000) / 100,
    thresholds_crossed: [...state.emittedThresholds].sort((a, b) => a - b),
  };
}

function resetEffectiveTokenGuardForTests() {
  etGuardState = createEffectiveTokenState();
  effectiveTokenConfigCache.rawMax = undefined;
  effectiveTokenConfigCache.rawMultipliers = undefined;
  effectiveTokenConfigCache.parsed = { max: null, multipliers: {} };
}

function buildEffectiveTokenLimitError(etState) {
  return {
    error: {
      type: 'effective_tokens_limit_reached',
      message: `Maximum effective tokens reached (${etState.totalEffectiveTokens.toFixed(2)} / ${etState.maxEffectiveTokens}).`,
      total_effective_tokens: etState.totalEffectiveTokens,
      max_effective_tokens: etState.maxEffectiveTokens,
    },
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Return true if id is a safe, non-empty request-ID string.
 * Limits length and character set to prevent log injection.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidRequestId(id) {
  return typeof id === 'string' && id.length <= 128 && /^[\w\-\.]+$/.test(id);
}

// ── Rate-limit helper ─────────────────────────────────────────────────────────
/**
 * Check the rate limit for a provider and send a 429 if exceeded.
 * Returns true if the request was rate-limited (caller should return early).
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} provider
 * @param {number} requestBytes
 * @returns {boolean}
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
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
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

  const chunks = [];
  let totalBytes = 0;
  let rejected = false;
  let errored = false;

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

    // Default X-Initiator to "agent" for billing purposes on Copilot-bound requests.
    // In agentic workflows, the vast majority of requests are agent-initiated.
    // If the client already set it (e.g. standard Copilot CLI), respect that value.
    // Check is on targetHost rather than provider name so that OpenCode requests
    // routed to the Copilot backend also receive the header.
    const isCopilotHost =
      targetHost === 'githubcopilot.com' ||
      targetHost.endsWith('.githubcopilot.com');
    if (isCopilotHost && !headers['x-initiator']) {
      headers['x-initiator'] = 'agent';
    }

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

    const etBlock = getEffectiveTokenBlockState();
    if (etBlock && etBlock.maxExceeded) {
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('warn', 'effective_tokens_limit_reached', {
        request_id: requestId,
        provider,
        total_effective_tokens: etBlock.totalEffectiveTokens,
        max_effective_tokens: etBlock.maxEffectiveTokens,
      });
      res.writeHead(429, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
      res.end(JSON.stringify(buildEffectiveTokenLimitError(etBlock)));
      return;
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

      // Extract billing/quota headers from upstream response
      const billingInfo = extractBillingHeaders(proxyRes.headers);
      const initiatorSent = headers['x-initiator'] || null;

      proxyRes.on('end', () => {
        const duration = Date.now() - startTime;
        const sc = metrics.statusClass(proxyRes.statusCode);
        metrics.gaugeDec('active_requests', { provider });
        metrics.increment('requests_total', { provider, method: req.method, status_class: sc });
        metrics.increment('response_bytes_total', { provider }, responseBytes);
        metrics.observe('request_duration_ms', duration, { provider });
        const logFields = {
          request_id: requestId, provider, method: req.method,
          path: sanitizeForLog(req.url), status: proxyRes.statusCode,
          duration_ms: duration, request_bytes: requestBytes,
          response_bytes: responseBytes, upstream_host: targetHost,
        };
        if (initiatorSent) logFields.x_initiator = initiatorSent;
        if (billingInfo) logFields.billing = billingInfo;
        logRequest('info', 'request_complete', logFields);
      });

      const resHeaders = { ...proxyRes.headers, 'x-request-id': requestId };

      if (proxyRes.statusCode === 400 || proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
        logRequest('warn', 'upstream_auth_error', {
          request_id: requestId, provider, status: proxyRes.statusCode,
          upstream_host: targetHost, path: sanitizeForLog(req.url),
          message: `Upstream returned ${proxyRes.statusCode} — check that the API key is valid and correctly formatted`,
        });
      }

      res.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(res);
      trackTokenUsage(proxyRes, {
        requestId,
        provider,
        path: sanitizeForLog(req.url),
        startTime,
        metrics,
        billingInfo,
        initiatorSent,
        onUsage: (normalizedUsage, model) => {
          applyEffectiveTokenUsage(normalizedUsage, model);
        },
      });
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
 * @param {import('http').IncomingMessage} req - The incoming HTTP Upgrade request
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

  const etBlock = getEffectiveTokenBlockState();
  if (etBlock && etBlock.maxExceeded) {
    logRequest('warn', 'effective_tokens_limit_reached', {
      request_id: requestId,
      provider,
      total_effective_tokens: etBlock.totalEffectiveTokens,
      max_effective_tokens: etBlock.maxEffectiveTokens,
    });
    socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
    socket.write(JSON.stringify(buildEffectiveTokenLimitError(etBlock)));
    socket.destroy();
    return;
  }

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

      trackWebSocketTokenUsage(tlsSocket, {
        requestId,
        provider,
        path: sanitizeForLog(req.url),
        startTime,
        metrics,
        onUsage: (normalizedUsage, model) => {
          applyEffectiveTokenUsage(normalizedUsage, model);
        },
      });

      socket.once('close', () => { finalize(false); tlsSocket.destroy(); });
      tlsSocket.once('close', () => { finalize(false); socket.destroy(); });
      socket.on('error', () => socket.destroy());
      tlsSocket.on('error', () => tlsSocket.destroy());
    });
  });

  connectReq.end();
}

module.exports = {
  isValidRequestId,
  checkRateLimit,
  proxyRequest,
  proxyWebSocket,
  extractBillingHeaders,
  // Exported for shared use by management/health endpoints
  limiter,
  proxyAgent,
  HTTPS_PROXY,
  getEffectiveTokenReflectState,
  // Exported for tests
  resetEffectiveTokenGuardForTests,
};
