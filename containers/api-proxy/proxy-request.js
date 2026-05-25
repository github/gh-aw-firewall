'use strict';

/**
 * AWF API Proxy — HTTP Proxy Core and shared exports.
 *
 * Security note: proxyRequest is the credential injection path. Any change here
 * should be reviewed carefully for header-injection and SSRF risks.
 */

const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { generateRequestId, sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');
const rateLimiter = require('./rate-limiter');
const { buildUpstreamPath, shouldStripHeader } = require('./proxy-utils');
const { sanitizeNullToolCallTypes, injectSteeringMessage, injectStreamOptions } = require('./body-transform');
const { createRateLimitChecker } = require('./rate-limit');
const { createProxyWebSocket } = require('./websocket-proxy');
const {
  applyEffectiveTokenUsage,
  getEffectiveTokenBlockState,
  getEffectiveTokenReflectState,
  resetEffectiveTokenGuardForTests,
  buildEffectiveTokenLimitError,
  getAndClearPendingSteeringMessage,
} = require('./guards/effective-token-guard');
const {
  applyMaxRunsInvocation,
  getMaxRunsBlockState,
  getMaxRunsReflectState,
  resetMaxRunsGuardForTests,
  buildMaxRunsExceededError,
} = require('./guards/max-runs-guard');
const {
  getAndClearPendingTimeoutSteeringMessage,
  resetTimeoutSteeringForTests,
} = require('./guards/timeout-steering');

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

// ── Optional OTEL tracing (graceful degradation when not bundled) ─────────────
let otel;
try {
  otel = require('./otel');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    // No-op shims so callers need no guard checks
    const noop = () => {};
    const noopSpan = { setAttribute: noop, setAttributes: noop, addEvent: noop, setStatus: noop, recordException: noop, end: noop };
    otel = {
      startRequestSpan:  () => noopSpan,
      setTokenAttributes: noop,
      endSpan:           noop,
      endSpanError:      noop,
      shutdown:          () => Promise.resolve(),
      isEnabled:         () => false,
    };
  } else {
    throw err;
  }
}

// ── Module-level constants (read from env at load time) ───────────────────────
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const proxyAgent = HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined;

/** Maximum request body size: 10 MB to prevent DoS via large payloads. */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/** Shared RateLimiter instance. */
const limiter = rateLimiter.create();

/** When false, token-budget warnings are never injected into request bodies. */
const isSteeringEnabled = () => process.env.AWF_ENABLE_TOKEN_STEERING === 'true';

// ── Deprecated header value handling ──────────────────────────────────────────
// General mechanism: when an upstream returns a 400 indicating that a specific
// value in a specific header is not accepted, we learn that (header, value) pair,
// strip it, retry once, and proactively remove it from all subsequent requests.

/** Map of headerName → Set of rejected values, learned from upstream 400 responses. */
const deprecatedHeaderValues = new Map();
const MAX_CACHED_VALUES_PER_HEADER = 200;

/**
 * Pattern to detect header-value rejection errors from Anthropic.
 * Matches: Unexpected value(s) `<value>` for the `<header>` header
 */
const DEPRECATED_HEADER_PATTERN = /Unexpected value\(s\)\s+`([^`]+)`\s+for the `([^`]+)` header/;

function normalizeHeaderValue(value) {
  if (!value) return '';
  return Array.isArray(value) ? value.join(',') : String(value);
}

function splitHeaderValue(value) {
  return normalizeHeaderValue(value).split(',').map(s => s.trim()).filter(Boolean);
}

function updateHeader(headers, headerName, values) {
  if (!values.length) {
    delete headers[headerName];
    return;
  }
  headers[headerName] = values.join(',');
}

function stripValuesFromHeader(headers, headerName, valuesToStrip) {
  if (!headers[headerName] || !valuesToStrip.size) return null;
  const existingValues = splitHeaderValue(headers[headerName]);
  if (!existingValues.length) {
    delete headers[headerName];
    return { removed: [], remaining: [] };
  }
  const remaining = existingValues.filter(value => !valuesToStrip.has(value));
  const removed = existingValues.filter(value => valuesToStrip.has(value));
  if (!removed.length) return null;
  updateHeader(headers, headerName, remaining);
  return { removed, remaining };
}

function getDeprecatedValuesForHeader(headerName) {
  if (!deprecatedHeaderValues.has(headerName)) {
    deprecatedHeaderValues.set(headerName, new Set());
  }
  return deprecatedHeaderValues.get(headerName);
}

function maybeStripLearnedHeaderValues(headers, requestId, provider) {
  for (const [headerName, rejectedValues] of deprecatedHeaderValues) {
    if (!headers[headerName] || !rejectedValues.size) continue;
    const stripped = stripValuesFromHeader(headers, headerName, rejectedValues);
    if (!stripped) continue;
    logRequest('warn', 'deprecated_header_stripped', {
      request_id: requestId,
      provider,
      header: headerName,
      mode: 'cached',
      removed_values: stripped.removed,
      remaining_values: stripped.remaining,
      message: `Removed deprecated ${headerName} values learned from prior upstream 400 responses`,
    });
  }
}

function parseDeprecatedHeaderFromBody(body) {
  const match = body.toString('utf8').match(DEPRECATED_HEADER_PATTERN);
  if (!match) return null;
  return { value: match[1].trim(), header: match[2].trim() };
}

function learnAndStripDeprecatedHeaderValue(headers, headerName, deprecatedValue, requestId, provider) {
  const rejectedValues = getDeprecatedValuesForHeader(headerName);
  rejectedValues.add(deprecatedValue);
  if (rejectedValues.size > MAX_CACHED_VALUES_PER_HEADER) {
    const oldest = rejectedValues.values().next().value;
    if (oldest !== undefined) rejectedValues.delete(oldest);
  }
  const stripped = stripValuesFromHeader(headers, headerName, new Set([deprecatedValue]));
  if (!stripped) return null;
  logRequest('warn', 'deprecated_header_stripped', {
    request_id: requestId,
    provider,
    header: headerName,
    mode: 'retry',
    removed_values: stripped.removed,
    remaining_values: stripped.remaining,
    message: `Removed deprecated ${headerName} value rejected by upstream: ${deprecatedValue}`,
  });
  return stripped;
}

function getUrlPathForSpan(requestUrl) {
  if (typeof requestUrl !== 'string' || !requestUrl) return '/';
  try {
    return new URL(requestUrl, 'http://localhost').pathname || '/';
  } catch {
    return '/';
  }
}

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

  if (headers['x-ratelimit-limit']) {
    billing.rate_limit = headers['x-ratelimit-limit'];
    billing.rate_remaining = headers['x-ratelimit-remaining'];
    billing.rate_reset = headers['x-ratelimit-reset'];
    hasBilling = true;
  }

  return hasBilling ? billing : null;
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Return true if id is a safe, non-empty request-ID string.
 * Limits length and character set to prevent log injection.
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidRequestId(id) {
  return typeof id === 'string' && id.length <= 128 && /^[\w\-\.]+$/.test(id);
}

function handleRequestError(err, {
  res,
  requestId,
  provider,
  req,
  targetHost,
  startTime,
  statusCode,
  clientMessage,
  extraMetrics,
  onHeadersSent,
}) {
  const duration = Date.now() - startTime;
  metrics.gaugeDec('active_requests', { provider });
  metrics.increment('requests_errors_total', { provider });
  if (extraMetrics) extraMetrics(duration);
  logRequest('error', 'request_error', {
    request_id: requestId, provider, method: req.method,
    path: sanitizeForLog(req.url), duration_ms: duration,
    error: sanitizeForLog(err.message), upstream_host: targetHost,
  });
  if (res.headersSent) {
    if (onHeadersSent) onHeadersSent(err);
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: clientMessage, message: err.message }));
}

const checkRateLimit = createRateLimitChecker({
  limiter,
  metrics,
  logRequest,
  generateRequestId,
  isValidRequestId,
});

const proxyWebSocket = createProxyWebSocket({
  limiter,
  HTTPS_PROXY,
  metrics,
  logRequest,
  sanitizeForLog,
  generateRequestId,
  buildUpstreamPath,
  shouldStripHeader,
  isValidRequestId,
  getEffectiveTokenBlockState,
  buildEffectiveTokenLimitError,
  getMaxRunsBlockState,
  buildMaxRunsExceededError,
  trackWebSocketTokenUsage,
  applyEffectiveTokenUsage,
});

// ── Proxy helpers ─────────────────────────────────────────────────────────────

/**
 * Build the headers object for the upstream request.
 * Strips hop-by-hop headers, merges injected auth headers, sets the request-id,
 * and adjusts content-length when the body was transformed.
 *
 * @param {Buffer} body - Final (possibly transformed) request body
 * @param {number} inboundBytes - Original body size before transforms
 * @param {import('http').IncomingMessage} req
 * @param {{ injectHeaders: object, provider: string, targetHost: string, requestId: string }} opts
 * @returns {object} Headers object for the upstream request
 */
function buildRequestHeaders(body, inboundBytes, req, { injectHeaders, provider, targetHost, requestId }) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!shouldStripHeader(name)) headers[name] = value;
  }
  headers['x-request-id'] = requestId;
  Object.assign(headers, injectHeaders);

  if (provider === 'anthropic' || provider === 'copilot') {
    maybeStripLearnedHeaderValues(headers, requestId, provider);
  }

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

  return headers;
}

/**
 * Log request completion: emit metrics and a structured `request_complete` log.
 *
 * @param {number} statusCode
 * @param {number} responseBytes
 * @param {string|null} initiatorSent
 * @param {object|null} billingInfo
 * @param {{ startTime: number, provider: string, req: object, requestBytes: number, targetHost: string, requestId: string }} ctx
 */
function logRequestCompletion(statusCode, responseBytes, initiatorSent, billingInfo, {
  startTime, provider, req, requestBytes, targetHost, requestId,
}) {
  const duration = Date.now() - startTime;
  const sc = metrics.statusClass(statusCode);
  metrics.gaugeDec('active_requests', { provider });
  metrics.increment('requests_total', { provider, method: req.method, status_class: sc });
  metrics.increment('response_bytes_total', { provider }, responseBytes);
  metrics.observe('request_duration_ms', duration, { provider });
  if (statusCode >= 200 && statusCode < 300) {
    applyMaxRunsInvocation();
  }
  const logFields = {
    request_id: requestId, provider, method: req.method,
    path: sanitizeForLog(req.url), status: statusCode,
    duration_ms: duration, request_bytes: requestBytes,
    response_bytes: responseBytes, upstream_host: targetHost,
  };
  if (initiatorSent) logFields.x_initiator = initiatorSent;
  if (billingInfo) logFields.billing = billingInfo;
  logRequest('info', 'request_complete', logFields);
}

/**
 * Emit a warning log when the upstream returns an auth-related 4xx status.
 *
 * @param {number} statusCode
 * @param {{ requestId: string, provider: string, targetHost: string, req: object }} ctx
 */
function logUpstreamAuthError(statusCode, { requestId, provider, targetHost, req }) {
  if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
    logRequest('warn', 'upstream_auth_error', {
      request_id: requestId, provider, status: statusCode,
      upstream_host: targetHost, path: sanitizeForLog(req.url),
      message: `Upstream returned ${statusCode} — check that the API key is valid and correctly formatted`,
    });
  }
}

/**
 * Handle the upstream response: stream or buffer it, track tokens, handle errors,
 * and optionally retry once when a deprecated header value caused a 400.
 *
 * @param {import('http').IncomingMessage} proxyRes
 * @param {object} requestHeaders - Headers that were sent with the upstream request
 * @param {{ body: Buffer, res: object, provider: string, requestId: string, req: object,
 *           targetHost: string, startTime: number, span: object, requestBytes: number,
 *           hasRetried: boolean, onRetry: Function }} ctx
 */
function handleUpstreamResponse(proxyRes, requestHeaders, {
  body, res, provider, requestId, req, targetHost, startTime, span, requestBytes, hasRetried, onRetry,
}) {
  let responseBytes = 0;
  const billingInfo = extractBillingHeaders(proxyRes.headers);
  const initiatorSent = requestHeaders['x-initiator'] || null;
  const shouldBuffer400ForHeaderStrip =
    (provider === 'anthropic' || provider === 'copilot') &&
    !hasRetried &&
    proxyRes.statusCode === 400;

  const completionCtx = { startTime, provider, req, requestBytes, targetHost, requestId };
  const authErrCtx = { requestId, provider, targetHost, req };

  proxyRes.on('error', (err) => {
    otel.endSpanError(span, err, 502);
    handleRequestError(err, {
      res, requestId, provider, req, targetHost, startTime,
      statusCode: 502, clientMessage: 'Response stream error',
      onHeadersSent: () => {
        if (typeof res.destroy === 'function') res.destroy(err);
      },
    });
  });

  if (shouldBuffer400ForHeaderStrip) {
    const bufferedChunks = [];
    proxyRes.on('data', (chunk) => {
      responseBytes += chunk.length;
      bufferedChunks.push(chunk);
    });
    proxyRes.on('end', () => {
      const responseBody = Buffer.concat(bufferedChunks);
      const deprecated = parseDeprecatedHeaderFromBody(responseBody);
      if (deprecated) {
        const retryHeaders = { ...requestHeaders };
        const stripped = learnAndStripDeprecatedHeaderValue(
          retryHeaders, deprecated.header, deprecated.value, requestId, provider,
        );
        if (stripped) {
          onRetry(retryHeaders);
          return;
        }
      }

      logRequestCompletion(proxyRes.statusCode, responseBytes, initiatorSent, billingInfo, completionCtx);
      logUpstreamAuthError(proxyRes.statusCode, authErrCtx);

      const resHeaders = {
        ...proxyRes.headers,
        'x-request-id': requestId,
        'content-length': String(responseBody.length),
      };
      delete resHeaders['transfer-encoding'];
      res.writeHead(proxyRes.statusCode, resHeaders);
      res.end(responseBody);
      otel.endSpan(span, proxyRes.statusCode);
    });
    return;
  }

  proxyRes.on('data', (chunk) => { responseBytes += chunk.length; });
  proxyRes.on('end', () => {
    logRequestCompletion(proxyRes.statusCode, responseBytes, initiatorSent, billingInfo, completionCtx);
  });

  const resHeaders = { ...proxyRes.headers, 'x-request-id': requestId };
  logUpstreamAuthError(proxyRes.statusCode, authErrCtx);
  res.writeHead(proxyRes.statusCode, resHeaders);
  proxyRes.pipe(res);

  const isStreaming = (proxyRes.headers['content-type'] || '').includes('text/event-stream');
  trackTokenUsage(proxyRes, {
    requestId, provider, path: sanitizeForLog(req.url), startTime, metrics, billingInfo, initiatorSent,
    onUsage: (normalizedUsage, model) => {
      otel.setTokenAttributes(span, { provider, model, normalizedUsage, streaming: isStreaming });
      applyEffectiveTokenUsage(normalizedUsage, model);
    },
    onSpanEnd: (statusCode) => {
      otel.endSpan(span, statusCode);
    },
  });
}

/**
 * Create and dispatch the upstream HTTPS request.
 * Sets up the proxyReq error handler, writes the body, and delegates response
 * handling to handleUpstreamResponse (including the one-shot retry path).
 *
 * @param {object} requestHeaders - Headers for the upstream request
 * @param {{ body: Buffer, targetHost: string, upstreamPath: string, req: object,
 *           res: object, provider: string, requestId: string, startTime: number,
 *           span: object, requestBytes: number, hasRetried?: boolean }} ctx
 */
function sendUpstreamRequest(requestHeaders, {
  body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
  hasRetried = false,
}) {
  const options = {
    hostname: targetHost, port: 443, path: upstreamPath,
    method: req.method, headers: requestHeaders,
    agent: proxyAgent,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    handleUpstreamResponse(proxyRes, requestHeaders, {
      body, res, provider, requestId, req, targetHost, startTime, span, requestBytes,
      hasRetried,
      onRetry: (retryHeaders) => sendUpstreamRequest(retryHeaders, {
        body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
        hasRetried: true,
      }),
    });
  });

  proxyReq.on('error', (err) => {
    otel.endSpanError(span, err, 502);
    handleRequestError(err, {
      res, requestId, provider, req, targetHost, startTime,
      statusCode: 502, clientMessage: 'Proxy error',
      extraMetrics: (duration) => {
        metrics.increment('requests_total', { provider, method: req.method, status_class: '5xx' });
        metrics.observe('request_duration_ms', duration, { provider });
      },
    });
  });

  if (body.length > 0) proxyReq.write(body);
  proxyReq.end();
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
 * @param {((body: Buffer) => (Buffer | null | Promise<Buffer | null>)) | null} [bodyTransform=null]
 */
function proxyRequest(req, res, targetHost, injectHeaders, provider, basePath = '', bodyTransform = null) {
  const clientRequestId = req.headers['x-request-id'];
  const requestId = isValidRequestId(clientRequestId) ? clientRequestId : generateRequestId();
  const startTime = Date.now();

  // Start OTEL span (no-op when OTEL is not configured).
  const span = otel.startRequestSpan({
    provider,
    method:    req.method,
    path:      getUrlPathForSpan(req.url),
    requestId,
  });

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
    otel.endSpan(span, 400);
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
    otel.endSpanError(span, err, 400);
    handleRequestError(err, {
      res,
      requestId,
      provider,
      req,
      targetHost,
      startTime,
      statusCode: 400,
      clientMessage: 'Client error',
    });
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
      otel.endSpan(span, 413);
      if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large', message: 'Request body exceeds 10 MB limit' }));
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (rejected || errored) return;
    let body = Buffer.concat(chunks);
    const inboundBytes = body.length;

    if (bodyTransform && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
      const transformed = await bodyTransform(body);
      if (transformed) body = transformed;
    }

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const sanitized = sanitizeNullToolCallTypes(body);
      if (sanitized) {
        body = sanitized.body;
        logRequest('info', 'request_sanitized', {
          request_id: requestId,
          provider,
          normalized_tool_calls: sanitized.normalizedCount,
          dropped_tool_calls: sanitized.droppedCount,
        });
      }
    }

    if (isSteeringEnabled() && (req.method === 'POST' || req.method === 'PUT')) {
      const steeringMessages = [
        { type: 'timeout', message: getAndClearPendingTimeoutSteeringMessage() },
        { type: 'token', message: getAndClearPendingSteeringMessage() },
      ];
      for (const { type, message } of steeringMessages) {
        if (!message) continue;
        const steered = injectSteeringMessage(body, provider, message);
        if (steered) {
          body = steered;
          logRequest('info', `${type}_steering`, {
            request_id: requestId,
            provider,
            message,
          });
        }
      }
    }

    // Inject stream_options.include_usage so streaming responses include token data
    if (req.method === 'POST') {
      const streamOpts = injectStreamOptions(body, provider);
      if (streamOpts) {
        body = streamOpts.body;
      }
    }

    const requestBytes = body.length;
    metrics.increment('request_bytes_total', { provider }, requestBytes);

    const headers = buildRequestHeaders(body, inboundBytes, req, { injectHeaders, provider, targetHost, requestId });

    const etBlock = getEffectiveTokenBlockState();
    if (etBlock && etBlock.maxExceeded) {
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('warn', 'effective_tokens_limit_exceeded', {
        request_id: requestId,
        provider,
        total_effective_tokens: etBlock.totalEffectiveTokens,
        max_effective_tokens: etBlock.maxEffectiveTokens,
      });
      otel.endSpan(span, 429);
      res.writeHead(429, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
      res.end(JSON.stringify(buildEffectiveTokenLimitError(etBlock)));
      return;
    }

    const mrBlock = getMaxRunsBlockState();
    if (mrBlock && mrBlock.maxExceeded) {
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
      metrics.observe('request_duration_ms', duration, { provider });
      logRequest('warn', 'max_runs_exceeded', {
        request_id: requestId,
        provider,
        invocation_count: mrBlock.invocationCount,
        max_runs: mrBlock.maxRuns,
      });
      otel.endSpan(span, 429);
      res.writeHead(429, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
      res.end(JSON.stringify(buildMaxRunsExceededError(mrBlock)));
      return;
    }

    sendUpstreamRequest(headers, {
      body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
    });
  });
}

module.exports = {
  isValidRequestId,
  checkRateLimit,
  proxyRequest,
  proxyWebSocket,
  extractBillingHeaders,
  limiter,
  proxyAgent,
  HTTPS_PROXY,
  getEffectiveTokenReflectState,
  getMaxRunsReflectState,
  resetEffectiveTokenGuardForTests,
  resetMaxRunsGuardForTests,
  resetTimeoutSteeringForTests,
  resetAnthropicDeprecatedBetaHeadersForTests: () => deprecatedHeaderValues.clear(),
  getAndClearPendingSteeringMessage,
  getAndClearPendingTimeoutSteeringMessage,
  injectSteeringMessage,
};
