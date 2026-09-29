'use strict';

const http = require('http');
const zlib = require('zlib');
const {
  DEFAULT_INSTALLED_VERSION,
  createShimHandler,
  isMetaRequest,
  parseGhHost,
  patchMetaBody,
} = require('./gh-http-shim');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port, { method = 'GET', path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('gh-http-shim helpers', () => {
  it.each([
    ['GET', '/api/v3/meta', true],
    ['GET', '/api/v3/meta?foo=bar', true],
    ['POST', '/api/v3/meta', false],
    ['GET', '/api/v3/meta/extra', false],
    ['GET', '/api/v3/repos/o/r', false],
    ['GET', '/meta', false],
  ])('isMetaRequest(%s, %s) → %s', (method, url, expected) => {
    expect(isMetaRequest(method, url)).toBe(expected);
  });

  it('adds installed_version when missing or empty', () => {
    const patched = JSON.parse(patchMetaBody(Buffer.from('{"hooks":["1.2.3.4/32"]}'), '999.0.0').toString());
    expect(patched).toEqual({ hooks: ['1.2.3.4/32'], installed_version: '999.0.0' });
    const empty = JSON.parse(patchMetaBody(Buffer.from('{"installed_version":""}'), '999.0.0').toString());
    expect(empty.installed_version).toBe('999.0.0');
  });

  it('keeps an existing installed_version and non-object bodies unchanged', () => {
    for (const raw of ['{"installed_version":"3.18.0"}', '[1,2]', 'not json', 'null']) {
      const body = Buffer.from(raw);
      expect(patchMetaBody(body, '999.0.0')).toBe(body);
    }
  });

  it('parses GH_HOST values into upstream targets', () => {
    expect(parseGhHost('localhost:18443')).toEqual({ host: 'localhost', port: 18443, servername: 'localhost' });
    expect(parseGhHost('127.0.0.1:18443')).toEqual({ host: '127.0.0.1', port: 18443 });
    expect(parseGhHost('[::1]:18443')).toEqual({ host: '::1', port: 18443 });
    expect(parseGhHost('proxy.internal')).toEqual({ host: 'proxy.internal', port: 443, servername: 'proxy.internal' });
    expect(() => parseGhHost('')).toThrow('GH_HOST is not set');
    expect(() => parseGhHost(undefined)).toThrow('GH_HOST is not set');
  });
});

describe('gh-http-shim forwarding', () => {
  let upstream;
  let upstreamPort;
  let shim;
  let shimPort;
  let upstreamRequests;
  let upstreamHandler;

  beforeEach(async () => {
    upstreamRequests = [];
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        upstreamRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        upstreamHandler(req, res);
      });
    });
    upstreamPort = await listen(upstream);
    shim = http.createServer(createShimHandler(
      { host: '127.0.0.1', port: upstreamPort },
      { requestFn: http.request },
    ));
    shimPort = await listen(shim);
  });

  afterEach(async () => {
    await close(shim);
    if (upstream.listening) await close(upstream);
  });

  it('injects installed_version into /api/v3/meta responses', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"verifiable_password_authentication":false}');
    };

    const res = await request(shimPort, { path: '/api/v3/meta', headers: { 'accept-encoding': 'gzip' } });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString());
    expect(body).toEqual({ verifiable_password_authentication: false, installed_version: DEFAULT_INSTALLED_VERSION });
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
    expect(upstreamRequests[0].headers['accept-encoding']).toBe('identity');
  });

  it('passes compressed /meta responses through unchanged', async () => {
    const compressed = zlib.gzipSync('{"a":1}');
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(compressed);
    };

    const res = await request(shimPort, { path: '/api/v3/meta' });

    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.equals(compressed)).toBe(true);
  });

  it('passes non-2xx /meta responses through unchanged', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"message":"denied"}');
    };

    const res = await request(shimPort, { path: '/api/v3/meta' });

    expect(res.status).toBe(403);
    expect(res.body.toString()).toBe('{"message":"denied"}');
  });

  it('forwards other requests, headers, and bodies unchanged', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-custom': 'yes' });
      res.end('{"created":true}');
    };

    const res = await request(shimPort, {
      method: 'POST',
      path: '/api/graphql?x=1',
      body: '{"query":"{viewer{login}}"}',
      headers: { authorization: 'token abc', 'content-type': 'application/json', 'accept-encoding': 'gzip' },
    });

    expect(res.status).toBe(201);
    expect(res.headers['x-custom']).toBe('yes');
    expect(res.body.toString()).toBe('{"created":true}');
    expect(upstreamRequests[0]).toMatchObject({
      method: 'POST',
      url: '/api/graphql?x=1',
      body: '{"query":"{viewer{login}}"}',
    });
    expect(upstreamRequests[0].headers.authorization).toBe('token abc');
    expect(upstreamRequests[0].headers['accept-encoding']).toBe('gzip');
  });

  it('returns 502 when the upstream is unreachable', async () => {
    await close(upstream);

    const res = await request(shimPort, { path: '/api/v3/repos/o/r' });

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body.toString()).message).toMatch(/could not reach DIFC proxy/);
  });
});
