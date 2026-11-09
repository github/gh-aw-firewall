'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const { execFileSync } = require('child_process');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { createAnthropicAdapter } = require('./providers/anthropic');
const { createOpenAIAdapter } = require('./providers/openai');
const { TRUSTED_SERVICE } = require('./trusted-service');

const config = {
  endpoint: 'https://trusted.service.test/corporate',
  secretHeaders: { 'X-Corporate-Secret': 'CORPORATE_SECRET' },
};
const credentials = {
  ANTHROPIC_API_KEY: 'testPREVIEW-do-not-log-END9',
  OPENAI_API_KEY: 'testPREVIEW-do-not-log-END9',
  CORPORATE_SECRET: 'supplemental-sensitive-value',
  AWF_ANTHROPIC_TRUSTED_SERVICE: JSON.stringify(config),
  AWF_OPENAI_TRUSTED_SERVICE: JSON.stringify(config),
};

describe('trusted service adapters', () => {
  it.each([['anthropic', createAnthropicAdapter], ['openai', createOpenAIAdapter]])(
    'injects supplemental headers into %s auth and model discovery only in the trusted adapter',
    (provider, create) => {
      const adapter = create(credentials);
      expect(adapter.getTargetHost()).toBe('trusted.service.test');
      expect(adapter.getTargetScheme()).toBe('https');
      expect(adapter.getBasePath()).toBe('/corporate');
      expect(adapter.getAuthHeaders({ headers: {} })).toMatchObject({
        'x-corporate-secret': credentials.CORPORATE_SECRET, [TRUSTED_SERVICE]: true,
      });
      expect(adapter.getModelsFetchConfig().opts.headers['x-corporate-secret']).toBe(credentials.CORPORATE_SECRET);
      expect(JSON.stringify(adapter.getReflectionInfo())).not.toContain(credentials.CORPORATE_SECRET);
      expect(JSON.stringify(adapter.getReflectionInfo())).not.toContain(credentials.ANTHROPIC_API_KEY);
      expect(adapter.trustedService).toBe(true);
    });

  it.each([
    { endpoint: 'http://trusted.service.test' },
    { endpoint: 'https://trusted.service.test:444' },
    { endpoint: 'https://trusted.service.test/a/../b' },
    { endpoint: 'https://trusted.service.test/%2e%2e' },
    { endpoint: 'https://trusted.service.test/?q=secret' },
    { endpoint: 'https://api.localhost' },
    { endpoint: 'https://host.docker.internal' },
    { secretHeaders: { Authorization: 'CORPORATE_SECRET' } },
    { secretHeaders: { 'Proxy-Foo': 'CORPORATE_SECRET' } },
    { secretHeaders: { 'x-forwarded-host': 'CORPORATE_SECRET' } },
    { secretHeaders: { Host: 'CORPORATE_SECRET' } },
    { secretHeaders: { 'content-length': 'CORPORATE_SECRET' } },
    { secretHeaders: { 'x-corp': 'NODE_OPTIONS' } },
    { secretHeaders: { 'x-corp': 'MISSING_SECRET' } },
    { secretHeaders: { 'x-corp': 'CORPORATE_SECRET', 'X-Corp': 'CORPORATE_SECRET' } },
  ])('fails startup closed on invalid trusted configuration %j', override => {
    expect(() => createAnthropicAdapter({
      ...credentials, AWF_ANTHROPIC_TRUSTED_SERVICE: JSON.stringify({ ...config, ...override }),
    })).toThrow(/trustedService/);
  });

  it('rejects custom auth header collisions and header-value injection without reflecting secrets', () => {
    expect(() => createAnthropicAdapter({
      ...credentials, AWF_ANTHROPIC_AUTH_HEADER: 'X-Corporate-Secret',
    })).toThrow(/trustedService/);
    expect(() => createAnthropicAdapter({
      ...credentials, AWF_ANTHROPIC_AUTH_HEADER: ' X-Corporate-Secret ',
    })).toThrow(/trustedService/);
    expect(() => createAnthropicAdapter({ ...credentials, CORPORATE_SECRET: 'value\r\ninjected: header' }))
      .toThrow('Invalid trustedService configuration or missing runner secret');
    expect(() => createAnthropicAdapter({ ...credentials, CORPORATE_SECRET: '' })).toThrow(/trustedService/);
  });

  it.each([
    [' GitHub-OIDC ', ' AWS '],
    ['GITHUB-OIDC', 'GCP'],
  ])('rejects normalized unsupported OIDC selector pair %j/%j', (authType, authProvider) => {
    expect(() => createAnthropicAdapter({
      ...credentials,
      AWF_AUTH_TYPE: authType,
      AWF_AUTH_PROVIDER: authProvider,
    })).toThrow(/trustedService/);
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029', '\t', ' ', '\0'])(
    'fails startup closed on whitespace/control-padded endpoint, header and source names: %j', padding => {
      for (const prefix of [true, false]) {
        const pad = value => prefix ? padding + value : value + padding;
        const name = pad('CORPORATE_SECRET');
        for (const override of [
          { endpoint: pad('https://trusted.service.test') },
          { secretHeaders: { [pad('authorization')]: 'CORPORATE_SECRET' } },
          { secretHeaders: { [pad('x-corp')]: 'CORPORATE_SECRET' } },
          { secretHeaders: { 'x-corp': name } },
        ]) {
          expect(() => createAnthropicAdapter({
            ...credentials, [name]: 'present-but-invalid-source-name',
            AWF_ANTHROPIC_TRUSTED_SERVICE: JSON.stringify({ ...config, ...override }),
          })).toThrow(/trustedService/);
        }
      }
    },
  );

  it('redacts known supplemental and provider credentials in nested log fields', () => {
    createAnthropicAdapter(credentials).getAuthHeaders({ headers: {} });
    const output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      require('./logging').logRequest('error', 'test', {
        error: `prefix-${credentials.CORPORATE_SECRET}`,
        nested: { value: credentials.CORPORATE_SECRET, provider: credentials.ANTHROPIC_API_KEY },
      });
      expect(output.mock.calls[0][0]).not.toContain(credentials.CORPORATE_SECRET);
      expect(output.mock.calls[0][0]).not.toContain(credentials.ANTHROPIC_API_KEY);
      expect(output.mock.calls[0][0]).toContain('[REDACTED]');
    } finally { output.mockRestore(); }
  });

  it('fails WebSocket upgrades closed rather than using an unverified alternate transport', () => {
    const adapter = createOpenAIAdapter(credentials);
    const dispatch = jest.fn();
    const socket = { write: jest.fn(), destroy: jest.fn() };
    require('./server-factory').createWebSocketUpgradeHandler(adapter, dispatch)(
      { method: 'GET', url: '/v1/realtime', headers: {} }, socket, Buffer.alloc(0),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('503'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('removes mixed-case spoofed duplicates without logging provider credential fragments', () => {
    const adapter = createAnthropicAdapter(credentials);
    const output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { buildRequestHeaders } = require('./request-headers');
      const headers = buildRequestHeaders(Buffer.alloc(0), 0, {
        headers: {
          'x-corporate-secret': 'spoofed-lower',
          'X-Corporate-Secret': 'spoofed-mixed',
          'X-API-Key': 'spoofed-provider',
        },
      }, {
        injectHeaders: adapter.getAuthHeaders({ headers: {} }),
        provider: 'anthropic', targetHost: adapter.getTargetHost(), requestId: 'trusted-headers-test',
      });
      expect(Object.keys(headers).filter(name => name.toLowerCase() === 'x-corporate-secret'))
        .toEqual(['x-corporate-secret']);
      expect(headers['x-corporate-secret']).toBe(credentials.CORPORATE_SECRET);
      expect(headers['x-api-key']).toBe(credentials.ANTHROPIC_API_KEY);
      expect(headers['X-API-Key']).toBeUndefined();
      const logs = output.mock.calls.map(call => JSON.parse(call[0]));
      expect(logs.some(log => log.event === 'auth_inject')).toBe(false);
      expect(JSON.stringify(logs)).not.toContain(credentials.ANTHROPIC_API_KEY.slice(0, 8));
      expect(JSON.stringify(logs)).not.toContain(credentials.ANTHROPIC_API_KEY.slice(-4));
      expect(JSON.stringify(logs)).not.toContain('key_preview');
    } finally { output.mockRestore(); }
  });

  it('never learns or strips trusted supplemental/provider headers, including cached and retry paths', () => {
    const tracker = require('./deprecated-header-tracker');
    tracker.resetDeprecatedHeaderValuesForTests();
    const adapter = createAnthropicAdapter(credentials);
    tracker.getDeprecatedValuesForHeader('x-corporate-secret').add(credentials.CORPORATE_SECRET);
    tracker.getDeprecatedValuesForHeader('x-api-key').add(credentials.ANTHROPIC_API_KEY);
    try {
      const headers = require('./request-headers').buildRequestHeaders(Buffer.alloc(0), 0, {
        headers: {},
      }, {
        injectHeaders: adapter.getAuthHeaders({ headers: {} }),
        provider: 'anthropic', targetHost: adapter.getTargetHost(), requestId: 'trusted-learning-test',
      });
      expect(headers['x-corporate-secret']).toBe(credentials.CORPORATE_SECRET);
      expect(headers['x-api-key']).toBe(credentials.ANTHROPIC_API_KEY);
      for (const [name, value] of [['x-corporate-secret', credentials.CORPORATE_SECRET],
        ['x-api-key', credentials.ANTHROPIC_API_KEY]]) {
        const retryHeaders = { ...headers };
        expect(tracker.learnAndStripDeprecatedHeaderValue(retryHeaders, name, value, 'test', 'anthropic')).toBeNull();
        expect(retryHeaders[name]).toBe(value);
        expect(tracker.learnAndStripDeprecatedHeaderValue(retryHeaders, name.toUpperCase(), value, 'test', 'anthropic')).toBeNull();
      }
    } finally { tracker.resetDeprecatedHeaderValuesForTests(); }
  });
});

describe('actual AWF -> CONNECT proxy -> verified HTTPS service -> provider chain', () => {
  const savedEnv = { ...process.env };
  const servers = [];
  const sockets = new Set();
  let cert, tlsService, provider, connectProxy, agentServer, openaiServer, proxyRequest, guards;
  let serviceCalls, providerCalls, tunnels, behavior, trustCertificate, failConnect, fallbackLookup;
  let stdoutSpy;
  const realHttpsRequest = https.request;

  async function listen(server) {
    servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  }

  async function request(body, headers = {}, url = '/v1/messages', server = agentServer) {
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: url, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(data);
    });
  }

  beforeAll(async () => {
    let pem;
    try {
      pem = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', '-',
        '-days', '1', '-subj', '/CN=trusted.service.test', '-addext', 'subjectAltName=DNS:trusted.service.test',
      ], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    } catch {
      throw new Error('Could not generate the in-memory TLS fixture');
    }
    cert = Buffer.from(pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0]);
    const key = Buffer.from(pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)[0]);
    provider = http.createServer((req, res) => {
      providerCalls.push({ headers: req.headers, url: req.url });
      req.resume();
      if (behavior === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":1}}}\n\n');
        setImmediate(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      } else {
        res.writeHead(behavior === 'error' ? 503 : 200, { 'content-type': 'application/json' });
        res.end(behavior === 'error' ? '{"error":{"message":"provider unavailable"}}'
          : '{"id":"msg_test","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');
      }
    });
    await listen(provider);
    tlsService = https.createServer({
      key, cert,
    }, (req, res) => {
      serviceCalls.push({ headers: req.headers, url: req.url });
      if (behavior === 'redirect' || behavior === 'redirect-abort') {
        req.resume();
        res.writeHead(307, {
          location: 'https://unapproved.example/v1/messages',
          ...(behavior === 'redirect-abort' ? { 'content-length': '1000' } : {}),
        });
        if (behavior === 'redirect-abort') {
          res.write('truncated body');
          setTimeout(() => res.destroy(), 20);
          return;
        }
        res.end();
        return;
      }
      const forwarded = http.request({
        hostname: '127.0.0.1', port: provider.address().port, method: req.method,
        path: req.url, headers: req.headers,
      }, upstream => {
        res.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(res);
      });
      req.pipe(forwarded);
    });
    await listen(tlsService);
    connectProxy = http.createServer();
    connectProxy.on('connect', (req, socket, head) => {
      tunnels.push(req.url);
      if (req.url !== 'trusted.service.test:443' || failConnect) {
        socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const upstream = net.connect(tlsService.address().port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    const proxyPort = await listen(connectProxy);
    process.env = { ...savedEnv, AWF_ALLOWED_MODELS: JSON.stringify(['claude-sonnet-4-5', 'gpt-4o']) };
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_MAX_RUNS;
    delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    delete process.env.AWF_API_PROXY_PROVIDERS;
    jest.resetModules();
    const proxyAgent = new HttpsProxyAgent(`http://127.0.0.1:${proxyPort}`);
    jest.doMock('./http-client', () => ({ proxyAgent, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }));
    jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      expect(options.rejectUnauthorized).toBe(true);
      return realHttpsRequest.call(https, { ...options, ...(trustCertificate ? { ca: cert } : {}) }, callback);
    });
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    ({ proxyRequest } = require('./proxy-request'));
    const fallbackAdapter = require('./providers/openai').createOpenAIAdapter({
      OPENAI_API_KEY: 'alternate-provider-credential', OPENAI_API_TARGET: 'alternate.provider.test',
    });
    fallbackLookup = jest.fn(provider => provider === 'openai' ? fallbackAdapter : null);
    require('./proxy-request').configureFallbackProviders({ getAdapter: fallbackLookup });
    guards = {
      runs: require('./guards/max-runs-guard'),
      credits: require('./guards/ai-credits-guard'),
    };
    const adapter = require('./providers/anthropic').createAnthropicAdapter(credentials);
    const { createProxyHandler } = require('./server-factory');
    const handler = createProxyHandler(adapter, () => false, proxyRequest);
    agentServer = http.createServer(handler);
    await listen(agentServer);
    openaiServer = http.createServer(createProxyHandler(
      require('./providers/openai').createOpenAIAdapter(credentials), () => false, proxyRequest,
    ));
    await listen(openaiServer);
  });

  beforeEach(() => {
    serviceCalls = []; providerCalls = []; tunnels = [];
    behavior = 'success'; trustCertificate = true; failConnect = false;
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_MAX_RUNS;
    process.env.AWF_FALLBACK_MODELS = JSON.stringify(['openai/gpt-4o']);
    guards.runs.resetMaxRunsGuardForTests();
    guards.credits.resetAiCreditsGuardForTests();
    fallbackLookup.mockClear();
  });

  afterAll(async () => {
    stdoutSpy?.mockRestore();
    jest.restoreAllMocks();
    jest.dontMock('./http-client');
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    process.env = savedEnv;
  });

  const body = { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] };

  it('forwards credentials and corporate header, overriding a spoofed agent header, through CONNECT and TLS', async () => {
    const result = await request(body, { 'x-corporate-secret': 'agent-spoof', 'x-api-key': 'agent-spoof' });
    expect(result.status).toBe(200);
    expect(serviceCalls).toHaveLength(1);
    expect(providerCalls).toHaveLength(1);
    expect(tunnels).toEqual(['trusted.service.test:443']);
    expect(serviceCalls[0]).toMatchObject({
      url: '/corporate/v1/messages',
      headers: { 'x-corporate-secret': credentials.CORPORATE_SECRET, 'x-api-key': credentials.ANTHROPIC_API_KEY },
    });
    expect(result.body).not.toContain(credentials.CORPORATE_SECRET);
    expect(stdoutSpy.mock.calls.map(call => call[0]).join('')).not.toContain(credentials.CORPORATE_SECRET);
    const logs = stdoutSpy.mock.calls.map(call => call[0]).join('');
    expect(logs).not.toContain(credentials.ANTHROPIC_API_KEY.slice(0, 8));
    expect(logs).not.toContain(credentials.ANTHROPIC_API_KEY.slice(-4));
    expect(logs).not.toContain('key_preview');
  });

  it('preserves actual provider streaming', async () => {
    behavior = 'stream';
    const result = await request({ ...body, stream: true });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('text/event-stream');
    expect(result.body).toContain('message_start');
    expect(result.body).toContain('message_stop');
    expect(serviceCalls).toHaveLength(1);
  });

  it('forwards OpenAI requests through the same trusted TLS service with provider authentication', async () => {
    const result = await request({ model: 'gpt-4o', messages: body.messages }, {
      'x-corporate-secret': 'agent-spoof',
    }, '/v1/chat/completions', openaiServer);
    expect(result.status).toBe(200);
    expect(serviceCalls).toHaveLength(1);
    expect(providerCalls).toHaveLength(1);
    expect(serviceCalls[0].headers['x-corporate-secret']).toBe(credentials.CORPORATE_SECRET);
    expect(serviceCalls[0].headers.authorization).toContain(credentials.OPENAI_API_KEY);
    expect(serviceCalls[0].url).toBe('/corporate/v1/chat/completions');
  });

  it('includes the corporate header on actual verified model discovery requests', async () => {
    const adapter = require('./providers/anthropic').createAnthropicAdapter(credentials);
    const models = adapter.getModelsFetchConfig();
    const result = await require('./model-discovery').fetchJson(models.url, models.opts, 5000);
    expect(result).not.toBeNull();
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0].url).toBe('/corporate/v1/models');
    expect(serviceCalls[0].headers['x-corporate-secret']).toBe(credentials.CORPORATE_SECRET);
    expect(tunnels).toEqual(['trusted.service.test:443']);
  });

  it('propagates upstream errors without cross-provider fallback', async () => {
    behavior = 'error';
    const result = await request(body);
    expect(result.status).toBe(503);
    expect(result.body).toContain('provider unavailable');
    expect(serviceCalls).toHaveLength(1);
    expect(providerCalls).toHaveLength(1);
    expect(tunnels).toHaveLength(1);
    expect(fallbackLookup).not.toHaveBeenCalledWith('openai');
  });

  it('rejects model policy before any service call', async () => {
    const result = await request({ ...body, model: 'claude-opus-4-6' });
    expect(result.status).toBe(403);
    expect(serviceCalls).toHaveLength(0);
    expect(tunnels).toHaveLength(0);
  });

  it('rejects exhausted invocation budgets before any service call', async () => {
    process.env.AWF_MAX_RUNS = '1';
    guards.runs.applyMaxRunsInvocation();
    const result = await request(body);
    expect(result.status).toBe(429);
    expect(serviceCalls).toHaveLength(0);
    expect(tunnels).toHaveLength(0);
  });

  it('rejects exhausted credit budgets before any service call', async () => {
    process.env.AWF_MAX_AI_CREDITS = '1';
    guards.credits.applyAiCreditsUsage({ input_tokens: 1000000000 }, 'claude-sonnet-4-5', 'anthropic');
    const result = await request(body);
    expect(result.status).toBe(403);
    expect(result.body).toContain('ai_credits');
    expect(serviceCalls).toHaveLength(0);
    expect(tunnels).toHaveLength(0);
  });

  it('fails redirects closed without forwarding Location or falling back', async () => {
    behavior = 'redirect';
    const result = await request(body);
    expect(result.status).toBe(502);
    expect(result.body).toContain('trusted_service_redirect');
    expect(result.headers.location).toBeUndefined();
    expect(serviceCalls).toHaveLength(1);
    expect(providerCalls).toHaveLength(0);
    expect(tunnels).toHaveLength(1);
    expect(fallbackLookup).not.toHaveBeenCalledWith('openai');
  });

  it('survives a truncated rejected redirect body and accepts the next request', async () => {
    behavior = 'redirect-abort';
    const rejected = await request(body);
    expect(rejected.status).toBe(502);
    expect(rejected.body).toContain('trusted_service_redirect');
    expect(rejected.headers.location).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 30));
    behavior = 'success';
    expect((await request(body)).status).toBe(200);
    expect(serviceCalls).toHaveLength(2);
    expect(providerCalls).toHaveLength(1);
    expect(fallbackLookup).not.toHaveBeenCalledWith('openai');
  });

  it('fails actual TLS verification even if global verification is disabled, without fallback', async () => {
    trustCertificate = false;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const result = await request(body);
      expect(result.status).toBe(502);
      expect(serviceCalls).toHaveLength(0);
      expect(tunnels).toHaveLength(1);
      expect(fallbackLookup).not.toHaveBeenCalledWith('openai');
    } finally { delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; }
  });

  it('fails unreachable/denied service connections without fallback', async () => {
    failConnect = true;
    const result = await request(body);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(serviceCalls).toHaveLength(0);
    expect(tunnels).toHaveLength(1);
    expect(fallbackLookup).not.toHaveBeenCalledWith('openai');
  });
});
