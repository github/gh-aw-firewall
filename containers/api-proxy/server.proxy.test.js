/**
 * Tests for proxy behavior: proxyWebSocket, CONNECT tunnel, auth injection,
 * request validation, and proxyRequest X-Initiator injection.
 *
 * Extracted from server.test.js lines 586–884, 2796–2894.
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { EventEmitter } = require('events');
let resetEffectiveTokenGuardForTests;
let resetMaxRunsGuardForTests;
let resetTimeoutSteeringForTests;
let resetAnthropicDeprecatedBetaHeadersForTests;

const originalHttpsProxy = process.env.HTTPS_PROXY;
let proxyRequest;
let proxyWebSocket;
let healthResponse;

beforeAll(() => {
  delete process.env.HTTPS_PROXY;
  jest.resetModules();
  ({ proxyRequest, proxyWebSocket, healthResponse } = require('./server'));
  ({
    resetEffectiveTokenGuardForTests,
    resetMaxRunsGuardForTests,
    resetTimeoutSteeringForTests,
    resetAnthropicDeprecatedBetaHeadersForTests,
  } = require('./proxy-request'));
});

beforeEach(() => {
  resetAnthropicDeprecatedBetaHeadersForTests();
});

afterAll(() => {
  if (originalHttpsProxy === undefined) {
    delete process.env.HTTPS_PROXY;
  } else {
    process.env.HTTPS_PROXY = originalHttpsProxy;
  }
  jest.resetModules();
});

// ── Helpers for proxyWebSocket tests ──────────────────────────────────────────

/** Create a minimal mock socket with write/destroy spies. */
function makeMockSocket() {
  const s = new EventEmitter();
  s.write = jest.fn();
  s.destroy = jest.fn();
  s.pipe = jest.fn();
  s.writable = true;
  s.destroyed = false;
  return s;
}

/** Create a mock HTTP request for a WebSocket upgrade. */
function makeUpgradeReq(overrides = {}) {
  return {
    url: '/v1/responses',
    headers: {
      'upgrade': 'websocket',
      'connection': 'Upgrade',
      'sec-websocket-key': 'test-ws-key==',
      'sec-websocket-version': '13',
      'host': '172.30.0.30',
      ...overrides.headers,
    },
    ...overrides,
  };
}

describe('proxyWebSocket', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Request validation ─────────────────────────────────────────────────────

  describe('request validation', () => {
    it('rejects a non-WebSocket upgrade (e.g. h2c) with 400', () => {
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq({ headers: { 'upgrade': 'h2c' } }), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('rejects an upgrade with no Upgrade header with 400', () => {
      const socket = makeMockSocket();
      const req = makeUpgradeReq();
      delete req.headers['upgrade'];
      proxyWebSocket(req, socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('rejects an absolute URL with 400 (SSRF prevention)', () => {
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq({ url: 'https://evil.com/v1/responses' }), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('rejects a protocol-relative URL with 400 (SSRF prevention)', () => {
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq({ url: '//evil.com/v1/responses' }), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('rejects a null URL with 400', () => {
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq({ url: null }), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });
  });

  // ── Proxy config errors ────────────────────────────────────────────────────

  describe('proxy configuration errors', () => {
    it('returns 502 when HTTPS_PROXY is not configured', () => {
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
      expect(socket.destroy).toHaveBeenCalled();
    });
  });

  // ── Network tunnel tests (module loaded with HTTPS_PROXY set) ─────────────

  describe('CONNECT tunnel and auth injection', () => {
    let wsProxy;

    beforeAll(() => {
      // Re-require server with HTTPS_PROXY so proxyWebSocket uses the proxy URL.
      process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
      jest.resetModules();
      wsProxy = require('./server').proxyWebSocket;
    });

    afterAll(() => {
      delete process.env.HTTPS_PROXY;
      jest.resetModules();
    });

    it('returns 502 when the CONNECT response is not 200', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      setImmediate(() => connectReq.emit('connect', { statusCode: 407 }, tunnel));

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer key' }, 'openai');

      return new Promise(resolve => setImmediate(() => {
        expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
        expect(socket.destroy).toHaveBeenCalled();
        expect(tunnel.destroy).toHaveBeenCalled();
        resolve();
      }));
    });

    it('returns 502 when the CONNECT request emits an error', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      setImmediate(() => connectReq.emit('error', new Error('connection refused')));

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer key' }, 'openai');

      return new Promise(resolve => setImmediate(() => {
        expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
        expect(socket.destroy).toHaveBeenCalled();
        resolve();
      }));
    });

    it('returns 502 when TLS handshake fails', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();
      const tlsSocket = new EventEmitter();
      tlsSocket.write = jest.fn();
      tlsSocket.destroy = jest.fn();
      tlsSocket.pipe = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('error', new Error('certificate unknown')));
      });

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer key' }, 'openai');

      return new Promise(resolve => setTimeout(() => {
        expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
        expect(socket.destroy).toHaveBeenCalled();
        resolve();
      }, 30));
    });

    it('injects Authorization header and fixes Host header in the upgrade request', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();
      const tlsSocket = new EventEmitter();
      tlsSocket.write = jest.fn();
      tlsSocket.destroy = jest.fn();
      tlsSocket.pipe = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('secureConnect'));
      });

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer secret' }, 'openai');

      return new Promise(resolve => setTimeout(() => {
        const upgradeWrite = tlsSocket.write.mock.calls.find(
          c => typeof c[0] === 'string' && c[0].startsWith('GET ')
        );
        expect(upgradeWrite).toBeDefined();
        const upgradeReqStr = upgradeWrite[0];
        expect(upgradeReqStr).toContain('Authorization: Bearer secret');
        expect(upgradeReqStr).toContain('host: api.openai.com');
        expect(tlsSocket.pipe).toHaveBeenCalledWith(socket);
        expect(socket.pipe).toHaveBeenCalledWith(tlsSocket);
        resolve();
      }, 30));
    });

    it('strips client-supplied auth headers before forwarding', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();
      const tlsSocket = new EventEmitter();
      tlsSocket.write = jest.fn();
      tlsSocket.destroy = jest.fn();
      tlsSocket.pipe = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('secureConnect'));
      });

      const req = makeUpgradeReq({
        headers: {
          'upgrade': 'websocket',
          'authorization': 'Bearer client-supplied',  // must be stripped
          'x-api-key': 'client-api-key',              // must be stripped
          'sec-websocket-key': 'ws-key==',
          'sec-websocket-version': '13',
        },
      });

      wsProxy(req, socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer injected' }, 'openai');

      return new Promise(resolve => setTimeout(() => {
        const upgradeWrite = tlsSocket.write.mock.calls.find(
          c => typeof c[0] === 'string' && c[0].startsWith('GET ')
        );
        expect(upgradeWrite).toBeDefined();
        const upgradeReqStr = upgradeWrite[0];
        expect(upgradeReqStr).not.toContain('client-supplied');
        expect(upgradeReqStr).not.toContain('client-api-key');
        expect(upgradeReqStr).toContain('Bearer injected');
        resolve();
      }, 30));
    });

    it('forwards the CONNECT request to the configured Squid proxy host/port', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();

      let capturedOptions;
      jest.spyOn(http, 'request').mockImplementation((options) => {
        capturedOptions = options;
        return connectReq;
      });

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');

      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.method).toBe('CONNECT');
      expect(capturedOptions.path).toBe('api.openai.com:443');
      expect(capturedOptions.host).toBe('127.0.0.1');
      expect(capturedOptions.port).toBe(3128);
    });

    it('forwards buffered head bytes to the upstream after upgrade', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();
      const tlsSocket = new EventEmitter();
      tlsSocket.write = jest.fn();
      tlsSocket.destroy = jest.fn();
      tlsSocket.pipe = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('secureConnect'));
      });

      const headBytes = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]); // WS text frame: FIN=1, opcode=1, len=5, payload='Hello'
      wsProxy(makeUpgradeReq(), socket, headBytes, 'api.openai.com', { 'Authorization': 'Bearer k' }, 'openai');

      return new Promise(resolve => setTimeout(() => {
        const bufWrite = tlsSocket.write.mock.calls.find(c => Buffer.isBuffer(c[0]));
        expect(bufWrite).toBeDefined();
        expect(bufWrite[0]).toEqual(headBytes);
        resolve();
      }, 30));
    });
  });
});

describe('proxyRequest X-Initiator injection', () => {
  /** Minimal mock for http.IncomingMessage backed by EventEmitter. */
  function makeReq(headers = {}) {
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', ...headers };
    return req;
  }

  /** Minimal mock for http.ServerResponse. */
  function makeRes() {
    return {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn(),
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Mock https.request to capture the outgoing options (including headers)
   * without making a real network connection.
   */
  function mockHttpsRequest() {
    let capturedOptions;
    let capturedProxyReq;
    jest.spyOn(https, 'request').mockImplementation((options) => {
      capturedOptions = options;
      const proxyReq = new EventEmitter();
      proxyReq.end = jest.fn();
      proxyReq.write = jest.fn();
      proxyReq.destroy = jest.fn();
      capturedProxyReq = proxyReq;
      return proxyReq;
    });
    return {
      getCaptured: () => capturedOptions,
      getWrittenBody: () => capturedProxyReq?.write?.mock?.calls?.[0]?.[0],
    };
  }

  it('injects x-initiator: agent when absent on direct copilot requests', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('end');
    expect(getCaptured().headers['x-initiator']).toBe('agent');
  });

  it('injects x-initiator: agent when absent on enterprise githubcopilot.com target', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.enterprise.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('end');
    expect(getCaptured().headers['x-initiator']).toBe('agent');
  });

  it('preserves a client-supplied x-initiator value on copilot requests', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq({ 'x-initiator': 'user' });
    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('end');
    expect(getCaptured().headers['x-initiator']).toBe('user');
  });

  it('does not inject x-initiator for non-copilot provider targets', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    expect(getCaptured().headers['x-initiator']).toBeUndefined();
  });

  it('normalizes null tool_calls[].type to function before forwarding', () => {
    const { getWrittenBody } = mockHttpsRequest();
    const req = makeReq();

    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-5.4',
      messages: [{
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          type: null,
          function: { name: 'edit', arguments: '{"file":"x.ts"}' },
        }],
      }],
    })));
    req.emit('end');

    const forwarded = JSON.parse(getWrittenBody().toString('utf8'));
    expect(forwarded.messages[0].tool_calls[0].type).toBe('function');
  });

  it('drops malformed tool calls with null type and no function payload', () => {
    const { getWrittenBody } = mockHttpsRequest();
    const req = makeReq();

    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-5.4',
      messages: [{
        role: 'assistant',
        tool_calls: [
          { id: 'call_ok', type: null, function: { name: 'edit', arguments: '{}' } },
          { id: 'call_bad', type: null },
        ],
      }],
    })));
    req.emit('end');

    const forwarded = JSON.parse(getWrittenBody().toString('utf8'));
    expect(forwarded.messages[0].tool_calls).toEqual([
      { id: 'call_ok', type: 'function', function: { name: 'edit', arguments: '{}' } },
    ]);
  });
});

describe('proxyRequest anthropic deprecated beta handling', () => {
  function makeReq(headers = {}) {
    const req = new EventEmitter();
    req.url = '/v1/messages';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', ...headers };
    return req;
  }

  function makeRes() {
    const res = {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(() => {
        res.headersSent = true;
      }),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    return res;
  }

  function makeProxyReq() {
    const proxyReq = new EventEmitter();
    proxyReq.end = jest.fn();
    proxyReq.write = jest.fn();
    proxyReq.destroy = jest.fn();
    return proxyReq;
  }

  function makeProxyRes(statusCode, headers = { 'content-type': 'application/json' }) {
    const proxyRes = new EventEmitter();
    proxyRes.statusCode = statusCode;
    proxyRes.headers = headers;
    proxyRes.pipe = jest.fn();
    return proxyRes;
  }

  function getStructuredLogs(writeSpy, eventName) {
    return writeSpy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(entry => entry && entry.event === eventName);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries once after Anthropic rejects a deprecated anthropic-beta value', () => {
    const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07,other-beta' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].headers['anthropic-beta']).toBe('context-1m-2025-08-07,other-beta');

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      '400 Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['anthropic-beta']).toBe('other-beta');

    const secondResponse = makeProxyRes(200);
    responseHandlers[1](secondResponse);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'x-request-id': expect.any(String),
    }));
    secondResponse.emit('data', Buffer.from('{"ok":true}'));
    secondResponse.emit('end');

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'retry',
        header: 'anthropic-beta',
        removed_values: ['context-1m-2025-08-07'],
        remaining_values: ['other-beta'],
      }),
    ]));
  });

  it('proactively strips learned deprecated anthropic-beta values on later requests', () => {
    const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    const learnReq = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const learnRes = makeRes();
    proxyRequest(learnReq, learnRes, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    learnReq.emit('end');

    const rejection = makeProxyRes(400);
    responseHandlers[0](rejection);
    rejection.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header'
    ));
    rejection.emit('end');

    expect(capturedOptions[1].headers['anthropic-beta']).toBeUndefined();

    const retrySuccess = makeProxyRes(200);
    responseHandlers[1](retrySuccess);
    retrySuccess.emit('data', Buffer.from('{"ok":true}'));
    retrySuccess.emit('end');

    const nextReq = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const nextRes = makeRes();
    proxyRequest(nextReq, nextRes, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    nextReq.emit('end');

    expect(capturedOptions[2].headers['anthropic-beta']).toBeUndefined();

    const laterSuccess = makeProxyRes(200);
    responseHandlers[2](laterSuccess);
    laterSuccess.emit('data', Buffer.from('{"ok":true}'));
    laterSuccess.emit('end');

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'cached',
        header: 'anthropic-beta',
        removed_values: ['context-1m-2025-08-07'],
        remaining_values: [],
      }),
    ]));
  });

  it('retries after deprecated anthropic-beta rejection via copilot provider', () => {
    const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07,prompt-caching-2024-07-31' });
    const res = makeRes();
    proxyRequest(req, res, 'api.githubcopilot.com', { authorization: 'Bearer ghu_test' }, 'copilot');
    req.emit('end');

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].headers['anthropic-beta']).toBe('context-1m-2025-08-07,prompt-caching-2024-07-31');

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      '400 Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header. Please consult our documentation.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');

    const secondResponse = makeProxyRes(200);
    responseHandlers[1](secondResponse);
    secondResponse.emit('data', Buffer.from('{"ok":true}'));
    secondResponse.emit('end');

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'x-request-id': expect.any(String),
    }));

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'retry',
        provider: 'copilot',
        header: 'anthropic-beta',
        removed_values: ['context-1m-2025-08-07'],
        remaining_values: ['prompt-caching-2024-07-31'],
      }),
    ]));
  });

  it('proactively strips learned deprecated values for copilot provider requests', () => {
    const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    // First: learn via anthropic provider
    const learnReq = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const learnRes = makeRes();
    proxyRequest(learnReq, learnRes, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    learnReq.emit('end');

    const rejection = makeProxyRes(400);
    responseHandlers[0](rejection);
    rejection.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header'
    ));
    rejection.emit('end');

    const retrySuccess = makeProxyRes(200);
    responseHandlers[1](retrySuccess);
    retrySuccess.emit('data', Buffer.from('{"ok":true}'));
    retrySuccess.emit('end');

    // Second: copilot provider request should proactively strip the learned value
    const copilotReq = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07,prompt-caching-2024-07-31' });
    const copilotRes = makeRes();
    proxyRequest(copilotReq, copilotRes, 'api.githubcopilot.com', { authorization: 'Bearer ghu_test' }, 'copilot');
    copilotReq.emit('end');

    expect(capturedOptions[2].headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'cached',
        provider: 'copilot',
        header: 'anthropic-beta',
        removed_values: ['context-1m-2025-08-07'],
      }),
    ]));
  });

  it('handles deprecated values in arbitrary headers (not just anthropic-beta)', () => {
    const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    const req = makeReq({ 'x-custom-feature': 'old-feature-2024,new-feature-2025' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');

    expect(capturedOptions).toHaveLength(1);

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `old-feature-2024` for the `x-custom-feature` header. Please update.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['x-custom-feature']).toBe('new-feature-2025');

    const secondResponse = makeProxyRes(200);
    responseHandlers[1](secondResponse);
    secondResponse.emit('data', Buffer.from('{"ok":true}'));
    secondResponse.emit('end');

    // Subsequent request should proactively strip the learned value
    const nextReq = makeReq({ 'x-custom-feature': 'old-feature-2024,new-feature-2025' });
    const nextRes = makeRes();
    proxyRequest(nextReq, nextRes, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    nextReq.emit('end');

    expect(capturedOptions[2].headers['x-custom-feature']).toBe('new-feature-2025');

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'retry',
        header: 'x-custom-feature',
        removed_values: ['old-feature-2024'],
        remaining_values: ['new-feature-2025'],
      }),
      expect.objectContaining({
        mode: 'cached',
        header: 'x-custom-feature',
        removed_values: ['old-feature-2024'],
        remaining_values: ['new-feature-2025'],
      }),
    ]));
  });

  it('does not retry when 400 body does not match the deprecated header pattern', () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be less than 8192"}}'
    ));
    firstResponse.emit('end');

    // Should NOT retry — only 1 request made
    expect(capturedOptions).toHaveLength(1);
    // Should pass through the 400 to the client
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(res.end).toHaveBeenCalled();
  });

  it('does not retry more than once (retry itself returns 400)', () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    const req = makeReq({ 'anthropic-beta': 'bad-value-1,bad-value-2' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');

    // First 400 — triggers retry after stripping bad-value-1
    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `bad-value-1` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['anthropic-beta']).toBe('bad-value-2');

    // Second 400 on retry — should NOT trigger another retry (hasRetried=true)
    const secondResponse = makeProxyRes(400);
    responseHandlers[1](secondResponse);
    // Simulate streaming data through pipe
    secondResponse.emit('data', Buffer.from(
      'Unexpected value(s) `bad-value-2` for the `anthropic-beta` header.'
    ));
    secondResponse.emit('end');

    // Only 2 requests total — no infinite loop
    expect(capturedOptions).toHaveLength(2);
    // The second 400 is streamed back to the client via pipe
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
      'x-request-id': expect.any(String),
    }));
  });

  it('removes header entirely when all values are deprecated', () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    // Header should be completely removed since it was the only value
    expect(capturedOptions[1].headers['anthropic-beta']).toBeUndefined();

    const secondResponse = makeProxyRes(200);
    responseHandlers[1](secondResponse);
    secondResponse.emit('data', Buffer.from('{"ok":true}'));
    secondResponse.emit('end');

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });

  it('does not buffer 400 responses for non-anthropic/non-copilot providers', () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    req.url = '/v1/chat/completions';
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { authorization: 'Bearer sk-test' }, 'openai');
    req.emit('end');

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    // Even if the body matches, openai provider should NOT trigger retry
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    // Should NOT retry — only 1 request
    expect(capturedOptions).toHaveLength(1);
  });

  it('learns multiple deprecated values across separate requests', () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    // First request: learn that value-a is deprecated
    const req1 = makeReq({ 'anthropic-beta': 'value-a,value-b,value-c' });
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req1.emit('end');

    const rej1 = makeProxyRes(400);
    responseHandlers[0](rej1);
    rej1.emit('data', Buffer.from('Unexpected value(s) `value-a` for the `anthropic-beta` header'));
    rej1.emit('end');

    // Retry succeeds
    const ok1 = makeProxyRes(200);
    responseHandlers[1](ok1);
    ok1.emit('data', Buffer.from('{"ok":true}'));
    ok1.emit('end');

    // Second request: learn that value-b is also deprecated
    const req2 = makeReq({ 'anthropic-beta': 'value-a,value-b,value-c' });
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req2.emit('end');

    // value-a was proactively stripped, so only value-b,value-c sent
    expect(capturedOptions[2].headers['anthropic-beta']).toBe('value-b,value-c');

    const rej2 = makeProxyRes(400);
    responseHandlers[2](rej2);
    rej2.emit('data', Buffer.from('Unexpected value(s) `value-b` for the `anthropic-beta` header'));
    rej2.emit('end');

    // Retry with only value-c
    expect(capturedOptions[3].headers['anthropic-beta']).toBe('value-c');

    const ok2 = makeProxyRes(200);
    responseHandlers[3](ok2);
    ok2.emit('data', Buffer.from('{"ok":true}'));
    ok2.emit('end');

    // Third request: both value-a and value-b should be proactively stripped
    const req3 = makeReq({ 'anthropic-beta': 'value-a,value-b,value-c' });
    const res3 = makeRes();
    proxyRequest(req3, res3, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req3.emit('end');

    expect(capturedOptions[4].headers['anthropic-beta']).toBe('value-c');
  });

  it('handles whitespace in comma-separated header values', () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const responseHandlers = [];
    const capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });

    // Header with spaces around commas
    const req = makeReq({ 'anthropic-beta': ' context-1m-2025-08-07 , prompt-caching-2024-07-31 ' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });
});

describe('proxyRequest error handling', () => {
  function makeReq(headers = {}) {
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', ...headers };
    return req;
  }

  function makeRes() {
    const res = {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(() => {
        res.headersSent = true;
      }),
      end: jest.fn(),
      destroy: jest.fn(),
    };
    return res;
  }

  function getRequestErrorLog(writeSpy) {
    for (const [line] of writeSpy.mock.calls) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.event === 'request_error') return parsed;
      } catch {
        // ignore non-JSON writes
      }
    }
    return null;
  }

  let stdoutWriteSpy;

  beforeEach(() => {
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 400 when the client request stream errors', () => {
    const before = healthResponse().metrics_summary;
    const req = makeReq();
    const res = makeRes();

    proxyRequest(req, res, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req.emit('error', new Error('client stream failed\ninjected'));

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      error: 'Client error',
      message: 'client stream failed\ninjected',
    });
    const after = healthResponse().metrics_summary;
    expect(after.total_errors).toBe(before.total_errors + 1);
    expect(after.active_requests).toBe(before.active_requests);
    const errorLog = getRequestErrorLog(stdoutWriteSpy);
    expect(errorLog).toMatchObject({
      event: 'request_error',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      error: 'client stream failedinjected',
      upstream_host: 'api.openai.com',
    });
  });

  it('destroys response when upstream response stream errors after headers are sent', () => {
    const before = healthResponse().metrics_summary;
    let responseHandler;
    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    jest.spyOn(https, 'request').mockImplementation((_options, cb) => {
      responseHandler = cb;
      return upstreamRequest;
    });

    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req.emit('end');

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = {};
    proxyRes.pipe = jest.fn();
    responseHandler(proxyRes);
    proxyRes.emit('error', new Error('upstream stream failed'));

    expect(res.writeHead).toHaveBeenNthCalledWith(1, 200, { 'x-request-id': expect.any(String) });
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(res.destroy).toHaveBeenCalledWith(expect.any(Error));
    const after = healthResponse().metrics_summary;
    expect(after.total_errors).toBe(before.total_errors + 1);
    expect(after.active_requests).toBe(before.active_requests);
    const errorLog = getRequestErrorLog(stdoutWriteSpy);
    expect(errorLog).toMatchObject({
      event: 'request_error',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      error: 'upstream stream failed',
      upstream_host: 'api.openai.com',
    });
  });

  it('returns 502 when the upstream proxy request errors', () => {
    const before = healthResponse().metrics_summary;
    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req.emit('end');
    upstreamRequest.emit('error', new Error('upstream connect failed'));

    expect(res.writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'application/json' });
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      error: 'Proxy error',
      message: 'upstream connect failed',
    });
    const after = healthResponse().metrics_summary;
    expect(after.total_errors).toBe(before.total_errors + 1);
    expect(after.total_requests).toBe(before.total_requests + 1);
    expect(after.active_requests).toBe(before.active_requests);
    const errorLog = getRequestErrorLog(stdoutWriteSpy);
    expect(errorLog).toMatchObject({
      event: 'request_error',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      error: 'upstream connect failed',
      upstream_host: 'api.openai.com',
    });
  });
});

describe('proxyRequest effective token guard', () => {
  function makeReq(headers = {}) {
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', ...headers };
    return req;
  }

  function makeRes() {
    return {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn(),
    };
  }

  beforeEach(() => {
    // Keep the cap small so one tiny mocked usage payload deterministically exceeds it.
    // Environment variables are strings; parser converts this to Number(10).
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '10';
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    resetEffectiveTokenGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    resetEffectiveTokenGuardForTests();
    jest.restoreAllMocks();
  });

  it('returns 429 with structured payload when effective token limit is reached', () => {
    let responseHandler;
    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      responseHandler = cb;
      return upstreamRequest;
    });

    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('end');

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.pipe = jest.fn();

    responseHandler(proxyRes);
    const usageBody = JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });
    proxyRes.emit('data', Buffer.from(usageBody));
    proxyRes.emit('end');

    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('end');

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res2.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('effective_tokens_limit_exceeded');
    expect(payload.error.max_effective_tokens).toBe(10);
    expect(payload.error.total_effective_tokens).toBeGreaterThanOrEqual(10);
  });
});

describe('proxyRequest max-runs guard', () => {
  function makeReq(headers = {}) {
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', ...headers };
    return req;
  }

  function makeRes() {
    return {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn(),
    };
  }

  beforeEach(() => {
    process.env.AWF_MAX_RUNS = '1';
    resetMaxRunsGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_RUNS;
    resetMaxRunsGuardForTests();
    jest.restoreAllMocks();
  });

  it('returns 429 with structured payload when max runs limit is exceeded', () => {
    let responseHandler;
    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      responseHandler = cb;
      return upstreamRequest;
    });

    // First request completes successfully — consumes the single allowed run
    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('end');

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.pipe = jest.fn();

    responseHandler(proxyRes);
    proxyRes.emit('end');

    // Second request — max-runs limit is now exceeded
    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('end');

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res2.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('max_runs_exceeded');
    expect(payload.error.max_runs).toBe(1);
    expect(payload.error.invocation_count).toBe(1);
  });

  it('allows requests when max runs is not configured', () => {
    delete process.env.AWF_MAX_RUNS;
    resetMaxRunsGuardForTests();

    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req.emit('end');

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).not.toHaveBeenCalledWith(429, expect.anything());
  });
});

describe('token steering — getAndClearPendingSteeringMessage and injectSteeringMessage', () => {
  // getAndClearPendingSteeringMessage and injectSteeringMessage are loaded here
  // for unit-level tests (pure function tests and "returns null" guard checks).
  // Integration tests that verify steering injection end-to-end use two
  // proxyRequest calls so that the same module instance that runs inside the
  // proxy handles both the threshold crossing and the body injection.
  let getAndClearPendingSteeringMessage;
  let getAndClearPendingTimeoutSteeringMessage;
  let injectSteeringMessage;
  let reset;
  let resetTimeout;

  beforeAll(() => {
    ({
      getAndClearPendingSteeringMessage,
      getAndClearPendingTimeoutSteeringMessage,
      injectSteeringMessage,
      resetEffectiveTokenGuardForTests: reset,
      resetTimeoutSteeringForTests: resetTimeout,
    } =
      require('./proxy-request'));
  });

  beforeEach(() => {
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '100';
    process.env.AWF_ENABLE_TOKEN_STEERING = 'true';
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
    reset();
    resetTimeout();
    resetEffectiveTokenGuardForTests();
    resetTimeoutSteeringForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_ENABLE_TOKEN_STEERING;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
    reset();
    resetTimeout();
    resetEffectiveTokenGuardForTests();
    resetTimeoutSteeringForTests();
    jest.restoreAllMocks();
  });

  it('returns null when no thresholds have been crossed', () => {
    expect(getAndClearPendingSteeringMessage()).toBeNull();
  });

  it('returns timeout steering warnings as runtime thresholds are crossed', () => {
    process.env.AWF_AGENT_TIMEOUT_MINUTES = '10';
    const start = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    resetTimeout();

    expect(getAndClearPendingTimeoutSteeringMessage()).toBeNull();

    nowSpy.mockReturnValue(start + (8 * 60 * 1000));
    const msg80 = getAndClearPendingTimeoutSteeringMessage();
    expect(msg80).toContain('[AWF TIME WARNING]');
    expect(msg80).toContain('80%');
    expect(getAndClearPendingTimeoutSteeringMessage()).toBeNull();

    nowSpy.mockReturnValue(start + Math.floor(9.6 * 60 * 1000));
    const msg95 = getAndClearPendingTimeoutSteeringMessage();
    const msg90 = getAndClearPendingTimeoutSteeringMessage();
    expect(msg95).toContain('95%');
    expect(msg90).toContain('90%');
  });

  it('injects timeout steering warning into OpenAI request body', () => {
    process.env.AWF_AGENT_TIMEOUT_MINUTES = '10';
    const start = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    resetTimeout();

    const upstreamReq1 = new EventEmitter();
    upstreamReq1.end = jest.fn();
    upstreamReq1.write = jest.fn();
    upstreamReq1.destroy = jest.fn();

    const upstreamReq2 = new EventEmitter();
    upstreamReq2.end = jest.fn();
    upstreamReq2.write = jest.fn();
    upstreamReq2.destroy = jest.fn();

    jest.spyOn(https, 'request')
      .mockImplementationOnce(() => upstreamReq1)
      .mockImplementationOnce(() => upstreamReq2);

    const req1Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'First request' }],
    }));
    const req1 = new EventEmitter();
    req1.url = '/v1/chat/completions';
    req1.method = 'POST';
    req1.headers = { 'content-type': 'application/json', 'content-length': String(req1Body.length) };
    const res1 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('data', req1Body);
    req1.emit('end');

    nowSpy.mockReturnValue(start + (8 * 60 * 1000));

    const req2Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'Second request' }],
    }));
    const req2 = new EventEmitter();
    req2.url = '/v1/chat/completions';
    req2.method = 'POST';
    req2.headers = { 'content-type': 'application/json', 'content-length': String(req2Body.length) };
    const res2 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('data', req2Body);
    req2.emit('end');

    expect(upstreamReq2.write).toHaveBeenCalledTimes(1);
    const writtenBody2 = JSON.parse(upstreamReq2.write.mock.calls[0][0].toString());
    expect(writtenBody2.messages[0].role).toBe('system');
    expect(writtenBody2.messages[0].content).toContain('[AWF TIME WARNING]');
    expect(writtenBody2.messages[0].content).toContain('80%');
  });

  it('injects 80% warning into an OpenAI request body and clears it on the next request', () => {
    // Two upstream request objects — one per proxyRequest call.
    let responseHandler;
    const upstreamReq1 = new EventEmitter();
    upstreamReq1.end = jest.fn();
    upstreamReq1.write = jest.fn();
    upstreamReq1.destroy = jest.fn();

    const upstreamReq2 = new EventEmitter();
    upstreamReq2.end = jest.fn();
    upstreamReq2.write = jest.fn();
    upstreamReq2.destroy = jest.fn();

    const upstreamReq3 = new EventEmitter();
    upstreamReq3.end = jest.fn();
    upstreamReq3.write = jest.fn();
    upstreamReq3.destroy = jest.fn();

    jest.spyOn(https, 'request')
      .mockImplementationOnce((_opts, cb) => { responseHandler = cb; return upstreamReq1; })
      .mockImplementationOnce(() => upstreamReq2)
      .mockImplementationOnce(() => upstreamReq3);

    // Request 1: triggers 84 effective tokens (21 output × 4.0) → 84% of 100 → crosses 80%
    const req1 = new EventEmitter();
    req1.url = '/v1/chat/completions';
    req1.method = 'POST';
    req1.headers = { 'content-type': 'application/json' };
    const res1 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    proxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('end');

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.pipe = jest.fn();
    responseHandler(proxyRes);

    proxyRes.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 0, completion_tokens: 21 },
    })));
    proxyRes.emit('end');

    // Request 2: the proxy should inject the 80% warning into the outgoing body.
    // We send a minimal OpenAI chat body and inspect what the proxy writes upstream.
    const req2Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'Hello' }],
    }));
    const req2 = new EventEmitter();
    req2.url = '/v1/chat/completions';
    req2.method = 'POST';
    req2.headers = { 'content-type': 'application/json', 'content-length': String(req2Body.length) };
    const res2 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    proxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('data', req2Body);
    req2.emit('end');

    // The proxy writes the (modified) body to the upstream request.
    expect(upstreamReq2.write).toHaveBeenCalledTimes(1);
    const writtenBody2 = JSON.parse(upstreamReq2.write.mock.calls[0][0].toString());
    // A system message with the budget warning should be prepended.
    expect(writtenBody2.messages[0].role).toBe('system');
    expect(writtenBody2.messages[0].content).toContain('[AWF TOKEN WARNING]');
    expect(writtenBody2.messages[0].content).toContain('80%');
    // The original user message should follow.
    expect(writtenBody2.messages[1]).toMatchObject({ role: 'user', content: 'Hello' });

    // Request 3: the 80% threshold has already been injected; no further steering.
    const req3Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'Hello again' }],
    }));
    const req3 = new EventEmitter();
    req3.url = '/v1/chat/completions';
    req3.method = 'POST';
    req3.headers = { 'content-type': 'application/json', 'content-length': String(req3Body.length) };
    const res3 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    proxyRequest(req3, res3, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req3.emit('data', req3Body);
    req3.emit('end');

    expect(upstreamReq3.write).toHaveBeenCalledTimes(1);
    const writtenBody3 = JSON.parse(upstreamReq3.write.mock.calls[0][0].toString());
    const systemMessages3 = writtenBody3.messages.filter(m => m.role === 'system' && m.content.includes('[AWF TOKEN WARNING]'));
    expect(systemMessages3).toHaveLength(0);
  });

  it('does not inject any warning when AWF_ENABLE_TOKEN_STEERING is not set', () => {
    // Disable token steering for this test
    delete process.env.AWF_ENABLE_TOKEN_STEERING;

    // Load a fresh proxyRequest that shares the same proxy-request module instance
    // as reset() and getAndClearPendingSteeringMessage (assigned in beforeAll above).
    // This prevents accumulated effective-token state from earlier tests (which use a
    // different proxy-request instance loaded before jest.resetModules() was called by
    // the CONNECT-tunnel describe's afterAll) from leaking into this test.
    const { proxyRequest: localProxyRequest } = require('./server');

    let responseHandler;
    const upstreamReq1 = new EventEmitter();
    upstreamReq1.end = jest.fn();
    upstreamReq1.write = jest.fn();
    upstreamReq1.destroy = jest.fn();

    const upstreamReq2 = new EventEmitter();
    upstreamReq2.end = jest.fn();
    upstreamReq2.write = jest.fn();
    upstreamReq2.destroy = jest.fn();

    jest.spyOn(https, 'request')
      .mockImplementationOnce((_opts, cb) => { responseHandler = cb; return upstreamReq1; })
      .mockImplementationOnce(() => upstreamReq2);

    // Request 1: triggers 84 effective tokens (21 output × 4.0) → 84% of 100 → would cross 80% if steering enabled
    const req1 = new EventEmitter();
    req1.url = '/v1/chat/completions';
    req1.method = 'POST';
    req1.headers = { 'content-type': 'application/json' };
    const res1 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    localProxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('end');

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.pipe = jest.fn();
    responseHandler(proxyRes);

    proxyRes.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 0, completion_tokens: 21 },
    })));
    proxyRes.emit('end');

    // Request 2: steering is disabled, so no warning should be injected.
    const req2Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'Hello' }],
    }));
    const req2 = new EventEmitter();
    req2.url = '/v1/chat/completions';
    req2.method = 'POST';
    req2.headers = { 'content-type': 'application/json', 'content-length': String(req2Body.length) };
    const res2 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    localProxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('data', req2Body);
    req2.emit('end');

    expect(upstreamReq2.write).toHaveBeenCalledTimes(1);
    const writtenBody2 = JSON.parse(upstreamReq2.write.mock.calls[0][0].toString());
    const systemMessages = writtenBody2.messages.filter(m => m.role === 'system' && m.content.includes('[AWF TOKEN WARNING]'));
    expect(systemMessages).toHaveLength(0);
  });

  describe('injectSteeringMessage', () => {
    const WARNING = '[AWF TOKEN WARNING] Test warning message.';

    it('injects into OpenAI messages array after existing system messages', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      }));
      const result = injectSteeringMessage(body, 'openai', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.messages[1].role).toBe('system');
      expect(parsed.messages[1].content).toBe(WARNING);
      expect(parsed.messages[2].role).toBe('user');
    });

    it('injects system message at position 0 when no existing system message', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const result = injectSteeringMessage(body, 'openai', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.messages[0].role).toBe('system');
      expect(parsed.messages[0].content).toBe(WARNING);
    });

    it('injects into Anthropic string system field', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-opus-4-5',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const result = injectSteeringMessage(body, 'anthropic', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(typeof parsed.system).toBe('string');
      expect(parsed.system).toContain('You are a helpful assistant.');
      expect(parsed.system).toContain(WARNING);
    });

    it('appends text block to Anthropic array system field', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-opus-4-5',
        system: [{ type: 'text', text: 'Original system.' }],
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const result = injectSteeringMessage(body, 'anthropic', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(Array.isArray(parsed.system)).toBe(true);
      expect(parsed.system).toHaveLength(2);
      expect(parsed.system[1]).toEqual({ type: 'text', text: WARNING });
    });

    it('creates system field in Anthropic body when absent', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-opus-4-5',
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const result = injectSteeringMessage(body, 'anthropic', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.system).toBe(WARNING);
    });

    it('injects into Gemini systemInstruction', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gemini-2.0-flash',
        systemInstruction: { parts: [{ text: 'Be helpful.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      }));
      const result = injectSteeringMessage(body, 'gemini', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.systemInstruction.parts).toHaveLength(2);
      expect(parsed.systemInstruction.parts[1]).toEqual({ text: WARNING });
    });

    it('creates systemInstruction in Gemini body when absent', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gemini-2.0-flash',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      }));
      const result = injectSteeringMessage(body, 'gemini', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.systemInstruction).toEqual({ parts: [{ text: WARNING }] });
    });

    it('returns null for non-JSON body', () => {
      const body = Buffer.from('not json');
      const result = injectSteeringMessage(body, 'openai', WARNING);
      expect(result).toBeNull();
    });

    it('returns null for OpenAI body without messages array', () => {
      const body = Buffer.from(JSON.stringify({ model: 'gpt-4o' }));
      const result = injectSteeringMessage(body, 'openai', WARNING);
      expect(result).toBeNull();
    });
  });
});
