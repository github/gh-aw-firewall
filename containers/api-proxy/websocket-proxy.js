'use strict';

const http = require('http');
const tls = require('tls');
const { URL } = require('url');

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
  trackWebSocketTokenUsage,
  applyEffectiveTokenUsage,
  applyAiCreditsUsage,
}) {
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

    const etBlock = getEffectiveTokenBlockState();
    if (etBlock && etBlock.maxExceeded) {
      logRequest('warn', 'effective_tokens_limit_exceeded', {
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

    const mrBlock = getMaxRunsBlockState();
    if (mrBlock && mrBlock.maxExceeded) {
      logRequest('warn', 'max_runs_exceeded', {
        request_id: requestId,
        provider,
        invocation_count: mrBlock.invocationCount,
        max_runs: mrBlock.maxRuns,
      });
      socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
      socket.write(JSON.stringify(buildMaxRunsExceededError(mrBlock)));
      socket.destroy();
      return;
    }

    const pdBlock = getPermissionDeniedBlockState();
    if (pdBlock && pdBlock.maxExceeded) {
      logRequest('warn', 'permission_denied_limit_exceeded', {
        request_id: requestId,
        provider,
        denied_count: pdBlock.deniedCount,
        max_permission_denied: pdBlock.maxPermissionDenied,
      });
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
      socket.write(JSON.stringify(buildPermissionDeniedLimitError(pdBlock)));
      socket.destroy();
      return;
    }

    const aiCreditsBlock = getAiCreditsBlockState();
    if (aiCreditsBlock && aiCreditsBlock.maxExceeded) {
      logRequest('warn', 'ai_credits_limit_exceeded', {
        request_id: requestId,
        provider,
        total_ai_credits: aiCreditsBlock.totalAiCredits,
        max_ai_credits: aiCreditsBlock.maxAiCredits,
      });
      socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
      socket.write(JSON.stringify(buildAiCreditsLimitError(aiCreditsBlock)));
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
            const effectiveTokenUsage = applyEffectiveTokenUsage(normalizedUsage, model);
            const aiCreditsUsage = applyAiCreditsUsage(normalizedUsage, model);
            if (effectiveTokenUsage || aiCreditsUsage) {
              logRequest('info', 'token_budget_usage', {
                request_id: requestId,
                provider,
                model: model || 'unknown',
                effectiveTokensThisResponse: effectiveTokenUsage?.effectiveTokensThisResponse ?? null,
                ai_credits_this_response: aiCreditsUsage?.aiCreditsThisResponse ?? null,
                ai_credits_total: aiCreditsUsage?.totalAiCredits ?? null,
              });
            }
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
