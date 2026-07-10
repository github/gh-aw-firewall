'use strict';

const http = require('http');

function createHealthCheckHandler(adapter) {
  return (_req, res) => {
    if (adapter.isEnabled()) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', service: `awf-api-proxy-${adapter.name}` }));
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

    proxyRequest(
      req, res,
      adapter.getTargetHost(req),
      adapter.getAuthHeaders(req),
      adapter.name,
      adapter.getBasePath(req),
      adapter.getBodyTransform()
    );
  };
}

function createWebSocketUpgradeHandler(adapter, proxyWebSocket) {
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
    if (!adapter.isEnabled()) {
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
  } = deps;

  const handleHealthCheck = createHealthCheckHandler(adapter);
  const handleProxy = createProxyHandler(adapter, checkRateLimit, proxyRequest);
  const handleUpgrade = createWebSocketUpgradeHandler(adapter, proxyWebSocket);

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

    if (!adapter.isEnabled()) {
      const response = adapter.getUnconfiguredResponse
        ? adapter.getUnconfiguredResponse()
        : { statusCode: 503, body: { error: `${adapter.name} proxy not configured` } };
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body));
      return;
    }

    handleProxy(req, res);
  });

  server.on('upgrade', handleUpgrade);
  server.shutdownConnections = () => handleUpgrade.shutdownConnections();

  return server;
}

module.exports = {
  createHealthCheckHandler,
  createProxyHandler,
  createWebSocketUpgradeHandler,
  createProviderServer,
};
