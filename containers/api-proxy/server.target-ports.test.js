'use strict';

const http = require('http');
const net = require('net');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { createAllAdapters } = require('./providers');
const { createOpenAIAdapter } = require('./providers/openai');
const { createCopilotAdapter } = require('./providers/copilot');

describe('provider target ports', () => {
  it.each([
    ['http://gateway.example.com:11434', 'http', 'gateway.example.com:11434'],
    ['https://gateway.example.com:8443', 'https', 'gateway.example.com:8443'],
  ])('preserves %s across all providers', (target, scheme, host) => {
    const adapters = createAllAdapters({
      OPENAI_API_KEY: 'test-key', OPENAI_API_TARGET: target, OPENAI_API_BASE_PATH: '/v1',
      ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_API_TARGET: target, ANTHROPIC_API_BASE_PATH: '/v1',
      COPILOT_PROVIDER_API_KEY: 'test-key', COPILOT_API_TARGET: target, COPILOT_API_BASE_PATH: '/v1',
      GEMINI_API_KEY: 'test-key', GEMINI_API_TARGET: target, GEMINI_API_BASE_PATH: '/v1',
      GOOGLE_API_KEY: 'test-key', VERTEX_API_TARGET: target, VERTEX_API_BASE_PATH: '/v1',
    });
    expect(adapters).toHaveLength(5);
    for (const adapter of adapters) {
      expect(adapter.getTargetHost()).toBe(host);
      expect(adapter.getTargetScheme()).toBe(scheme);
      expect(adapter.getBasePath()).toBe('/v1');
      const models = adapter.getModelsFetchConfig();
      if (models) expect(models.url).toBe(`${target}/v1/models`);
      // Custom-target validation remains skipped, rather than sending new probes.
      expect(adapter.getValidationProbe().skip).toBe(true);
    }
  });

  it('preserves HTTP and port in Azure BYOK base URLs without credentials or queries', () => {
    const adapter = createOpenAIAdapter({
      COPILOT_PROVIDER_TYPE: 'azure', COPILOT_PROVIDER_API_KEY: 'test-key',
      COPILOT_PROVIDER_BASE_URL: 'http://' + 'user:pass@localhost:11434/v1/?key=discard#fragment',
    });
    expect(adapter.getTargetScheme()).toBe('http');
    expect(adapter.getTargetHost()).toBe('localhost:11434');
    expect(adapter.getBasePath()).toBe('/v1');
    expect(adapter.getModelsFetchConfig().url).toBe('http://localhost:11434/v1/models');
  });

  it.each([
    ['http://api.enterprise.githubcopilot.com:11434', 'Bearer'],
    ['https://api.enterprise.githubcopilot.com:8443', 'token'],
    ['https://copilot-api.tenant.ghe.com:8443', 'Bearer'],
  ])('preserves Copilot validation/discovery URL and auth for %s', (target, prefix) => {
    const adapter = createCopilotAdapter({
      COPILOT_API_TARGET: target, COPILOT_GITHUB_TOKEN: 'test-token',
    });
    expect(adapter.getModelsFetchConfig().url).toBe(`${target}/models`);
    const probe = adapter.getValidationProbe();
    expect(probe.url).toBe(`${target}/models`);
    expect(probe.opts.headers.Authorization).toBe(`${prefix} test-token`);
  });

});

describe('local OpenAI-compatible upstream through CONNECT proxy', () => {
  const servers = [];
  const sockets = new Set();
  let agent;

  async function listen(server) {
    servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  }

  afterEach(async () => {
    agent?.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
    jest.dontMock('./http-client');
  });

  it('discovers models and forwards chat to the same explicit port and /v1 prefix', async () => {
    const seen = [];
    const upstreamPort = await listen(http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push({ path: req.url, host: req.headers.host, auth: req.headers.authorization, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url === '/v1/models'
          ? { data: [{ id: 'local-model' }] }
          : { id: 'chat-local', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      });
    }));
    const connects = [];
    const forwardProxy = http.createServer();
    forwardProxy.on('connect', (req, downstream, head) => {
      connects.push(req.url);
      // Test proxy is deliberately restricted to this test's local upstream.
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
    const proxyPort = await listen(forwardProxy);
    agent = new HttpsProxyAgent(`http://127.0.0.1:${proxyPort}`);
    jest.resetModules();
    jest.doMock('./http-client', () => ({ proxyAgent: agent }));
    const { fetchJson, httpProbe } = require('./model-discovery');
    const { createProviderServer } = require('./server');
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'test-local-key',
      OPENAI_API_TARGET: `http://127.0.0.1:${upstreamPort}`,
      OPENAI_API_BASE_PATH: '/v1',
    });
    const modelsConfig = adapter.getModelsFetchConfig();
    expect(await fetchJson(modelsConfig.url, modelsConfig.opts, 2000)).toEqual({
      data: [{ id: 'local-model' }],
    });
    expect(await httpProbe(modelsConfig.url, modelsConfig.opts, 2000)).toBe(200);
    const sidecarPort = await listen(createProviderServer(adapter));
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: sidecarPort, method: 'POST', path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json' }, timeout: 3000,
      }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('local proxy test timed out')));
      req.end(JSON.stringify({ model: 'local-model', messages: [{ role: 'user', content: 'hi' }] }));
    });
    expect(response.status).toBe(200);
    expect(response.body.id).toBe('chat-local');
    expect(seen.map(request => request.path)).toEqual(['/v1/models', '/v1/models', '/v1/chat/completions']);
    expect(seen.every(request => request.host === `127.0.0.1:${upstreamPort}`)).toBe(true);
    expect(seen.every(request => request.auth === ['Bearer', 'test-local-key'].join(' '))).toBe(true);
    expect(JSON.parse(seen[2].body).model).toBe('local-model');
    expect(connects).toEqual(Array(3).fill(`127.0.0.1:${upstreamPort}`));
  });
});
