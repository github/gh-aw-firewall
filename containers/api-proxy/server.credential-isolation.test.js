'use strict';

const http = require('http');
const net = require('net');
const zlib = require('zlib');

describe('upstream credential isolation (real provider server and CONNECT proxy)', () => {
  const servers = [];
  const sockets = new Set();
  const originalProxy = process.env.HTTPS_PROXY;
  let upstreamPort;
  let seen;
  let respond;
  let respondUpgrade;
  let createProviderServer;
  let adapters;
  let proxyAgent;
  let logLines;
  let logSpy;
  let configureFallbackProviders;
  const target = () => `http://127.0.0.1:${upstreamPort}`;

  async function listen(server) {
    servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  }

  beforeAll(async () => {
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(req.headers);
        respond(req, res);
      });
    });
    upstream.on('upgrade', (req, socket) => {
      seen.push(req.headers);
      respondUpgrade(req, socket);
    });
    upstreamPort = await listen(upstream);
    const forwardProxy = http.createServer();
    forwardProxy.on('connect', (req, downstream, head) => {
      if (req.url !== `127.0.0.1:${upstreamPort}`) return downstream.destroy();
      const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => downstream.destroy());
      downstream.on('error', () => upstream.destroy());
      downstream.on('close', () => upstream.destroy());
    });
    process.env.HTTPS_PROXY = `http://127.0.0.1:${await listen(forwardProxy)}`;
    jest.resetModules();
    ({ createProviderServer } = require('./server'));
    adapters = {
      openai: require('./providers/openai').createOpenAIAdapter,
      anthropic: require('./providers/anthropic').createAnthropicAdapter,
      copilot: require('./providers/copilot').createCopilotAdapter,
      foundry: require('./providers/foundry').createFoundryAdapter,
      ...require('./providers/google-adapter').GOOGLE_PROVIDER_ADAPTER_FACTORIES,
    };
    ({ configureFallbackProviders } = require('./proxy-request'));
    ({ proxyAgent } = require('./http-client'));
  });

  beforeEach(() => {
    seen = [];
    logLines = [];
    logSpy = jest.spyOn(process.stdout, 'write').mockImplementation(line => {
      logLines.push(String(line));
      return true;
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    configureFallbackProviders();
  });

  afterAll(async () => {
    proxyAgent?.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalProxy;
    jest.resetModules();
  });

  async function request(adapter, path = '/v1/chat/completions', { body, method = 'POST', onData } = {}) {
    const port = await listen(createProviderServer(adapter));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path, method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer CLIENT-PLACEHOLDER' },
        timeout: 3000,
      }, res => {
        const chunks = [];
        res.on('data', chunk => {
          chunks.push(chunk);
          onData?.(chunk, req);
        });
        res.on('error', reject);
        res.on('end', () => resolve({
          status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks),
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('local credential isolation test timed out')));
      req.end(['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(body || { messages: [{ role: 'user', content: 'hi' }] }));
    });
  }

  it('does not relay the injected bearer credential in an upstream 502 diagnostic', async () => {
    const secret = 'UPSTREAM-DUMMY-CRED';
    const body = JSON.stringify({ error: { message: `upstream saw auth=${secret}` } });
    respond = (_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    const adapter = adapters.openai({
      OPENAI_API_KEY: secret, OPENAI_API_TARGET: target(),
    });
    const response = await request(adapter);
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBe(`Bearer ${secret}`);
    expect(response.status).toBe(502);
    expect(response.body).toBe(JSON.stringify({ error: { message: `upstream saw auth=${'*'.repeat(secret.length)}` } }));
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(response.body)));
    expect(logLines.join('')).not.toContain(secret);
  });

  it.each([
    ['openai', 'OPENAI_API_KEY', 'OPENAI_API_TARGET', {}, 'authorization', 'Bearer ', '/v1/chat/completions'],
    ['openai', 'OPENAI_API_KEY', 'OPENAI_API_TARGET', { AWF_OPENAI_AUTH_HEADER: 'X-Private-Credential' }, 'x-private-credential', '', '/v1/chat/completions'],
    ['openai', 'COPILOT_PROVIDER_API_KEY', 'OPENAI_API_TARGET', { COPILOT_PROVIDER_TYPE: 'azure' }, 'api-key', '', '/v1/chat/completions'],
    ['anthropic', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_TARGET', {}, 'x-api-key', '', '/v1/messages'],
    ['anthropic', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_TARGET', { AWF_ANTHROPIC_AUTH_HEADER: 'X-Private-Credential' }, 'x-private-credential', '', '/v1/messages'],
    ['copilot', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_API_TARGET', {}, 'authorization', 'Bearer ', '/chat/completions'],
    ['gemini', 'GEMINI_API_KEY', 'GEMINI_API_TARGET', {}, 'x-goog-api-key', '', '/v1beta/models/test:generateContent'],
    ['vertex', 'GOOGLE_API_KEY', 'VERTEX_API_TARGET', {}, 'x-goog-api-key', '', '/v1/chat/completions'],
    ['foundry', 'FOUNDRY_API_KEY', 'FOUNDRY_API_TARGET', {}, 'api-key', '', '/providers/microsoft/v1/systemone'],
  ])('protects %s credentials injected through %s (%j)', async (provider, key, apiTarget, env, header, prefix, path) => {
    const secret = 'Synthetic-MiXeD-Credential-947';
    const lowerCaseControl = secret.toLowerCase();
    const body = JSON.stringify({ error: { code: 'invalid_key', message: `${secret} | ${lowerCaseControl}` } });
    respond = (_req, res) => {
      res.writeHead(400, {
        'content-type': 'application/json',
        'www-authenticate': `diagnostic="${secret}"`,
        'x-diagnostic': [secret, 'ordinary'],
        etag: '"original"',
      });
      res.end(body);
    };
    const response = await request(adapters[provider]({ ...env, [key]: secret, [apiTarget]: target() }), path);
    expect(seen).toHaveLength(1);
    expect(seen[0][header]).toBe(`${prefix}${secret}`);
    expect(response.status).toBe(400);
    expect(response.body).toBe(body.replace(secret, '*'.repeat(secret.length)));
    expect(response.headers['www-authenticate']).toBe(`diagnostic="${'*'.repeat(secret.length)}"`);
    expect(response.headers['x-diagnostic']).toBe(`${'*'.repeat(secret.length)}, ordinary`);
    expect(response.headers.etag).toBeUndefined();
    expect(logLines.join('')).not.toContain(secret);
    const record = logLines.map(line => JSON.parse(line)).find(line => line.event === 'upstream_error_response');
    expect(record.error_code).toBe('invalid_key');
  });

  it.each([
    ['gzip', zlib.gzipSync, zlib.gunzipSync],
    ['deflate', zlib.deflateSync, zlib.inflateSync],
    ['br', zlib.brotliCompressSync, zlib.brotliDecompressSync],
  ])('masks compressed %s errors and updates framing', async (encoding, compress, decompress) => {
    const secret = 'Compressed-DUMMY-Credential';
    const original = JSON.stringify({ error: { message: `echo ${secret}` } });
    const encoded = compress(Buffer.from(original));
    respond = (_req, res) => {
      res.writeHead(401, {
        'content-type': 'application/json', 'content-encoding': encoding,
        'content-length': encoded.length, digest: 'original-digest',
      });
      for (let i = 0; i < encoded.length; i++) res.write(encoded.subarray(i, i + 1));
      res.end();
    };
    const response = await request(adapters.openai({ OPENAI_API_KEY: secret, OPENAI_API_TARGET: target() }));
    expect(seen[0].authorization).toBe(`Bearer ${secret}`);
    expect(response.status).toBe(401);
    expect(response.headers['content-encoding']).toBe(encoding);
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers.digest).toBeUndefined();
    expect(decompress(response.bytes).toString()).toBe(original.replace(secret, '*'.repeat(secret.length)));
    expect(logLines.join('')).not.toContain(secret);
  });

  it('masks credentials split across source chunks and the oversized buffered-400 boundary', async () => {
    const secret = 'Split-DUMMY-Credential';
    const body = `${'a'.repeat(65530)}${secret} end`;
    respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.write(body.slice(0, 65536));
      setImmediate(() => res.end(body.slice(65536)));
    };
    const response = await request(adapters.anthropic({
      ANTHROPIC_API_KEY: secret, ANTHROPIC_API_TARGET: target(),
    }), '/v1/messages');
    expect(seen[0]['x-api-key']).toBe(secret);
    expect(response.status).toBe(400);
    expect(response.body).toBe(body.replace(secret, '*'.repeat(secret.length)));
    expect(logLines.join('')).not.toContain(secret);
  });

  it.each(['corrupt', 'truncated'])('terminates %s compressed responses without disclosing credentials', async kind => {
    const metrics = require('./metrics');
    const activeBefore = metrics.getSummary().active_requests;
    const secret = 'Broken-Gzip-DUMMY-Credential';
    const compressed = zlib.gzipSync(Buffer.from(`echo ${secret}`));
    const encoded = kind === 'corrupt' ? Buffer.from('not a gzip stream') : compressed.subarray(0, -4);
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(encoded);
    };
    const received = [];
    await expect(request(adapters.openai({
      OPENAI_API_KEY: secret, OPENAI_API_TARGET: target(),
    }), undefined, { onData: chunk => received.push(chunk) })).rejects.toThrow(/aborted|socket hang up/);
    expect(seen[0].authorization).toBe(`Bearer ${secret}`);
    expect(Buffer.concat(received).toString()).not.toContain(secret);
    expect(logLines.join('')).not.toContain(secret);
    expect(logLines.map(line => JSON.parse(line)).some(line => line.event === 'request_error')).toBe(true);
    await new Promise(setImmediate);
    expect(metrics.getSummary().active_requests).toBe(activeBefore);
  });

  it('preserves successful JSON and UTF-8 output exactly', async () => {
    const body = '{"choices":[{"message":{"content":"ordinary output: café"}}]}';
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    const response = await request(adapters.openai({
      OPENAI_API_KEY: 'Success-DUMMY-Credential', OPENAI_API_TARGET: target(),
    }));
    expect(response.status).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(body)));
  });

  it.each([
    ['HEAD', 200], ['GET', 204], ['GET', 205], ['GET', 304],
  ])('preserves bodyless %s/%i responses with representation encoding metadata', async (method, status) => {
    const secret = 'Bodyless-DUMMY-Credential';
    respond = (_req, res) => {
      res.writeHead(status, {
        'content-encoding': 'gzip', 'x-diagnostic': secret,
        ...(status === 200 ? { 'content-length': 123 } : {}),
      });
      res.end();
    };
    const response = await request(adapters.openai({
      OPENAI_API_KEY: secret, OPENAI_API_TARGET: target(),
    }), '/v1/models', { method });
    expect(seen[0].authorization).toBe(`Bearer ${secret}`);
    expect(response.status).toBe(status);
    expect(response.body).toBe('');
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['x-diagnostic']).toBe('*'.repeat(secret.length));
    if (method === 'HEAD') expect(response.headers['content-length']).toBe('123');
  });

  it.each(['identity', 'gzip', 'deflate', 'br'])('preserves live %s SSE and masks embedded error events', async encoding => {
    const secret = 'Stream-DUMMY-Credential';
    const first = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
    const last = `event: error\ndata: {"error":{"message":"${secret}"}}\n\ndata: [DONE]\n\n`;
    let finish;
    respond = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        ...(encoding === 'identity' ? {} : { 'content-encoding': encoding }),
      });
      const output = encoding === 'identity' ? res : ({
        gzip: zlib.createGzip, deflate: zlib.createDeflate, br: zlib.createBrotliCompress,
      })[encoding]();
      if (output !== res) output.pipe(res);
      output.write(first);
      if (output !== res) output.flush();
      finish = () => output.end(last);
    };
    let earlyBytes = 0;
    const response = await request(adapters.openai({ OPENAI_API_KEY: secret, OPENAI_API_TARGET: target() }), undefined, {
      body: { stream: true, messages: [] },
      onData: chunk => {
        earlyBytes += chunk.length;
        if (finish) { const end = finish; finish = null; end(); }
      },
    });
    const decoded = encoding === 'identity' ? response.bytes
      : ({ gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync })[encoding](response.bytes);
    expect(earlyBytes).toBeGreaterThan(0);
    expect(response.status).toBe(200);
    expect(decoded.toString()).toBe(first + last.replace(secret, '*'.repeat(secret.length)));
  });

  it('uses the dynamically resolved OIDC token, not environment-name redaction', async () => {
    const secret = 'OIDC-Renewed-DUMMY-Credential';
    const adapter = adapters.openai({
      AWF_AUTH_TYPE: 'github-oidc', AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://127.0.0.1/unused',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'unused-bootstrap-marker',
      AWF_AUTH_AZURE_TENANT_ID: 'dummy-tenant', AWF_AUTH_AZURE_CLIENT_ID: 'dummy-client',
      OPENAI_API_TARGET: target(),
    });
    // Replace only the external token acquisition boundary; real adapters,
    // injected headers, transport, response handling and diagnostics run intact.
    adapter.getOidcProvider().isReady = () => true;
    adapter.getOidcProvider().getToken = () => secret;
    respond = (_req, res) => res.writeHead(403, { 'content-type': 'text/plain' }).end(`echo ${secret}`);
    const response = await request(adapter);
    expect(seen[0].authorization).toBe(`Bearer ${secret}`);
    expect(response.status).toBe(403);
    expect(response.body).toBe(`echo ${'*'.repeat(secret.length)}`);
    expect(logLines.join('')).not.toContain(secret);
  });

  it('protects trusted-service secret headers alongside provider credentials', async () => {
    const secret = 'Trusted-Header-DUMMY';
    const providerKey = 'Trusted-Provider-DUMMY';
    const service = require('./trusted-service').readTrustedService({
      AWF_OPENAI_TRUSTED_SERVICE: JSON.stringify({
        endpoint: 'https://synthetic.example', secretHeaders: { 'x-private-secret': 'SYNTHETIC_SECRET' },
      }),
      SYNTHETIC_SECRET: secret,
    }, 'openai');
    const adapter = adapters.openai({ OPENAI_API_KEY: providerKey, OPENAI_API_TARGET: target() });
    const getAuthHeaders = adapter.getAuthHeaders;
    // Keep service validation/injection intact; only its destination is local.
    adapter.getAuthHeaders = req => service.inject(getAuthHeaders(req));
    respond = (_req, res) => res.writeHead(502, { 'content-type': 'text/plain' }).end(`${secret} ${providerKey}`);
    const response = await request(adapter);
    expect(seen[0]['x-private-secret']).toBe(secret);
    expect(seen[0].authorization).toBe(`Bearer ${providerKey}`);
    expect(response.body).toBe(`${'*'.repeat(secret.length)} ${'*'.repeat(providerKey.length)}`);
    expect(logLines.join('')).not.toContain(secret);
    expect(logLines.join('')).not.toContain(providerKey);
  });

  it('protects dynamically generated final AWS signing headers and their credential components', async () => {
    const { signAwsRequest } = require('./aws-sigv4');
    const credentials = {
      accessKeyId: 'LOCAL-DUMMY-ACCESS', secretAccessKey: 'LOCAL-DUMMY-SIGNING-SECRET',
      sessionToken: 'LOCAL-DUMMY-SESSION',
    };
    const adapter = adapters.openai({ OPENAI_API_KEY: 'unused-placeholder', OPENAI_API_TARGET: target() });
    adapter.getAuthHeaders = () => ({});
    adapter.getRequestSigner = () => signingRequest => signAwsRequest({
      ...signingRequest, credentials, region: 'us-east-1',
    });
    respond = (req, res) => res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({
      error: {
        message: req.headers.authorization,
        access_key: credentials.accessKeyId,
        signature: /Signature=([a-f0-9]+)/.exec(req.headers.authorization)[1],
        session: req.headers['x-amz-security-token'],
      },
    }));
    const response = await request(adapter);
    expect(seen[0].authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=LOCAL-DUMMY-ACCESS\//);
    expect(seen[0]['x-amz-security-token']).toBe(credentials.sessionToken);
    expect(JSON.stringify(seen)).not.toContain(credentials.secretAccessKey);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        message: '*'.repeat(seen[0].authorization.length),
        access_key: '*'.repeat(credentials.accessKeyId.length),
        signature: '*'.repeat(64), session: '*'.repeat(credentials.sessionToken.length),
      },
    });
    expect(logLines.join('')).not.toContain(credentials.accessKeyId);
    expect(logLines.join('')).not.toContain(credentials.sessionToken);
  });

  it('protects the fresh token resolved immediately before a renewable-auth attempt', async () => {
    const stale = 'Renewable-Initial-DUMMY';
    const fresh = 'Renewable-Fresh-DUMMY';
    const adapter = adapters.openai({ OPENAI_API_KEY: stale, OPENAI_API_TARGET: target() });
    let resolutions = 0;
    adapter.renewableAuth = true;
    adapter.getAuthHeaders = async () => ({ Authorization: `Bearer ${++resolutions === 1 ? stale : fresh}` });
    configureFallbackProviders({ getAdapter: () => adapter });
    respond = (_req, res) => res.writeHead(401, { 'content-type': 'text/plain' }).end(`${fresh} ${stale}`);
    const response = await request(adapter);
    expect(resolutions).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBe(`Bearer ${fresh}`);
    expect(response.body).toBe(`${'*'.repeat(fresh.length)} ${'*'.repeat(stale.length)}`);
    expect(logLines.join('')).not.toContain(fresh);
  });

  it('protects both credentials after a cross-provider fallback', async () => {
    const first = 'Fallback-OpenAI-DUMMY';
    const second = 'Fallback-Anthropic-DUMMY';
    const originalFallback = process.env.AWF_FALLBACK_MODELS;
    process.env.AWF_FALLBACK_MODELS = 'anthropic/claude-sonnet-4.6';
    const openai = adapters.openai({ OPENAI_API_KEY: first, OPENAI_API_TARGET: target() });
    const anthropic = adapters.anthropic({ ANTHROPIC_API_KEY: second, ANTHROPIC_API_TARGET: target() });
    configureFallbackProviders({ getAdapter: provider => ({ openai, anthropic })[provider] });
    respond = (req, res) => {
      res.writeHead(req.headers.authorization ? 503 : 429, { 'content-type': 'text/plain' });
      res.end(`diagnostic ${first} ${second}`);
    };
    try {
      const response = await request(openai, undefined, { body: { model: 'gpt-5.4', messages: [] } });
      expect(seen).toHaveLength(2);
      expect(seen[0].authorization).toBe(`Bearer ${first}`);
      expect(seen[1]['x-api-key']).toBe(second);
      expect(response.status).toBe(429);
      expect(response.body).toBe(`diagnostic ${'*'.repeat(first.length)} ${'*'.repeat(second.length)}`);
      expect(logLines.join('')).not.toContain(first);
      expect(logLines.join('')).not.toContain(second);
    } finally {
      if (originalFallback === undefined) delete process.env.AWF_FALLBACK_MODELS;
      else process.env.AWF_FALLBACK_MODELS = originalFallback;
    }
  });

  it('masks JSON-escaped credential values without corrupting the JSON envelope', async () => {
    const secret = 'JSON-"DUMMY-\\Credential';
    const body = JSON.stringify({ error: { message: `echo ${secret}` } });
    respond = (_req, res) => res.writeHead(502, { 'content-type': 'application/json' }).end(body);
    const response = await request(adapters.openai({ OPENAI_API_KEY: secret, OPENAI_API_TARGET: target() }));
    expect(seen[0].authorization).toBe(`Bearer ${secret}`);
    expect(response.body).toBe(body.replace(JSON.stringify(secret).slice(1, -1), '*'.repeat(JSON.stringify(secret).length - 2)));
    expect(JSON.parse(response.body).error.message).not.toContain(secret);
    expect(logLines.join('')).not.toContain(JSON.stringify(secret).slice(1, -1));
  });

  it('closes the synthetic upstream when the client aborts a protected stream', async () => {
    const metrics = require('./metrics');
    const activeBefore = metrics.getSummary().active_requests;
    let upstreamClosed;
    const closed = new Promise(resolve => { upstreamClosed = resolve; });
    respond = (_req, res) => {
      res.once('close', upstreamClosed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    };
    await expect(request(adapters.openai({
      OPENAI_API_KEY: 'Cancellation-DUMMY-Credential', OPENAI_API_TARGET: target(),
    }), undefined, { onData: (_chunk, req) => req.destroy() })).rejects.toThrow();
    await closed;
    await new Promise(setImmediate);
    expect(metrics.getSummary().active_requests).toBe(activeBefore);
  });

  function frame(opcode, payload, fin = true) {
    const bytes = Buffer.from(payload);
    if (bytes.length > 125) throw new Error('test frame must be short');
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, bytes.length]), bytes]);
  }

  async function upgrade(adapter) {
    const port = await listen(createProviderServer(adapter));
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(
        'GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n'
      ));
      socket.setTimeout(3000, () => socket.destroy(new Error('local WebSocket isolation test timed out')));
      const chunks = [];
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  it('masks real WebSocket handshake, fragmented error-message and close-reason echoes', async () => {
    const secret = 'WS-DUMMY-Credential';
    const prefix = 'event: error ';
    const split = 7;
    const handshake = `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Diagnostic: ${secret}\r\n\r\n`;
    const wire = [
      frame(1, prefix + secret.slice(0, split), false),
      frame(9, 'ordinary ping'),
      frame(0, secret.slice(split)),
      frame(8, Buffer.concat([Buffer.from([0x03, 0xf3]), Buffer.from(secret)])),
    ];
    respondUpgrade = (_req, socket) => {
      socket.write(handshake.slice(0, handshake.length - 8));
      setImmediate(() => socket.end(Buffer.concat([Buffer.from(handshake.slice(-8)), ...wire])));
    };
    const response = await upgrade(adapters.openai({ OPENAI_API_KEY: secret, OPENAI_API_TARGET: target() }));
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBe(`Bearer ${secret}`);
    expect(seen[0]['sec-websocket-extensions']).toBeUndefined();
    const mask = '*'.repeat(secret.length);
    expect(response).toEqual(Buffer.concat([
      Buffer.from(handshake.replace(secret, mask)),
      frame(1, prefix + mask.slice(0, split), false),
      frame(9, 'ordinary ping'),
      frame(0, mask.slice(split)),
      frame(8, Buffer.concat([Buffer.from([0x03, 0xf3]), Buffer.from(mask)])),
    ]));
    expect(logLines.join('')).not.toContain(secret);
  });

  it('ends a rejected WebSocket upgrade even if the upstream keeps its diagnostic socket open', async () => {
    const secret = 'WS-Rejected-DUMMY-Credential';
    const body = zlib.gzipSync(Buffer.from(`echo ${secret}`));
    respondUpgrade = (_req, socket) => socket.write(Buffer.concat([
      Buffer.from(`HTTP/1.1 401 ${secret}\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n`),
      body,
    ]));
    const response = await upgrade(adapters.openai({ OPENAI_API_KEY: secret, OPENAI_API_TARGET: target() }));
    expect(seen[0].authorization).toBe(`Bearer ${secret}`);
    expect(response.toString()).toBe('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    expect(logLines.join('')).not.toContain(secret);
  });
  it('fails explicitly without forwarding unsupported compressed diagnostics', async () => {
    const secret = 'Unsupported-Encoding-DUMMY';
    respond = (_req, res) => res.writeHead(502, { 'content-encoding': 'unknown' }).end(secret);
    const response = await request(adapters.openai({ OPENAI_API_KEY: secret, OPENAI_API_TARGET: target() }));
    expect(seen[0].authorization).toBe(`Bearer ${secret}`);
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Upstream response could not be safely inspected',
      message: 'Unsupported upstream response content encoding',
    });
    expect(logLines.join('')).not.toContain(secret);
  });
});
