'use strict';

const { enforceWebSocketGuards, enforceWebSocketRateLimit } = require('./websocket-guards');
const { createWebSocketTunnel, extractRequestModelFromUrl } = require('./websocket-tunnel');
const { getCatalogueLoader } = require('./catalogue-loader');
const { captureRuntimePricing } = require('./runtime-model-catalog');
const { getModelUnavailability } = require('./model-recovery');
const { isGithubCopilotCatalogTarget } = require('./providers/copilot-auth');
const { pinRequestEligibility } = require('./model-eligibility');
const { getRequestModel } = require('./model-fallback-chain');

function createProxyWebSocket({
  limiter,
  HTTPS_PROXY,
  metrics,
  logRequest,
  sanitizeForLog,
  generateRequestId,
  buildUpstreamPath,
  shouldStripHeader,
  isValidRequestId,
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
  checkModelPricing,
  getModelPolicyBlockState,
  buildModelPolicyError,
  trackWebSocketTokenUsage,
}) {
  const guardDeps = {
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
    checkModelPricing,
    getModelPolicyBlockState,
    buildModelPolicyError,
  };
  const openWebSocketTunnel = createWebSocketTunnel({
    HTTPS_PROXY,
    metrics,
    logRequest,
    sanitizeForLog,
    shouldStripHeader,
    trackWebSocketTokenUsage,
  });
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
   * @param {Object} [lifecycleHooks={}]
   * @param {(clientSocket: import('net').Socket, upstreamSocket: import('net').Socket) => void} [lifecycleHooks.onSocketsReady]
   * @param {'http'|'https'} [lifecycleHooks.targetScheme='https'] - Scheme to
   *   dial the upstream on; 'http' skips the TLS handshake and CONNECTs to
   *   port 80 instead of 443.
   */
  return function proxyWebSocket(req, socket, head, targetHost, injectHeaders, provider, basePath = '', lifecycleHooks = {}) {
    pinRequestEligibility(req);
    req.awfModelCatalogAuthoritative = provider === 'copilot' && isGithubCopilotCatalogTarget(targetHost);
    req.awfCatalogue = getCatalogueLoader().capture();
    req.awfRuntimePricing = captureRuntimePricing();
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

    const requestModel = extractRequestModelFromUrl(req.url);
    const eligibilityModel = getRequestModel(null, req.url) ||
      (requestModel ? { model: requestModel, location: 'query' } : null);
    const upstreamPath = buildUpstreamPath(req.url, targetHost, basePath);

    if (enforceWebSocketGuards({
      socket, logRequest, requestId, provider, requestModel, eligibilityModel, req,
      pricingOptions: { catalogue: req.awfCatalogue, runtimeCatalog: req.awfRuntimePricing },
    }, guardDeps)) {
      return;
    }

    // Future opaque frames can carry tools/features (and another model). Do
    // not rewrite only the handshake and claim compatibility for the session.
    const unavailable = getModelUnavailability(requestModel, provider, req);
    if (unavailable) {
      logRequest('warn', 'model_recovery_requires_http', {
        request_id: requestId, provider,
        requested_model: sanitizeForLog(requestModel), reason: unavailable.reason,
      });
      const body = JSON.stringify({ error: {
        code: 'model_recovery_requires_http',
        type: 'invalid_request_error',
        message: 'Model is unavailable. Use HTTP inference for compatible model recovery, or select an available model before opening the WebSocket.',
      } });
      socket.write(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.destroy();
      return;
    }

    if (enforceWebSocketRateLimit({ limiter, metrics, logRequest, socket, requestId, provider })) {
      return;
    }

    logRequest('info', 'websocket_upgrade_start', {
      request_id: requestId, provider, path: sanitizeForLog(req.url), upstream_host: targetHost,
    });
    metrics.gaugeInc('active_requests', { provider });

    openWebSocketTunnel({
      req,
      socket,
      head,
      targetHost,
      targetScheme: lifecycleHooks.targetScheme || 'https',
      injectHeaders,
      provider,
      requestId,
      startTime,
      upstreamPath,
      requestModel,
      onSocketsReady: lifecycleHooks.onSocketsReady,
    });
  };
}

module.exports = {
  createProxyWebSocket,
};
