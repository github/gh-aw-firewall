const { EventEmitter } = require('events');
const { createBodyHandler } = require('./body-handler');
const metrics = require('./metrics');

describe('collectRequestBody', () => {
  let req, res, span, otel, handleRequestError, collect;

  beforeEach(() => {
    req = Object.assign(new EventEmitter(), { method: 'POST', url: '/responses' });
    res = { writeHead: jest.fn(), end: jest.fn() };
    span = {};
    otel = { endSpan: jest.fn(), endSpanError: jest.fn() };
    handleRequestError = jest.fn();
    const handler = createBodyHandler({ handleRequestError, otel });
    collect = () => handler.collectRequestBody(req, 'copilot', 'collection', res, span, Date.now(), 'api.example.com');
    jest.spyOn(metrics, 'gaugeDec');
    jest.spyOn(metrics, 'increment');
  });

  afterEach(() => jest.restoreAllMocks());

  test.each([0, 10 * 1024 * 1024])('accepts %i bytes without ending the span', async size => {
    const pending = collect();
    const body = Buffer.alloc(size, 'a');
    req.emit('data', body.subarray(0, Math.floor(size / 2)));
    req.emit('data', body.subarray(Math.floor(size / 2)));
    req.emit('end');
    req.emit('close');

    expect((await pending).equals(body)).toBe(true);
    expect(otel.endSpan).not.toHaveBeenCalled();
    expect(otel.endSpanError).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(metrics.gaugeDec).not.toHaveBeenCalled();
  });

  test.each([false, true])('rejects excess bytes once (headersSent=%s)', async headersSent => {
    res.headersSent = headersSent;
    const pending = collect();
    req.emit('data', Buffer.alloc(10 * 1024 * 1024));
    req.emit('data', Buffer.from('x'));
    req.emit('error', new Error('late error'));
    req.emit('close');
    req.emit('data', Buffer.from('ignored'));
    req.emit('end');

    await expect(pending).resolves.toBeNull();
    expect(res.writeHead).toHaveBeenCalledTimes(headersSent ? 0 : 1);
    if (!headersSent) expect(res.writeHead).toHaveBeenCalledWith(413, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledWith(
      '{"error":"Payload Too Large","message":"Request body exceeds 10 MB limit"}',
    );
    expect(otel.endSpan).toHaveBeenCalledTimes(1);
    expect(otel.endSpan).toHaveBeenCalledWith(span, 413);
    expect(otel.endSpanError).not.toHaveBeenCalled();
    expect(handleRequestError).not.toHaveBeenCalled();
    expect(metrics.gaugeDec).toHaveBeenCalledTimes(1);
    expect(metrics.gaugeDec).toHaveBeenCalledWith('active_requests', { provider: 'copilot' });
    expect(metrics.increment).toHaveBeenCalledTimes(1);
    expect(metrics.increment).toHaveBeenCalledWith('requests_total', {
      provider: 'copilot', method: 'POST', status_class: '4xx',
    });
  });

  test('delegates client stream errors as 400 and ignores subsequent events', async () => {
    const pending = collect();
    const error = new Error('client disconnected');
    req.emit('error', error);
    req.emit('close');
    req.emit('end');

    await expect(pending).resolves.toBeNull();
    expect(otel.endSpanError).toHaveBeenCalledTimes(1);
    expect(otel.endSpanError).toHaveBeenCalledWith(span, error, 400);
    expect(otel.endSpan).not.toHaveBeenCalled();
    expect(handleRequestError).toHaveBeenCalledTimes(1);
    expect(handleRequestError).toHaveBeenCalledWith(error, expect.objectContaining({
      req, res, statusCode: 400, clientMessage: 'Client error',
    }));
  });

  test('ends an aborted request span once without sending a response', async () => {
    const pending = collect();
    req.emit('close');
    req.emit('error', new Error('late error'));
    req.emit('end');

    await expect(pending).resolves.toBeNull();
    expect(otel.endSpan).toHaveBeenCalledTimes(1);
    expect(otel.endSpan).toHaveBeenCalledWith(span, 0);
    expect(metrics.gaugeDec).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(handleRequestError).not.toHaveBeenCalled();
  });

  test('does not abort a complete request when close precedes end', async () => {
    const pending = collect();
    req.complete = true;
    req.emit('data', Buffer.from('complete'));
    req.emit('close');
    req.emit('end');

    await expect(pending).resolves.toEqual(Buffer.from('complete'));
    expect(otel.endSpan).not.toHaveBeenCalled();
  });
});
