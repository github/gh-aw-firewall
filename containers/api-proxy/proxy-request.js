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
const {
  maybeStripLearnedHeaderValues,
  resetDeprecatedHeaderValuesForTests,
  parseDeprecatedHeaderFromBody,
  learnAndStripDeprecatedHeaderValue,
} = require('./deprecated-header-tracker');
const { extractBillingHeaders } = require('./billing-headers');
const { createUpstreamResponseHandlers } = require('./upstream-response');
const { createRateLimitChecker } = require('./rate-limit');
const { createProxyWebSocket } = require('./websocket-proxy');
const {
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
  applyPermissionDenied,
  getPermissionDeniedBlockState,
  getPermissionDeniedReflectState,
  resetPermissionDeniedGuardForTests,
  buildPermissionDeniedLimitError,
} = require('./guards/max-permission-denied-guard');
const {
  getAndClearPendingTimeoutSteeringMessage,
  resetTimeoutSteeringForTests,
} = require('./guards/timeout-steering');
const {
  getModelMultiplierCapBlockState,
  buildModelMultiplierCapError,
  resetMaxModelMultiplierGuardForTests,
} = require('./guards/max-model-multiplier-guard');
const {
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  checkUnknownModelRejection,
  resetAiCreditsGuardForTests,
} = require('./guards/ai-credits-guard');
const {
  getRetiredModelBlockState,
  buildRetiredModelError,
} = require('./guards/retired-model-guard');
const { writeBlockedRequestDiag } = require('./blocked-request-diagnostics');
const { buildCommonGuardChecks } = require('./guards/common-guard-checks');

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
      setBudgetAttributes: noop,
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

/**
 * Backoff delays (ms) between successive model-not-supported retries.
 * Index 0 → delay before the 1st retry, index 1 → delay before the 2nd retry.
 */
const MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS = [1000, 2000];

/** Resolves after `ms` milliseconds (overridable in tests via module-level setter). */
let _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @internal Test-only: replace the sleep implementation so retries are instant. */
function _setSleepForTests(fn) { _sleep = fn; }
/** @internal Test-only: restore the real sleep implementation. */
function _resetSleepForTests() { _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)); }

function getUrlPathForSpan(requestUrl) {
  if (typeof requestUrl !== 'string' || !requestUrl) return '/';
  try {
    return new URL(requestUrl, 'http://localhost').pathname || '/';
  } catch {
    return '/';
  }
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

/**
 * Attempt to extract the `model` field from a JSON request body.
 * Returns null for non-JSON bodies, bodies without a string `model` field,
 * or any parse failures.
 *
 * @param {Buffer} body
 * @returns {string|null}
 */
function extractModelFromBody(body) {
  if (!body || body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return typeof parsed.model === 'string' ? parsed.model : null;
    }
    return null;
  } catch {
    return null;
  }
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
  getPermissionDeniedBlockState,
  buildPermissionDeniedLimitError,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  getModelMultiplierCapBlockState,
  buildModelMultiplierCapError,
  getRetiredModelBlockState,
  buildRetiredModelError,
  checkUnknownModelRejection,
  trackWebSocketTokenUsage,
});

// ── Proxy helpers ─────────────────────────────────────────────────────────────

/**
 * Build the headers object for the upstream request.
 * Strips headers matched by `shouldStripHeader()`, merges injected auth
 * headers, sets the request-id, and adjusts content-length when the body was
 * transformed.
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

const { handleUpstreamResponse } = createUpstreamResponseHandlers({
  metrics,
  logRequest,
  sanitizeForLog,
  otel,
  handleRequestError,
  trackTokenUsage,
  applyMaxRunsInvocation,
  applyPermissionDenied,
  extractBillingHeaders,
  parseDeprecatedHeaderFromBody,
  learnAndStripDeprecatedHeaderValue,
});

/**
 * Create and dispatch the upstream HTTPS request.
 * Sets up the proxyReq error handler, writes the body, and delegates response
 * handling to handleUpstreamResponse (including the one-shot retry path).
 *
 * @param {object} requestHeaders - Headers for the upstream request
 * @param {{ body: Buffer, targetHost: string, upstreamPath: string, req: object,
 *           res: object, provider: string, requestId: string, startTime: number,
 *           span: object, requestBytes: number, hasRetried?: boolean,
 *           modelNotSupportedRetryCount?: number }} ctx
 */
function sendUpstreamRequest(requestHeaders, {
  body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
  hasRetried = false,
  modelNotSupportedRetryCount = 0,
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
      modelNotSupportedRetryCount,
      onRetry: (retryHeaders) => sendUpstreamRequest(retryHeaders, {
        body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
        hasRetried: true,
        modelNotSupportedRetryCount,
      }),
      onModelNotSupportedRetry: () => {
        const delayMs = MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS[modelNotSupportedRetryCount] ?? 2000;
        _sleep(delayMs).then(() => {
          sendUpstreamRequest(requestHeaders, {
            body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
            hasRetried,
            modelNotSupportedRetryCount: modelNotSupportedRetryCount + 1,
          });
        });
      },
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

function sendGuardBlockedResponse(block, {
  req,
  res,
  provider,
  requestId,
  startTime,
  span,
  statusCode,
  eventName,
  buildError,
  buildLogFields,
  body,
  inboundBytes,
}) {
  const duration = Date.now() - startTime;
  const guardLogFields = buildLogFields(block);
  metrics.gaugeDec('active_requests', { provider });
  metrics.increment('requests_total', { provider, method: req.method, status_class: '4xx' });
  metrics.observe('request_duration_ms', duration, { provider });
  logRequest('warn', eventName, {
    request_id: requestId,
    provider,
    ...guardLogFields,
  });
  otel.endSpan(span, statusCode);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
  res.end(JSON.stringify(buildError(block)));

  writeBlockedRequestDiag({
    requestId,
    provider,
    path: sanitizeForLog(req.url),
    guardType: eventName,
    guardLogFields,
    body: body || Buffer.alloc(0),
    inboundBytes: inboundBytes || 0,
  });
}

function enforceGuards({ body, provider, req, res, requestId, startTime, span, inboundBytes }) {
  const checkModelMultiplier = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
  const model = checkModelMultiplier ? extractModelFromBody(body) : null;

  const guardChecks = buildCommonGuardChecks({
    getEffectiveTokenBlockState,
    buildEffectiveTokenLimitError,
    getMaxRunsBlockState,
    buildMaxRunsExceededError,
    getPermissionDeniedBlockState,
    buildPermissionDeniedLimitError,
    getAiCreditsBlockState,
    buildAiCreditsLimitError,
    getModelMultiplierCapBlockState,
    buildModelMultiplierCapError,
    getRetiredModelBlockState,
    buildRetiredModelError,
    checkUnknownModelRejection,
  }, model);

  for (const guard of guardChecks) {
    if (!guard.isBlocked(guard.block)) continue;
    sendGuardBlockedResponse(guard.block, {
      req,
      res,
      provider,
      requestId,
      startTime,
      span,
      statusCode: guard.statusCode,
      eventName: guard.eventName,
      buildError: guard.buildError,
      buildLogFields: guard.buildLogFields,
      body,
      inboundBytes,
    });
    return true;
  }

  return false;
}

// ── Core proxy: HTTP ──────────────────────────────────────────────────────────

/**
 * Collect the full request body from the inbound stream, enforcing the 10 MB
 * size limit. Sends a 413 response inline when the limit is exceeded, and
 * handles client stream errors with a 400 response.
 *
 * @param {import('http').IncomingMessage} req
 * @param {string} provider
 * @param {string} requestId
 * @param {import('http').ServerResponse} res
 * @param {object} span - OTEL span (or no-op shim)
 * @param {number} startTime - Request start timestamp (ms)
 * @param {string} targetHost - Upstream hostname (used in log fields)
 * @returns {Promise<Buffer|null>} Collected body, or null if the request was
 *   already rejected (413) or errored before the body was fully received.
 */
function collectRequestBody(req, provider, requestId, res, span, startTime, targetHost) {
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    function settle(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    req.on('close', () => {
      if (settled || req.complete) return;
      const duration = Date.now() - startTime;
      metrics.gaugeDec('active_requests', { provider });
      logRequest('warn', 'request_aborted', {
        request_id: requestId, provider, method: req.method,
        path: sanitizeForLog(req.url), duration_ms: duration,
        upstream_host: targetHost,
      });
      otel.endSpan(span, 0);
      settle(null);
    });

    req.on('error', (err) => {
      if (settled) return;
      otel.endSpanError(span, err, 400);
      handleRequestError(err, {
        res, requestId, provider, req, targetHost,
        startTime, statusCode: 400, clientMessage: 'Client error',
      });
      settle(null);
    });

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_SIZE) {
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
        settle(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      settle(Buffer.concat(chunks));
    });
  });
}

/**
 * Apply the sequential body-transform pipeline to the raw inbound body.
 *
 * Transforms applied in order:
 *   1. `bodyTransform` — optional caller-supplied transform
 *   2. `sanitizeNullToolCallTypes` — strips/normalizes null tool-call types
 *   3. `injectSteeringMessage` — timeout + token-budget steering (when enabled)
 *   4. `injectStreamOptions` — adds `stream_options.include_usage`
 *
 * @param {Buffer} body
 * @param {string} provider
 * @param {import('http').IncomingMessage} req
 * @param {string} requestId
 * @param {((body: Buffer) => (Buffer | null | Promise<Buffer | null>)) | null} bodyTransform
 * @returns {Promise<Buffer>}
 */
async function transformRequestBody(body, provider, req, requestId, bodyTransform) {
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
    const streamOpts = injectStreamOptions(body, provider, req.url);
    if (streamOpts) {
      body = streamOpts.body;
    }
  }

  return body;
}

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

  // Step 1: collect body (enforces 10 MB limit; returns null if already rejected)
  collectRequestBody(req, provider, requestId, res, span, startTime, targetHost).then(async (rawBody) => {
    if (rawBody === null) return;

    // Step 2: apply transform pipeline
    const inboundBytes = rawBody.length;
    const body = await transformRequestBody(rawBody, provider, req, requestId, bodyTransform);

    // Step 3: dispatch upstream
    const requestBytes = body.length;
    metrics.increment('request_bytes_total', { provider }, requestBytes);

    const headers = buildRequestHeaders(body, inboundBytes, req, { injectHeaders, provider, targetHost, requestId });

    if (enforceGuards({ body, provider, req, res, requestId, startTime, span, inboundBytes })) return;

    sendUpstreamRequest(headers, {
      body, targetHost, upstreamPath, req, res, provider, requestId, startTime, span, requestBytes,
    });
  });
}

module.exports = {
  isValidRequestId,
  checkRateLimit,
  collectRequestBody,
  transformRequestBody,
  proxyRequest,
  proxyWebSocket,
  extractBillingHeaders,
  limiter,
  proxyAgent,
  HTTPS_PROXY,
  getEffectiveTokenReflectState,
  getAiCreditsReflectState,
  getMaxRunsReflectState,
  getPermissionDeniedReflectState,
  resetEffectiveTokenGuardForTests,
  resetAiCreditsGuardForTests,
  resetMaxRunsGuardForTests,
  resetPermissionDeniedGuardForTests,
  resetMaxModelMultiplierGuardForTests,
  resetTimeoutSteeringForTests,
  resetAnthropicDeprecatedBetaHeadersForTests: resetDeprecatedHeaderValuesForTests,
  getAndClearPendingSteeringMessage,
  getAndClearPendingTimeoutSteeringMessage,
  injectSteeringMessage,
  _setSleepForTests,
  _resetSleepForTests,
};
