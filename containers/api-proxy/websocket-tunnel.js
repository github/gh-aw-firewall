'use strict';

const http = require('http');
const tls = require('tls');
const { URL } = require('url');
const { computeTokenBudgetUsage } = require('./token-budget-log');

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
    injectHeaders,
    provider,
    requestId,
    startTime,
    upstreamPath,
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

    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
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
        forwardHeaders.host = targetHost;

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
          onUsage: (normalizedUsage, model) =>
            computeTokenBudgetUsage({ logRequest, requestId, provider }, normalizedUsage, model),
        });

        socket.once('close', () => {
          finalize(false);
          tlsSocket.destroy();
        });
        tlsSocket.once('close', () => {
          finalize(false);
          socket.destroy();
        });
        socket.on('error', () => socket.destroy());
        tlsSocket.on('error', () => tlsSocket.destroy());
      });
    });

    connectReq.end();
  };
}

module.exports = {
  createWebSocketTunnel,
};
