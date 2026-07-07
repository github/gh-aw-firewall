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
const { isValidRequestId, buildRequestHeaders } = require('./request-headers');
const { createSendUpstreamRequest } = require('./upstream-http');
const metrics = require('./metrics');
const rateLimiter = require('./rate-limiter');
const { buildUpstreamPath, shouldStripHeader } = require('./proxy-utils');
const { injectSteeringMessage } = require('./body-transform');
const { handleRequestError } = require('./proxy-error-handler');
const {
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
  getMaxCacheMissesBlockState,
  getMaxCacheMissesReflectState,
  resetMaxCacheMissesGuardForTests,
  buildMaxCacheMissesExceededError,
} = require('./guards/max-cache-misses-guard');
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
const {
  getModelPolicyBlockState,
  buildModelPolicyError,
} = require('./guards/model-policy-guard');
const { enforceGuards } = require('./proxy-guards');

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

function getUrlPathForSpan(requestUrl) {
  if (typeof requestUrl !== 'string' || !requestUrl) return '/';
  try {
    return new URL(requestUrl, 'http://localhost').pathname || '/';
  } catch {
    return '/';
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

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
  getMaxCacheMissesBlockState,
  buildMaxCacheMissesExceededError,
  getPermissionDeniedBlockState,
  buildPermissionDeniedLimitError,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  getModelMultiplierCapBlockState,
  buildModelMultiplierCapError,
  getRetiredModelBlockState,
  buildRetiredModelError,
  checkUnknownModelRejection,
  getModelPolicyBlockState,
  buildModelPolicyError,
  trackWebSocketTokenUsage,
});

// ── Proxy helpers ─────────────────────────────────────────────────────────────

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

const sendUpstreamRequest = createSendUpstreamRequest({
  https,
  proxyAgent,
  handleUpstreamResponse,
  sleep,
  otel,
  handleRequestError,
  metrics,
});

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
  getMaxCacheMissesReflectState,
  getPermissionDeniedReflectState,
  resetEffectiveTokenGuardForTests,
  resetAiCreditsGuardForTests,
  resetMaxRunsGuardForTests,
  resetMaxCacheMissesGuardForTests,
  resetPermissionDeniedGuardForTests,
  resetMaxModelMultiplierGuardForTests,
  resetTimeoutSteeringForTests,
  resetAnthropicDeprecatedBetaHeadersForTests: resetDeprecatedHeaderValuesForTests,
  getAndClearPendingSteeringMessage,
  getAndClearPendingTimeoutSteeringMessage,
  injectSteeringMessage,
  _setSleepForTests,
  _resetSleepForTests,
  handleRequestError,
};
