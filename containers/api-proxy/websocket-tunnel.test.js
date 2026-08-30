const { EventEmitter } = require('events');
const {
  createWebSocketTunnel,
  extractRequestModelFromUrl,
  attachHandshakeStatusRecorder,
} = require('./websocket-tunnel');
const {
  resetGuardResultTrackerForTests,
  getGuardResultSnapshot,
} = require('./guards/guard-result-tracker');

function makeSocket() {
  const socket = new EventEmitter();
  socket.write = jest.fn();
  socket.destroy = jest.fn();
  socket.writable = true;
  socket.destroyed = false;
  return socket;
}

describe('websocket-tunnel', () => {
  it('extracts request model from websocket URL query', () => {
    expect(extractRequestModelFromUrl('/v1/chat/completions?model=auto')).toBe('auto');
    expect(extractRequestModelFromUrl('/v1/chat/completions?foo=bar')).toBeNull();
  });

  it('returns 502 when HTTPS_PROXY is not configured', () => {
    const metrics = {
      gaugeDec: jest.fn(),
      increment: jest.fn(),
      observe: jest.fn(),
    };
    const logRequest = jest.fn();
    const socket = makeSocket();
    const openWebSocketTunnel = createWebSocketTunnel({
      HTTPS_PROXY: '',
      metrics,
      logRequest,
      sanitizeForLog: (v) => String(v || ''),
      shouldStripHeader: () => false,
      trackWebSocketTokenUsage: jest.fn(),
    });

    openWebSocketTunnel({
      req: { url: '/v1/responses', headers: {} },
      socket,
      head: Buffer.alloc(0),
      targetHost: 'api.openai.com',
      injectHeaders: {},
      provider: 'openai',
      requestId: 'req-1',
      startTime: Date.now(),
      upstreamPath: '/v1/responses',
    });

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  describe('attachHandshakeStatusRecorder', () => {
    beforeEach(() => {
      resetGuardResultTrackerForTests();
      process.env.AWF_GUARD_RESULT_ENABLED = '1';
    });

    afterEach(() => {
      resetGuardResultTrackerForTests();
      delete process.env.AWF_GUARD_RESULT_ENABLED;
    });

    it('records a 403 upstream WebSocket handshake rejection', () => {
      const tlsSocket = new EventEmitter();
      attachHandshakeStatusRecorder(tlsSocket);
      tlsSocket.emit('data', Buffer.from('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
      const snapshot = getGuardResultSnapshot();
      expect(snapshot.upstream_403_count).toBe(1);
      expect(snapshot.final_event).toBe('upstream_403');
    });

    it('records a 401 upstream WebSocket handshake rejection', () => {
      const tlsSocket = new EventEmitter();
      attachHandshakeStatusRecorder(tlsSocket);
      tlsSocket.emit('data', Buffer.from('HTTP/1.1 401 Unauthorized\r\n\r\n'));
      // 401 isn't tracked as a distinct counter (matching the HTTP request
      // path in upstream-log.js), but must not throw or be misclassified.
      const snapshot = getGuardResultSnapshot();
      expect(snapshot.upstream_403_count).toBe(0);
    });

    it('does not record a successful 101 handshake upgrade', () => {
      const tlsSocket = new EventEmitter();
      attachHandshakeStatusRecorder(tlsSocket);
      tlsSocket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n'));
      const snapshot = getGuardResultSnapshot();
      expect(snapshot.upstream_403_count).toBe(0);
      expect(snapshot.final_event).toBeNull();
    });

    it('only parses the first data chunk and ignores subsequent WebSocket frames', () => {
      const tlsSocket = new EventEmitter();
      attachHandshakeStatusRecorder(tlsSocket);
      tlsSocket.emit('data', Buffer.from('HTTP/1.1 403 Forbidden\r\n\r\n'));
      tlsSocket.emit('data', Buffer.from([0x81, 0x03, 0x34, 0x30, 0x33])); // binary frame, not a status line
      const snapshot = getGuardResultSnapshot();
      expect(snapshot.upstream_403_count).toBe(1);
    });
  });
});
