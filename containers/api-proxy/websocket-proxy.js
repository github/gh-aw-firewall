'use strict';

const { enforceWebSocketGuards, enforceWebSocketRateLimit } = require('./websocket-guards');
const { createWebSocketTunnel } = require('./websocket-tunnel');

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
}) {
  const guardDeps = {
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
   */
  return function proxyWebSocket(req, socket, head, targetHost, injectHeaders, provider, basePath = '') {
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

    if (enforceWebSocketGuards({ socket, logRequest, requestId, provider }, guardDeps)) {
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
      injectHeaders,
      provider,
      requestId,
      startTime,
      upstreamPath,
    });
  };
}

module.exports = {
  createProxyWebSocket,
};
