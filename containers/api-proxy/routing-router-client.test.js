'use strict';

const http = require('http');
const { createRoutingRouterClient } = require('./routing-router-client');
const { runBoundedOperation } = require('./routing-planner');

describe('routing router client', () => {
  let server;
  let baseUrl;
  const seen = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
        if (req.url === '/healthz') return res.writeHead(204).end();
        if (Buffer.concat(chunks).toString('utf8') === '{"failure":true}') {
          return res.writeHead(500).end('{"error":"retry"}');
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  it('uses fixed router endpoints, exact request JSON, and contract status rules', async () => {
    const client = createRoutingRouterClient({ baseUrl });
    await expect(client.health({ timeoutMs: 1000 })).resolves.toBe(204);
    await expect(client.capabilities({ timeoutMs: 1000 })).resolves.toEqual({ ok: true });
    await expect(client.classify({ prompt: 'label' }, { timeoutMs: 1000 })).resolves.toEqual({ ok: true });
    await expect(client.route({ choices: ['a'] }, { timeoutMs: 1000, method: 'GET', value: { choices: ['ignored'] } }))
      .resolves.toEqual({ ok: true });
    expect(seen).toEqual([
      { path: '/healthz', method: 'GET', body: '' },
      { path: '/capabilities', method: 'GET', body: '' },
      { path: '/classify', method: 'POST', body: '{"prompt":"label"}' },
      { path: '/route', method: 'POST', body: '{"choices":["a"]}' },
    ]);
  });

  it('rejects invalid origins and preserves retryable server failures', async () => {
    expect(() => createRoutingRouterClient({ baseUrl: 'https://router.test/path' }))
      .toThrow(expect.objectContaining({ code: 'routing_configuration_error' }));
    const client = createRoutingRouterClient({ baseUrl });
    await expect(client.route({ failure: true }, { timeoutMs: 1000 }))
      .rejects.toMatchObject({ statusCode: 500, transient: true, body: { error: 'retry' } });
  });
});

describe('routing router client tracing', () => {
  const TRACEPARENT = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  let server;
  let baseUrl;
  let seen;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ path: req.url, headers: req.headers });
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url === '/healthz') return res.writeHead(204).end();
        if (body === '{"case":"slow"}') return undefined;
        if (body === '{"case":"error"}') return res.writeHead(503).end('{"error":"busy"}');
        if (body === '{"case":"malformed"}') return res.writeHead(200).end('not json');
        if (body === '{"case":"large"}') return res.writeHead(200).end(JSON.stringify({ pad: 'x'.repeat(256) }));
        return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ranked_choices":[]}');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => { seen = []; });

  afterAll(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });

  function fakeTracing(headers = { traceparent: TRACEPARENT, tracestate: 'vendor=value', baggage: 'user=secret' }) {
    const calls = [];
    return {
      calls,
      startCall: jest.fn(details => {
        const call = { details, headers, end: jest.fn() };
        calls.push(call);
        return call;
      }),
    };
  }

  it('sends only W3C trace headers for traced operations and skips health checks', async () => {
    const tracing = fakeTracing();
    const client = createRoutingRouterClient({ baseUrl, tracing });
    const traceContext = { owned: true };
    const describeResult = jest.fn(() => ({ 'gh_aw_router.selected.model': 'provider/model' }));
    const attributes = { 'gh_aw_router.goal': 'cost' };

    await client.health({ timeoutMs: 1000, operation: 'route' });
    await client.capabilities({ timeoutMs: 1000, traceContext });
    await client.classify({ case: 'ok' }, { timeoutMs: 1000, operation: 'capabilities' });
    const route = await client.route({ case: 'ok' }, { timeoutMs: 1000, trace: { attributes, describeResult } });

    expect(tracing.calls.map(call => call.details)).toEqual([
      { operation: 'capabilities', method: 'GET', serverAddress: '127.0.0.1', serverPort: server.address().port,
        parentContext: traceContext, attributes: undefined },
      { operation: 'classify', method: 'POST', serverAddress: '127.0.0.1', serverPort: server.address().port,
        parentContext: undefined, attributes: undefined },
      { operation: 'route', method: 'POST', serverAddress: '127.0.0.1', serverPort: server.address().port,
        parentContext: undefined, attributes },
    ]);
    expect(seen[0].headers).not.toHaveProperty('traceparent');
    for (const request of seen.slice(1)) {
      expect(request.headers.traceparent).toBe(TRACEPARENT);
      expect(request.headers.tracestate).toBe('vendor=value');
      expect(request.headers).not.toHaveProperty('baggage');
    }
    expect(describeResult).toHaveBeenCalledWith(route);
    expect(tracing.calls[2].end.mock.calls).toEqual([[{
      statusCode: 200,
      error: undefined,
      attributes: { 'gh_aw_router.selected.model': 'provider/model' },
    }]]);
    for (const call of tracing.calls.slice(0, 2)) {
      expect(call.end.mock.calls).toEqual([[{ statusCode: 200, error: undefined, attributes: undefined }]]);
    }
  });

  it.each([
    ['a router error', { case: 'error' }, {}, { statusCode: 503 }, 503],
    ['a malformed response', { case: 'malformed' }, {}, { code: 'routing_contract_error' }, 200],
    ['an oversized response', { case: 'large' }, { maxResponseBytes: 64 }, { code: 'routing_contract_error' }, 200],
    ['a timeout', { case: 'slow' }, {}, { code: 'ETIMEDOUT' }, undefined],
  ])('ends the span once on %s without describing the result', async (_name, value, clientOptions, expected, status) => {
    const tracing = fakeTracing();
    const describeResult = jest.fn();
    const client = createRoutingRouterClient({ baseUrl, tracing, ...clientOptions });
    const error = await client.route(value, { timeoutMs: 200, trace: { describeResult } }).catch(err => err);

    expect(error).toMatchObject(expected);
    await new Promise(resolve => setImmediate(resolve));
    expect(tracing.calls[0].end.mock.calls).toEqual([[{ statusCode: status, error }]]);
    expect(describeResult).not.toHaveBeenCalled();
  });

  it('ends the span once when the call is cancelled or the router is unreachable', async () => {
    const tracing = fakeTracing();
    const controller = new AbortController();
    const client = createRoutingRouterClient({ baseUrl, tracing });
    const pending = client.classify({ case: 'slow' }, { timeoutMs: 5000, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    const cancelled = await pending.catch(err => err);
    expect(cancelled).toMatchObject({ code: 'routing_cancelled' });

    const closed = http.createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise(resolve => closed.close(resolve));
    const unreachable = await createRoutingRouterClient({ baseUrl: `http://127.0.0.1:${port}`, tracing })
      .capabilities({ timeoutMs: 1000 }).catch(err => err);
    expect(unreachable).toMatchObject({ code: 'ECONNREFUSED' });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(tracing.calls.map(call => call.end.mock.calls)).toEqual([
      [[{ statusCode: undefined, error: cancelled }]],
      [[{ statusCode: undefined, error: unreachable }]],
    ]);
  });

  it('records an attempt timer abort as a timeout without changing the cancellation error', async () => {
    const tracing = fakeTracing();
    const controller = new AbortController();
    const client = createRoutingRouterClient({ baseUrl, tracing });
    const pending = client.route({ case: 'slow' }, { timeoutMs: 5000, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort(new DOMException('attempt timed out', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({ code: 'routing_cancelled' });
    const [[ended]] = tracing.calls[0].end.mock.calls;
    expect(tracing.calls[0].end).toHaveBeenCalledTimes(1);
    expect(ended).toEqual({ statusCode: undefined, error: expect.objectContaining({ code: 'ETIMEDOUT' }) });
  });

  it('marks a hung router attempt as timed out when the planner timer fires', async () => {
    const tracing = fakeTracing();
    const client = createRoutingRouterClient({ baseUrl, tracing });
    const error = await runBoundedOperation(options => client.route({ case: 'slow' }, options), {
      deadline: Date.now() + 10_000,
      timeoutMs: 100,
      timeoutError: () => Object.assign(new Error('Router request timed out'), { code: 'ETIMEDOUT' }),
    }).catch(err => err);

    expect(error).toMatchObject({ code: 'ETIMEDOUT' });
    await new Promise(resolve => setImmediate(resolve));
    expect(tracing.calls[0].end.mock.calls).toEqual([[
      { statusCode: undefined, error: expect.objectContaining({ code: 'ETIMEDOUT' }) },
    ]]);
  });

  it('starts no span for a request rejected before it is sent', async () => {
    const tracing = fakeTracing();
    const client = createRoutingRouterClient({ baseUrl, tracing });
    const controller = new AbortController();
    controller.abort();
    await expect(client.route({}, { timeoutMs: 1000, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'routing_cancelled' });
    await expect(client.route({}, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'routing_configuration_error' });
    expect(tracing.startCall).not.toHaveBeenCalled();
  });

  it('keeps the routing result when tracing fails or is absent', async () => {
    const throwing = {
      startCall: jest.fn(() => ({ headers: { traceparent: 7 }, end: () => { throw new Error('end failed'); } })),
    };
    const describeResult = () => { throw new Error('describe failed'); };
    await expect(createRoutingRouterClient({ baseUrl, tracing: throwing })
      .route({ case: 'ok' }, { timeoutMs: 1000, trace: { describeResult } }))
      .resolves.toEqual({ ranked_choices: [] });
    await expect(createRoutingRouterClient({ baseUrl, tracing: { startCall: () => { throw new Error('start'); } } })
      .route({ case: 'ok' }, { timeoutMs: 1000 })).resolves.toEqual({ ranked_choices: [] });
    await expect(createRoutingRouterClient({ baseUrl }).route({ case: 'ok' }, { timeoutMs: 1000 }))
      .resolves.toEqual({ ranked_choices: [] });
    for (const request of seen) expect(request.headers).not.toHaveProperty('traceparent');
  });
});
