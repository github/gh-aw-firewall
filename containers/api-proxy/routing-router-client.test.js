'use strict';

const http = require('http');
const { createRoutingRouterClient } = require('./routing-router-client');

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
