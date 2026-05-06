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

const originalHttpsProxy = process.env.HTTPS_PROXY;
let proxyRequest;
let proxyWebSocket;

beforeAll(() => {
  delete process.env.HTTPS_PROXY;
  jest.resetModules();
  ({ proxyRequest, proxyWebSocket } = require('./server'));
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
    jest.spyOn(https, 'request').mockImplementation((options) => {
      capturedOptions = options;
      const proxyReq = new EventEmitter();
      proxyReq.end = jest.fn();
      proxyReq.write = jest.fn();
      proxyReq.destroy = jest.fn();
      return proxyReq;
    });
    return { getCaptured: () => capturedOptions };
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

  it('injects x-initiator: agent when OpenCode routes to Copilot backend', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'opencode');
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

  it('preserves a client-supplied x-initiator value on OpenCode→Copilot requests', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq({ 'x-initiator': 'user' });
    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'opencode');
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

  it('does not inject x-initiator when OpenCode routes to non-Copilot backend', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.openai.com', { 'Authorization': 'Bearer sk-test' }, 'opencode');
    req.emit('end');
    expect(getCaptured().headers['x-initiator']).toBeUndefined();
  });
});
