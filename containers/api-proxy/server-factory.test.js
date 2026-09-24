'use strict';

const { EventEmitter } = require('events');
const { createProviderServer } = require('./server-factory');

function makeTrackedSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = jest.fn(() => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    socket.emit('close');
  });
  socket.write = jest.fn();
  return socket;
}

describe('createProviderServer', () => {
  test('passes the adapter request signer to the HTTP proxy pipeline', () => {
    const requestSigner = jest.fn();
    const proxyRequest = jest.fn();
    const adapter = {
      name: 'openai',
      isManagementPort: false,
      isEnabled: () => true,
      getTargetHost: () => 'bedrock-runtime.us-east-1.amazonaws.com',
      getAuthHeaders: () => ({}),
      getBasePath: () => '',
      getBodyTransform: () => null,
      getRequestSigner: () => requestSigner,
    };
    const server = createProviderServer(adapter, {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest,
      proxyWebSocket: jest.fn(),
    });
    const req = new EventEmitter();
    req.url = '/model/test/invoke';
    req.method = 'POST';
    req.headers = {};
    const res = {};

    server.emit('request', req, res);

    expect(proxyRequest).toHaveBeenCalledWith(
      req,
      res,
      'bedrock-runtime.us-east-1.amazonaws.com',
      {},
      'openai',
      '',
      null,
      requestSigner,
      'https',
    );
  });

  test('fails closed for WebSocket upgrades when AWS request signing is configured', () => {
    const clientSocket = makeTrackedSocket();
    const proxyWebSocket = jest.fn();
    const server = createProviderServer({
      name: 'copilot',
      isEnabled: () => true,
      getTargetHost: () => 'bedrock-runtime.us-east-1.amazonaws.com',
      getAuthHeaders: () => ({}),
      getBasePath: () => '',
      getRequestSigner: () => jest.fn(),
    }, {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest: jest.fn(),
      proxyWebSocket,
    });

    server.emit('upgrade', { url: '/', headers: {} }, clientSocket, Buffer.alloc(0));

    expect(proxyWebSocket).not.toHaveBeenCalled();
    expect(clientSocket.write).toHaveBeenCalledWith(expect.stringContaining('503 Service Unavailable'));
    expect(clientSocket.destroy).toHaveBeenCalled();
  });

  test('shutdownConnections closes tracked upgraded sockets', async () => {
    const clientSocket = makeTrackedSocket();
    const upstreamSocket = makeTrackedSocket();
    const proxyWebSocket = jest.fn((_req, socket, _head, _targetHost, _headers, _provider, _basePath, lifecycleHooks) => {
      lifecycleHooks.onSocketsReady(socket, upstreamSocket);
    });

    const server = createProviderServer({
      name: 'anthropic',
      isEnabled: () => true,
      getTargetHost: () => 'api.anthropic.com',
      getAuthHeaders: () => ({}),
      getBasePath: () => '',
    }, {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest: jest.fn(),
      proxyWebSocket,
    });

    server.emit('upgrade', { url: '/v1/messages', headers: {} }, clientSocket, Buffer.alloc(0));

    await server.shutdownConnections();

    expect(proxyWebSocket).toHaveBeenCalledTimes(1);
    expect(clientSocket.destroy).toHaveBeenCalledTimes(1);
    expect(upstreamSocket.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('createProviderServer routing enforcement', () => {
  function routedAdapter() {
    return {
      name: 'copilot',
      isManagementPort: false,
      isEnabled: () => true,
      getTargetHost: () => 'api.githubcopilot.com',
      getAuthHeaders: () => ({}),
      getBasePath: () => '',
      getBodyTransform: () => 'adapter-transform',
    };
  }

  test('screens an inference request before revealing adapter configuration', () => {
    const proxyRequest = jest.fn();
    const routing = {
      screenRequest: jest.fn(() => true),
      rejectUpgrade: jest.fn(),
    };
    const adapter = routedAdapter();
    adapter.isEnabled = () => false;
    adapter.getUnconfiguredResponse = jest.fn();
    const server = createProviderServer(adapter, {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest,
      proxyWebSocket: jest.fn(),
      routing,
    });
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = {};

    server.emit('request', req, {});

    expect(routing.screenRequest).toHaveBeenCalled();
    expect(adapter.getUnconfiguredResponse).not.toHaveBeenCalled();
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  test('uses the enforcement body transform for an admitted routed request', () => {
    const proxyRequest = jest.fn();
    const bodyTransform = jest.fn();
    const routing = {
      screenRequest: jest.fn((req) => {
        req.awfRouting = { bodyTransform };
        return false;
      }),
      rejectUpgrade: jest.fn(),
    };
    const server = createProviderServer(routedAdapter(), {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest,
      proxyWebSocket: jest.fn(),
      routing,
    });
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = {};

    server.emit('request', req, {});

    expect(proxyRequest).toHaveBeenCalledWith(
      req, {}, 'api.githubcopilot.com', {}, 'copilot', '', bodyTransform, null, 'https',
    );
  });

  test('rejects an upgrade while routing is active', () => {
    const proxyWebSocket = jest.fn();
    const routing = {
      screenRequest: jest.fn(() => false),
      rejectUpgrade: jest.fn(),
    };
    const server = createProviderServer(routedAdapter(), {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest: jest.fn(),
      proxyWebSocket,
      routing,
    });
    const socket = makeTrackedSocket();

    server.emit('upgrade', { url: '/v1/realtime', headers: {} }, socket, Buffer.alloc(0));

    expect(routing.rejectUpgrade).toHaveBeenCalledWith(socket);
    expect(proxyWebSocket).not.toHaveBeenCalled();
  });
});
