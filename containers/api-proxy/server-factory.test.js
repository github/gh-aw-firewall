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
