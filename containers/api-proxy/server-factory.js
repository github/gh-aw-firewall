'use strict';

const http = require('http');
const { composeBodyTransforms } = require('./proxy-utils');
const { logRequest } = require('./logging');
const { CALLER_HEADER, callerHeaderRejection, parseCallerHeader } = require('./caller-header');

/**
 * Parse the optional x-awf-caller header once at ingress and attach it as
 * req.awfCaller. The caller is untrusted attribution metadata and is kept
 * separate from the trusted req.awfRequestContext. An invalid value is
 * ignored as if absent and never logged; only the rejection reason is.
 */
function attachCaller(req, adapter) {
  const value = req.headers?.[CALLER_HEADER];
  const reason = callerHeaderRejection(value);
  if (reason) {
    logRequest('warn', 'caller_header_rejected', { provider: adapter.name, reason });
  }
  req.awfCaller = parseCallerHeader(value);
}

function createHealthCheckHandler(adapter, modelBudgetEnabled = false) {
  return (_req, res) => {
    if (adapter.isEnabled()) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: `awf-api-proxy-${adapter.name}`,
        ...(modelBudgetEnabled ? { model_budget_enforcement: true } : {}),
      }));
    } else if (adapter.getUnconfiguredHealthResponse) {
      const { statusCode, body } = adapter.getUnconfiguredHealthResponse();
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_configured', service: `awf-api-proxy-${adapter.name}` }));
    }
  };
}

function createProxyHandler(adapter, checkRateLimit, proxyRequest) {
  return (req, res) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (checkRateLimit(req, res, adapter.name, contentLength)) return;

    if (adapter.transformRequestUrl) {
      req.url = adapter.transformRequestUrl(req.url);
    }

    // A routed request carries an observe-only transform that records deviation
    // telemetry and returns null, so the adapter's own transform still applies.
    const bodyTransform = req.awfRouting
      ? composeBodyTransforms(req.awfRouting.bodyTransform, adapter.getBodyTransform())
      : adapter.getBodyTransform();

    proxyRequest(
      req, res,
      adapter.getTargetHost(req),
      adapter.getAuthHeaders(req),
      adapter.name,
      adapter.getBasePath(req),
      bodyTransform,
      adapter.getRequestSigner ? adapter.getRequestSigner() : null,
      adapter.getTargetScheme ? adapter.getTargetScheme(req) : 'https'
    );
  };
}

function createWebSocketUpgradeHandler(adapter, proxyWebSocket, { modelBudgetEnabled = false } = {}) {
  const activeUpgradeSockets = new Set();

  function trackUpgradeSocket(socket) {
    if (!socket || typeof socket.destroy !== 'function') return;
    activeUpgradeSockets.add(socket);
    const cleanup = () => activeUpgradeSockets.delete(socket);
    if (typeof socket.once === 'function') {
      socket.once('close', cleanup);
      socket.once('end', cleanup);
    }
  }

  async function shutdownConnections() {
    const sockets = Array.from(activeUpgradeSockets);
    await Promise.all(sockets.map((socket) => new Promise((resolve) => {
      if (!activeUpgradeSockets.has(socket)) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        activeUpgradeSockets.delete(socket);
        resolve();
      };
      if (typeof socket.once === 'function') {
        socket.once('close', finish);
      }
      try {
        if (socket.destroyed) {
          finish();
          return;
        }
        socket.destroy();
      } catch {
        finish();
      }
    })));
  }

  const handler = (req, socket, head) => {
    if (modelBudgetEnabled) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!adapter.isEnabled()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Bedrock SigV4 is implemented for buffered HTTP requests. Never allow an
    // unsigned WebSocket upgrade to escape through an AWS-authenticated adapter.
    if (adapter.getRequestSigner?.()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (adapter.transformRequestUrl) {
      req.url = adapter.transformRequestUrl(req.url);
    }

    proxyWebSocket(
      req, socket, head,
      adapter.getTargetHost(req),
      adapter.getAuthHeaders(req),
      adapter.name,
      adapter.getBasePath(req),
      {
        onSocketsReady: (clientSocket, upstreamSocket) => {
          trackUpgradeSocket(clientSocket);
          trackUpgradeSocket(upstreamSocket);
        },
        targetScheme: adapter.getTargetScheme ? adapter.getTargetScheme(req) : 'https',
      }
    );
  };
  handler.shutdownConnections = shutdownConnections;
  return handler;
}

function createProviderServer(adapter, deps) {
  const {
    handleManagementEndpoint,
    reflectEndpoints,
    checkRateLimit,
    proxyRequest,
    proxyWebSocket,
    routing,
    modelBudgetEnabled = false,
  } = deps;

  const handleHealthCheck = createHealthCheckHandler(adapter, modelBudgetEnabled);
  const handleProxy = createProxyHandler(adapter, checkRateLimit, proxyRequest);
  const handleUpgrade = createWebSocketUpgradeHandler(adapter, proxyWebSocket, { modelBudgetEnabled });

  const server = http.createServer((req, res) => {
    if (adapter.isManagementPort && handleManagementEndpoint(req, res)) return;

    if (req.url === '/health' && req.method === 'GET') {
      handleHealthCheck(req, res);
      return;
    }

    if (req.url === '/reflect' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reflectEndpoints()));
      return;
    }

    attachCaller(req, adapter);

    // The routing selection is advisory: this never rejects. It may attach
    // req.awfRouting, which records deviation telemetry and observes upstream failures.
    routing?.observeRequest(req, res, adapter);

    if (!adapter.isEnabled()) {
      const response = adapter.getUnconfiguredResponse
        ? adapter.getUnconfiguredResponse()
        : { statusCode: 503, body: { error: `${adapter.name} proxy not configured` } };
      const localError = response.body?.error;
      if (req.awfRouting && localError && typeof localError === 'object') {
        req.awfRouting.localError = { code: localError.code, type: localError.type };
      }
      res.writeHead(response.statusCode, {
        'Content-Type': 'application/json',
        ...(req.awfRouting?.requestId ? { 'X-Request-ID': req.awfRouting.requestId } : {}),
      });
      res.end(JSON.stringify(response.body));
      return;
    }

    handleProxy(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    attachCaller(req, adapter);
    handleUpgrade(req, socket, head);
  });
  server.shutdownConnections = () => handleUpgrade.shutdownConnections();

  return server;
}

module.exports = {
  createHealthCheckHandler,
  createProxyHandler,
  createWebSocketUpgradeHandler,
  createProviderServer,
};
