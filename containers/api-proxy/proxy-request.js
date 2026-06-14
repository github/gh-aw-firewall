'use strict';

/**
 * AWF API Proxy — HTTP Proxy Core and shared exports.
 *
 * Security note: proxyRequest is the credential injection path. Any change here
 * should be reviewed carefully for header-injection and SSRF risks.
 */

const https = require('https');
const { HTTPS_PROXY, proxyAgent } = require('./http-client');
const { createBodyHandler, sleep, _setSleepForTests, _resetSleepForTests } = require('./body-handler');
const { generateRequestId, sanitizeForLog, logRequest } = require('./logging');
const metrics = require('./metrics');
const rateLimiter = require('./rate-limiter');
const { buildUpstreamPath, shouldStripHeader } = require('./proxy-utils');
const { injectSteeringMessage } = require('./body-transform');
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

// ── Module-level constants ────────────────────────────────────────────────────

/** Shared RateLimiter instance. */
const limiter = rateLimiter.create();

/**
 * Backoff delays (ms) between successive model-not-supported retries.
 * Index 0 → delay before the 1st retry, index 1 → delay before the 2nd retry.
 */
const MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS = [1000, 2000];

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

const { collectRequestBody, transformRequestBody } = createBodyHandler({ handleRequestError, otel });

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
        sleep(delayMs).then(() => {
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
  const guardChecks = [
    {
      block: getEffectiveTokenBlockState(),
      isBlocked: block => block && block.maxExceeded,
      statusCode: 429,
      eventName: 'effective_tokens_limit_exceeded',
      buildError: buildEffectiveTokenLimitError,
      buildLogFields: block => ({
        total_effective_tokens: block.totalEffectiveTokens,
        max_effective_tokens: block.maxEffectiveTokens,
      }),
    },
    {
      block: getMaxRunsBlockState(),
      isBlocked: block => block && block.maxExceeded,
      statusCode: 429,
      eventName: 'max_runs_exceeded',
      buildError: buildMaxRunsExceededError,
      buildLogFields: block => ({
        invocation_count: block.invocationCount,
        max_runs: block.maxRuns,
      }),
    },
    {
      block: getPermissionDeniedBlockState(),
      isBlocked: block => block && block.maxExceeded,
      statusCode: 403,
      eventName: 'permission_denied_limit_exceeded',
      buildError: buildPermissionDeniedLimitError,
      buildLogFields: block => ({
        denied_count: block.deniedCount,
        max_permission_denied: block.maxPermissionDenied,
      }),
    },
    {
      block: getAiCreditsBlockState(),
      isBlocked: block => block && block.maxExceeded,
      statusCode: 429,
      eventName: 'ai_credits_limit_exceeded',
      buildError: buildAiCreditsLimitError,
      buildLogFields: block => ({
        total_ai_credits: block.totalAiCredits,
        max_ai_credits: block.maxAiCredits,
        hard_cap: block.hardCap === true,
      }),
    },
    ...(checkModelMultiplier
      ? [{
        block: getModelMultiplierCapBlockState(extractModelFromBody(body)),
        isBlocked: block => !!block,
        statusCode: 400,
        eventName: 'model_multiplier_cap_exceeded',
        buildError: buildModelMultiplierCapError,
        buildLogFields: block => ({
          model: block.model,
          model_multiplier: block.multiplier,
          max_model_multiplier: block.maxModelMultiplier,
        }),
      }]
      : []),
    ...(checkModelMultiplier
      ? [{
        block: getRetiredModelBlockState(extractModelFromBody(body)),
        isBlocked: block => !!block,
        statusCode: 400,
        eventName: 'retired_model',
        buildError: buildRetiredModelError,
        buildLogFields: block => ({
          model: block.model,
          suggestion: block.suggestion,
        }),
      }]
      : []),
    ...(checkModelMultiplier
      ? [{
        block: checkUnknownModelRejection(extractModelFromBody(body)),
        isBlocked: block => !!block,
        statusCode: 400,
        eventName: 'unknown_model_ai_credits',
        buildError: block => block.error,
        buildLogFields: block => ({
          model: block.model,
        }),
      }]
      : []),
  ];

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
