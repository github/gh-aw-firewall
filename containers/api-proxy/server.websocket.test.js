/**
 * Tests for proxyWebSocket: request validation, proxy configuration errors,
 * and CONNECT tunnel / auth injection.
 *
 * Extracted from server.proxy.test.js.
 */

const http = require('http');
const tls = require('tls');
const { EventEmitter } = require('events');
const { setupServerTestEnv } = require('./test-helpers/server-mock-factories');

let proxyWebSocket;

setupServerTestEnv(() => {
  ({ proxyWebSocket } = require('./server'));
  return { proxyWebSocket };
});


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
    let socket, connectReq, tunnel, tlsSocket;

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

    beforeEach(() => {
      socket = makeMockSocket();
      connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      tunnel = makeMockSocket();
      tlsSocket = new EventEmitter();
      tlsSocket.write = jest.fn();
      tlsSocket.destroy = jest.fn();
      tlsSocket.pipe = jest.fn();
    });

    it('returns 502 when the CONNECT response is not 200', () => {
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
      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('error', new Error('certificate unknown')));
      });

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer key' }, 'openai');

      return new Promise(resolve => {
        tlsSocket.once('error', () => setImmediate(() => {
          expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
          expect(socket.destroy).toHaveBeenCalled();
          resolve();
        }));
      });
    });

    it('injects Authorization header and fixes Host header in the upgrade request', () => {
      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('secureConnect'));
      });

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer secret' }, 'openai');

      return new Promise(resolve => {
        tlsSocket.once('secureConnect', () => setImmediate(() => {
          const upgradeWrite = tlsSocket.write.mock.calls.find(
            c => typeof c[0] === 'string' && c[0].startsWith('GET ')
          );
          expect(upgradeWrite).toBeDefined();
          const upgradeReqStr = upgradeWrite[0];
          expect(upgradeReqStr).toMatch(/Authorization:\s+Bearer\s+\S+/);
          expect(upgradeReqStr).toContain('host: api.openai.com');
          expect(tlsSocket.pipe).toHaveBeenCalledWith(socket);
          expect(socket.pipe).toHaveBeenCalledWith(tlsSocket);
          resolve();
        }));
      });
    });

    it('strips client-supplied auth headers before forwarding', () => {
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

// ── Security guard tests ──────────────────────────────────────────────────────
//
// These tests verify that all common security guards are enforced on the
// WebSocket upgrade path using the shared buildCommonGuardChecks factory.
// Guards are triggered by directly calling their apply functions (same
// technique used in guards/*.test.js unit tests).

describe('proxyWebSocket security guards', () => {
  let wsProxy;
  let applyMaxRunsInvocation, resetMaxRunsGuardForTests;
  let applyEffectiveTokenUsage, resetEffectiveTokenGuardForTests;
  let applyPermissionDenied, resetPermissionDeniedGuardForTests;
  let applyAiCreditsUsage, resetAiCreditsGuardForTests;

  beforeAll(() => {
    jest.resetModules();
    wsProxy = require('./server').proxyWebSocket;
    ({ applyMaxRunsInvocation, resetMaxRunsGuardForTests } = require('./guards/max-runs-guard'));
    ({ applyEffectiveTokenUsage, resetEffectiveTokenGuardForTests } = require('./guards/effective-token-guard'));
    ({ applyPermissionDenied, resetPermissionDeniedGuardForTests } = require('./guards/max-permission-denied-guard'));
    ({ applyAiCreditsUsage, resetAiCreditsGuardForTests } = require('./guards/ai-credits-guard'));
  });

  afterAll(() => {
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_RUNS;
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_MAX_PERMISSION_DENIED;
    delete process.env.AWF_MAX_AI_CREDITS;
    resetMaxRunsGuardForTests();
    resetEffectiveTokenGuardForTests();
    resetPermissionDeniedGuardForTests();
    resetAiCreditsGuardForTests();
    jest.restoreAllMocks();
  });

  it('blocks with 429 when max-runs limit is exceeded', () => {
    process.env.AWF_MAX_RUNS = '1';
    applyMaxRunsInvocation(); // consume the single allowed run

    const socket = makeMockSocket();
    wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 429 Too Many Requests'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"max_runs_exceeded"'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('blocks with 429 when effective-token limit is exceeded', () => {
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '1';
    applyEffectiveTokenUsage({ output_tokens: 5 }, 'gpt-4o'); // exceeds cap of 1

    const socket = makeMockSocket();
    wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 429 Too Many Requests'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"effective_tokens_limit_exceeded"'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('blocks with 403 when permission-denied limit is exceeded', () => {
    process.env.AWF_MAX_PERMISSION_DENIED = '1';
    applyPermissionDenied(); // consume the single allowed denial

    const socket = makeMockSocket();
    wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 403 Forbidden'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"permission_denied_limit_exceeded"'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('blocks with 429 when ai-credits limit is exceeded', () => {
    process.env.AWF_MAX_AI_CREDITS = '0.000001'; // tiny cap — any real usage will exceed it
    applyAiCreditsUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'gpt-4o');

    const socket = makeMockSocket();
    wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 429 Too Many Requests'));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"ai_credits_limit_exceeded"'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('allows the upgrade when no guards are triggered', () => {
    // No guard env vars set and no usage applied — all guards pass.
    // Without HTTPS_PROXY the upgrade will fail with 502, but the key point is
    // that it gets past the guard checks (no 429/403 is written).
    const socket = makeMockSocket();
    wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');

    const guardStatuses = ['HTTP/1.1 429', 'HTTP/1.1 403 Forbidden'];
    for (const status of guardStatuses) {
      expect(socket.write).not.toHaveBeenCalledWith(expect.stringContaining(status));
    }
    // The 502 from missing HTTPS_PROXY confirms we got past the guards.
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
  });
});
