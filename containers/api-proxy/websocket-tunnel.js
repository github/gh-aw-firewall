'use strict';

const http = require('http');
const tls = require('tls');
const { URL } = require('url');
const { computeTokenBudgetUsage } = require('./token-budget-log');
const { applyCopilotHostHeaders, mergeInjectedHeaders } = require('./request-headers');

function extractRequestModelFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  try {
    const parsed = new URL(url, 'http://awf.local');
    const model = parsed.searchParams.get('model');
    return model && model.length > 0 ? model : null;
  } catch {
    return null;
  }
}

function createProxyErrorResponder({
  metrics,
  logRequest,
  sanitizeForLog,
  req,
  socket,
  provider,
  requestId,
  startTime,
}) {
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
    for (const s of extra) {
      if (s && !s.destroyed) s.destroy();
    }
  }

  return { finalize, abort };
}

function createWebSocketTunnel({
  HTTPS_PROXY,
  metrics,
  logRequest,
  sanitizeForLog,
  shouldStripHeader,
  trackWebSocketTokenUsage,
}) {
  return function openWebSocketTunnel({
    req,
    socket,
    head,
    targetHost,
    targetScheme = 'https',
    injectHeaders,
    provider,
    requestId,
    startTime,
    upstreamPath,
    requestModel,
    onSocketsReady,
  }) {
    const { finalize, abort } = createProxyErrorResponder({
      metrics,
      logRequest,
      sanitizeForLog,
      req,
      socket,
      provider,
      requestId,
      startTime,
    });

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
    const isHttps = targetScheme !== 'http';
    const targetPort = isHttps ? 443 : 80;

    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { 'Host': `${targetHost}:${targetPort}` },
    });

    connectReq.once('error', (err) => abort(`CONNECT error: ${err.message}`));

    connectReq.once('connect', (connectRes, tunnel) => {
      if (connectRes.statusCode !== 200) {
        abort(`CONNECT failed: HTTP ${connectRes.statusCode}`, tunnel);
        return;
      }

      const sendUpgrade = (upstreamSocket) => {
        const forwardHeaders = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (!shouldStripHeader(name)) forwardHeaders[name] = value;
        }
        mergeInjectedHeaders(forwardHeaders, injectHeaders, targetHost);
        applyCopilotHostHeaders(forwardHeaders, targetHost);
        forwardHeaders.host = targetHost;

        let upgradeReqStr = `GET ${upstreamPath} HTTP/1.1\r\n`;
        for (const [name, value] of Object.entries(forwardHeaders)) {
          upgradeReqStr += `${name}: ${value}\r\n`;
        }
        upgradeReqStr += '\r\n';
        upstreamSocket.write(upgradeReqStr);

        if (head && head.length > 0) upstreamSocket.write(head);

        if (typeof onSocketsReady === 'function') {
          onSocketsReady(socket, upstreamSocket);
        }

        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);

        trackWebSocketTokenUsage(upstreamSocket, {
          requestId,
          provider,
          path: sanitizeForLog(req.url),
          startTime,
          metrics,
          requestModel: requestModel || extractRequestModelFromUrl(req.url),
          onUsage: (normalizedUsage, model) =>
            computeTokenBudgetUsage({ logRequest, requestId, provider }, normalizedUsage, model),
        });

        socket.once('close', () => {
          finalize(false);
          upstreamSocket.destroy();
        });
        upstreamSocket.once('close', () => {
          finalize(false);
          socket.destroy();
        });
        socket.on('error', () => socket.destroy());
        upstreamSocket.on('error', () => upstreamSocket.destroy());
      };

      if (!isHttps) {
        // Explicit http:// target — the tunnelled connection is already
        // plaintext (the runner-side allowlist only opens port 80 for it),
        // so skip the TLS handshake entirely.
        sendUpgrade(tunnel);
        return;
      }

      const tlsSocket = tls.connect({ socket: tunnel, servername: targetHost, rejectUnauthorized: true });
      const onTlsError = (err) => abort(`TLS handshake error: ${err.message}`, tunnel);
      tlsSocket.once('error', onTlsError);

      tlsSocket.once('secureConnect', () => {
        tlsSocket.removeListener('error', onTlsError);
        sendUpgrade(tlsSocket);
      });
    });

    connectReq.end();
  };
}

module.exports = {
  createWebSocketTunnel,
  extractRequestModelFromUrl,
};
