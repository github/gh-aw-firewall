'use strict';

const http = require('http');
const tls = require('tls');
const { URL } = require('url');
const { computeTokenBudgetUsage } = require('./token-budget-log');
const { buildCommonGuardChecks } = require('./guards/common-guard-checks');

/** Maps numeric status codes used by guards to HTTP/1.1 reason phrases. */
const HTTP_STATUS_LINES = {
  400: '400 Bad Request',
  403: '403 Forbidden',
  429: '429 Too Many Requests',
};

/**
 * Enforce all common security guards for a WebSocket upgrade request.
 * Writes a raw HTTP error response to the socket and destroys it when any
 * guard triggers, then returns true.  Returns false when all guards pass.
 *
 * @param {object} ctx
 * @param {import('net').Socket} ctx.socket
 * @param {Function} ctx.logRequest
 * @param {string} ctx.requestId
 * @param {string} ctx.provider
 * @param {object} guardDeps - Guard state getter and error-builder functions
 *   (same shape as the `deps` parameter of buildCommonGuardChecks).
 * @returns {boolean} true when a guard blocked the request.
 */
function enforceWebSocketGuards({ socket, logRequest, requestId, provider }, guardDeps) {
  // WebSocket upgrade requests have no JSON body, so model-specific guards
  // receive null and are skipped (their getters return null for null models).
  const guardChecks = buildCommonGuardChecks(guardDeps, null);

  for (const guard of guardChecks) {
    if (!guard.isBlocked(guard.block)) continue;

    const block = guard.block;
    logRequest('warn', guard.eventName, {
      request_id: requestId,
      provider,
      ...guard.buildLogFields(block),
    });

    const statusLine = HTTP_STATUS_LINES[guard.statusCode] || String(guard.statusCode);
    socket.write(`HTTP/1.1 ${statusLine}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`);
    socket.write(JSON.stringify(guard.buildError(block)));
    socket.destroy();
    return true;
  }

  return false;
}

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
}) {
  const guardDeps = {
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
  };
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
            return computeTokenBudgetUsage({ logRequest, requestId, provider }, normalizedUsage, model);
          },
        });

        socket.once('close', () => { finalize(false); tlsSocket.destroy(); });
        tlsSocket.once('close', () => { finalize(false); socket.destroy(); });
        socket.on('error', () => socket.destroy());
        tlsSocket.on('error', () => tlsSocket.destroy());
      });
    });

    connectReq.end();
  };
}

module.exports = {
  createProxyWebSocket,
};
