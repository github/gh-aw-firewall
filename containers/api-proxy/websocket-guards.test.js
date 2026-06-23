const { EventEmitter } = require('events');
const { enforceWebSocketRateLimit } = require('./websocket-guards');

function makeSocket() {
  const socket = new EventEmitter();
  socket.write = jest.fn();
  socket.destroy = jest.fn();
  return socket;
}

describe('websocket-guards', () => {
  it('blocks and returns 429 when rate limit is exceeded', () => {
    const limiter = { check: jest.fn(() => ({ allowed: false, limitType: 'requests', limit: 10, retryAfter: 5 })) };
    const metrics = { increment: jest.fn() };
    const logRequest = jest.fn();
    const socket = makeSocket();

    const blocked = enforceWebSocketRateLimit({
      limiter,
      metrics,
      logRequest,
      socket,
      requestId: 'req-1',
      provider: 'openai',
    });

    expect(blocked).toBe(true);
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 429 Too Many Requests'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('allows request when rate limit check passes', () => {
    const limiter = { check: jest.fn(() => ({ allowed: true })) };
    const metrics = { increment: jest.fn() };
    const logRequest = jest.fn();
    const socket = makeSocket();

    const blocked = enforceWebSocketRateLimit({
      limiter,
      metrics,
      logRequest,
      socket,
      requestId: 'req-2',
      provider: 'openai',
    });

    expect(blocked).toBe(false);
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
