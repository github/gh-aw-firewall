const { EventEmitter } = require('events');
const { createWebSocketTunnel } = require('./websocket-tunnel');

function makeSocket() {
  const socket = new EventEmitter();
  socket.write = jest.fn();
  socket.destroy = jest.fn();
  socket.writable = true;
  socket.destroyed = false;
  return socket;
}

describe('websocket-tunnel', () => {
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
});
