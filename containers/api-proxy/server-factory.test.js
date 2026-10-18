'use strict';

const { EventEmitter } = require('events');
const { createProviderServer, createHealthCheckHandler } = require('./server-factory');
const { createRoutingObservation } = require('./routing-observation');
const { makeProviderNotConfiguredResponse } = require('./proxy-utils');

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
  test('advertises model-budget enforcement to budgeted service healthchecks', () => {
    const response = { writeHead: jest.fn(), end: jest.fn() };
    createHealthCheckHandler({
      name: 'copilot',
      isEnabled: () => true,
    }, true)({}, response);

    expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({
      status: 'healthy',
      service: 'awf-api-proxy-copilot',
      model_budget_enforcement: true,
    });
  });

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

  test('rejects WebSocket upgrades when invocation-scoped model budgets are enabled', () => {
    const clientSocket = makeTrackedSocket();
    const proxyWebSocket = jest.fn();
    const server = createProviderServer({
      name: 'copilot',
      isEnabled: () => true,
      getTargetHost: () => 'api.githubcopilot.com',
      getAuthHeaders: () => ({}),
      getBasePath: () => '',
    }, {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest: jest.fn(),
      proxyWebSocket,
      modelBudgetEnabled: true,
    });

    server.emit('upgrade', { url: '/v1/realtime', headers: {} }, clientSocket, Buffer.alloc(0));

    expect(proxyWebSocket).not.toHaveBeenCalled();
    expect(clientSocket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
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

  test('observes a routed request without rejecting it', () => {
    const proxyRequest = jest.fn();
    const routing = { observeRequest: jest.fn() };
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

    expect(routing.observeRequest).toHaveBeenCalledWith(req, {}, expect.objectContaining({ name: 'copilot' }));
    expect(proxyRequest).toHaveBeenCalledWith(
      req, {}, 'api.githubcopilot.com', {}, 'copilot', '', 'adapter-transform', null, 'https',
    );
  });

  test('composes the observe-only routing transform with the adapter transform', async () => {
    const proxyRequest = jest.fn();
    const observed = [];
    const adapterBody = Buffer.from('adapter');
    const adapter = routedAdapter();
    adapter.getBodyTransform = () => () => adapterBody;
    const routing = {
      observeRequest: jest.fn((req) => {
        req.awfRouting = { bodyTransform: body => { observed.push(body.toString()); return null; } };
      }),
    };
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

    const bodyTransform = proxyRequest.mock.calls[0][6];
    expect(await bodyTransform(Buffer.from('original'))).toBe(adapterBody);
    expect(observed).toEqual(['original']);
  });

  test('returns the routing request ID when a provider is not configured', () => {
    const adapter = {
      ...routedAdapter(),
      isEnabled: () => false,
    };
    const routing = createRoutingObservation({
      getSelection: () => ({
        provider: 'copilot',
        choice: { effort: 'low' },
        wire_model: 'gpt-test',
      }),
      recordFailure: jest.fn(),
      generateRequestId: () => 'generated-request-123',
    });
    const response = new EventEmitter();
    response.statusCode = 200;
    response.writableFinished = false;
    response.write = jest.fn(() => true);
    response.writeHead = jest.fn(function(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    });
    const end = jest.fn(function() {
      this.writableFinished = true;
      this.emit('finish');
    });
    response.end = end;
    const server = createProviderServer(adapter, {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: jest.fn(),
      proxyRequest: jest.fn(),
      proxyWebSocket: jest.fn(),
      routing,
    });
    const req = new EventEmitter();
    req.url = '/responses';
    req.method = 'POST';
    req.headers = { 'x-request-id': 'invalid request ID' };

    server.emit('request', req, response);

    expect(response.writeHead).toHaveBeenCalledWith(503, {
      'Content-Type': 'application/json',
      'X-Request-ID': 'generated-request-123',
    });
    expect(end).toHaveBeenCalled();
  });

  describe('provider_not_configured request records', () => {
    function runUnconfigured({ adapterName, selectionProvider, response }) {
      const records = [];
      const failures = [];
      const routing = createRoutingObservation({
        getSelection: () => ({
          provider: selectionProvider,
          choice: { effort: 'low' },
          wire_model: 'gpt-test',
        }),
        recordFailure: code => failures.push(code),
        observer: { record: record => records.push(record) },
        generateRequestId: () => 'generated-request-123',
      });
      const chunks = [];
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableFinished = false;
      res.write = jest.fn(chunk => { chunks.push(Buffer.from(chunk)); return true; });
      res.writeHead = jest.fn(function(statusCode) { this.statusCode = statusCode; });
      res.end = jest.fn(function(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        this.writableFinished = true;
        this.emit('finish');
      });
      const server = createProviderServer({
        ...routedAdapter(),
        name: adapterName,
        isEnabled: () => false,
        getUnconfiguredResponse: () => response,
      }, {
        handleManagementEndpoint: () => false,
        reflectEndpoints: () => [],
        checkRateLimit: jest.fn(),
        proxyRequest: jest.fn(),
        proxyWebSocket: jest.fn(),
        routing,
      });
      const req = new EventEmitter();
      req.url = '/responses';
      req.method = 'POST';
      req.headers = {};
      server.emit('request', req, res);
      return { records, failures, res, body: Buffer.concat(chunks).toString('utf8') };
    }

    test.each([
      ['missing credential (403)', 'copilot', 'copilot', makeProviderNotConfiguredResponse('copilot', 10002, 'missing token')],
      ['credential temporarily unavailable (503)', 'copilot', 'copilot',
        makeProviderNotConfiguredResponse('copilot', 10002, 'token not ready', { retryable: true })],
      ['missing credential on a deviating request (403)', 'anthropic', 'copilot',
        makeProviderNotConfiguredResponse('anthropic', 10001, 'missing key')],
    ])('records %s as an AWF-originated error', (_label, adapterName, selectionProvider, response) => {
      const { records, failures, res, body } = runUnconfigured({ adapterName, selectionProvider, response });

      expect(res.writeHead).toHaveBeenCalledWith(response.statusCode, {
        'Content-Type': 'application/json',
        'X-Request-ID': 'generated-request-123',
      });
      expect(body).toBe(JSON.stringify(response.body));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        request_id: 'generated-request-123',
        provider: adapterName,
        routed: adapterName === selectionProvider ? 'unobserved' : 'deviated',
        outcome: 'failed',
        status: response.statusCode,
        error_type: 'provider_not_configured',
        error_source: 'awf',
      });
      expect(records[0]).not.toHaveProperty('error_code');
      expect(JSON.stringify(records[0])).not.toContain(response.body.error.message);
      expect(failures).toEqual([]);
    });
  });

  test('parses x-awf-caller at ingress before routing observation, separately from the trusted context', () => {
    const proxyRequest = jest.fn();
    const seen = [];
    const routing = { observeRequest: jest.fn(req => seen.push(req.awfCaller)) };
    const server = createProviderServer(routedAdapter(), {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest,
      proxyWebSocket: jest.fn(),
      routing,
    });
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (const value of ['subagent/file-summarizer', undefined, 'subagent/secret value']) {
        const req = new EventEmitter();
        req.url = '/v1/chat/completions';
        req.method = 'POST';
        req.headers = value === undefined ? {} : { 'x-awf-caller': value };
        server.emit('request', req, {});
        expect(req.awfRequestContext).toBeUndefined();
      }
      const logged = stdout.mock.calls.map(([line]) => String(line)).join('');
      expect(logged).toContain('caller_header_rejected');
      expect(logged).toContain('invalid_format');
      expect(logged).not.toContain('secret value');
    } finally {
      stdout.mockRestore();
    }
    expect(seen).toEqual([
      { purpose: 'subagent', agent_name: 'file-summarizer', caller_source: 'caller_header' },
      null,
      null,
    ]);
  });

  test('parses x-awf-caller on WebSocket upgrades', () => {
    const proxyWebSocket = jest.fn();
    const server = createProviderServer(routedAdapter(), {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest: jest.fn(),
      proxyWebSocket,
    });
    const req = { url: '/v1/realtime', headers: { 'x-awf-caller': 'main' } };
    server.emit('upgrade', req, makeTrackedSocket(), Buffer.alloc(0));
    expect(proxyWebSocket.mock.calls[0][0].awfCaller).toEqual({ purpose: 'agent', caller_source: 'caller_header' });
  });

  test('proxies an upgrade while routing is active', () => {
    const proxyWebSocket = jest.fn();
    const routing = { observeRequest: jest.fn() };
    const server = createProviderServer(routedAdapter(), {
      handleManagementEndpoint: () => false,
      reflectEndpoints: () => [],
      checkRateLimit: () => false,
      proxyRequest: jest.fn(),
      proxyWebSocket,
      routing,
    });
    const socket = makeTrackedSocket();
    const req = { url: '/v1/realtime', headers: {} };
    const head = Buffer.alloc(0);

    server.emit('upgrade', req, socket, head);

    expect(proxyWebSocket).toHaveBeenCalled();
    expect(proxyWebSocket.mock.calls[0][0]).toBe(req);
  });
});
