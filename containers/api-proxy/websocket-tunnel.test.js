const { EventEmitter } = require('events');
const http = require('http');
const tls = require('tls');
const { parseCallerHeader } = require('./caller-header');
const { shouldStripHeader } = require('./proxy-utils');
const { createWebSocketTunnel, extractRequestModelFromUrl } = require('./websocket-tunnel');

function makeSocket() {
  const socket = new EventEmitter();
  socket.write = jest.fn();
  socket.pipe = jest.fn();
  socket.destroy = jest.fn();
  socket.writable = true;
  socket.destroyed = false;
  return socket;
}

describe('websocket-tunnel', () => {
  it.each([
    ['http', 'localhost:11434', 'localhost:11434'],
    ['https', 'gateway.example.com:8443', 'gateway.example.com:8443'],
    ['http', '[::1]:11434', '[::1]:11434'],
  ])('CONNECTs to the explicit %s target port', (targetScheme, targetHost, authority) => {
    const connectReq = new EventEmitter();
    connectReq.end = jest.fn();
    const requestSpy = jest.spyOn(http, 'request').mockReturnValue(connectReq);
    const tlsSocket = makeSocket();
    const tlsSpy = jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);
    try {
      createWebSocketTunnel({
        HTTPS_PROXY: 'http://squid:3128', metrics: {}, logRequest: jest.fn(),
        sanitizeForLog: String, shouldStripHeader, trackWebSocketTokenUsage: jest.fn(),
      })({
        req: { url: '/v1/responses', headers: {} }, socket: makeSocket(),
        targetScheme, targetHost, upstreamPath: '/v1/responses', injectHeaders: {},
      });
      expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
        path: authority, headers: { Host: authority },
      }));
      const tunnel = makeSocket();
      connectReq.emit('connect', { statusCode: 200 }, tunnel);
      if (targetScheme === 'https') {
        expect(tlsSpy).toHaveBeenCalledWith({
          socket: tunnel, servername: 'gateway.example.com', rejectUnauthorized: true,
        });
        tlsSocket.emit('secureConnect');
        expect(tlsSocket.write).toHaveBeenCalledWith(expect.stringContaining(`host: ${authority}\r\n`));
      } else {
        expect(tlsSpy).not.toHaveBeenCalled();
        expect(tunnel.write).toHaveBeenCalledWith(expect.stringContaining(`host: ${authority}\r\n`));
      }
    } finally {
      requestSpy.mockRestore();
      tlsSpy.mockRestore();
    }
  });

  it('extracts request model from websocket URL query', () => {
    expect(extractRequestModelFromUrl('/v1/chat/completions?model=auto')).toBe('auto');
    expect(extractRequestModelFromUrl('/v1/chat/completions?foo=bar')).toBeNull();
  });

  it('passes the caller to the tracker and strips its header from a successful tunnel', () => {
    const connectReq = new EventEmitter();
    connectReq.end = jest.fn();
    const requestSpy = jest.spyOn(http, 'request').mockReturnValue(connectReq);
    try {
      const socket = makeSocket();
      const tunnel = makeSocket();
      const trackWebSocketTokenUsage = jest.fn();
      const req = {
        url: '/v1/responses?model=gpt-5',
        headers: {
          'x-awf-caller': 'subagent/file-summarizer',
          'X-AWF-Caller': 'main',
          connection: 'Upgrade',
          upgrade: 'websocket',
        },
        awfCaller: parseCallerHeader('subagent/file-summarizer'),
      };
      const openWebSocketTunnel = createWebSocketTunnel({
        HTTPS_PROXY: 'http://squid:3128',
        metrics: { gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() },
        logRequest: jest.fn(),
        sanitizeForLog: (v) => String(v || ''),
        shouldStripHeader,
        trackWebSocketTokenUsage,
      });

      openWebSocketTunnel({
        req,
        socket,
        head: Buffer.alloc(0),
        targetHost: 'api.openai.com',
        targetScheme: 'http',
        injectHeaders: {},
        provider: 'openai',
        requestId: 'req-caller',
        startTime: Date.now(),
        upstreamPath: req.url,
      });
      expect(requestSpy).toHaveBeenCalledWith(expect.objectContaining({
        method: 'CONNECT',
        path: 'api.openai.com:80',
      }));
      expect(connectReq.end).toHaveBeenCalledTimes(1);
      connectReq.emit('connect', { statusCode: 200 }, tunnel);

      expect(trackWebSocketTokenUsage).toHaveBeenCalledTimes(1);
      expect(trackWebSocketTokenUsage).toHaveBeenCalledWith(tunnel, expect.objectContaining({
        requestId: 'req-caller',
        requestModel: 'gpt-5',
        caller: req.awfCaller,
      }));
      expect(trackWebSocketTokenUsage.mock.calls[0][1].caller).toBe(req.awfCaller);
      expect(tunnel.write).toHaveBeenCalledTimes(1);
      const upgradeRequest = tunnel.write.mock.calls[0][0];
      expect(upgradeRequest).toContain(`GET ${req.url} HTTP/1.1\r\n`);
      expect(upgradeRequest).toContain('upgrade: websocket\r\n');
      expect(upgradeRequest.toLowerCase()).not.toContain('x-awf-caller');
      expect(tunnel.pipe).toHaveBeenCalledWith(socket);
      expect(socket.pipe).toHaveBeenCalledWith(tunnel);
    } finally {
      requestSpy.mockRestore();
    }
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
});
