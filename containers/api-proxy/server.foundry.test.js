'use strict';

require('./test-helpers/token-tracker-setup');
jest.mock('./http-client', () => ({ proxyAgent: undefined }));

const http = require('http');
const fs = require('fs');
const { createFoundryAdapter } = require('./providers/foundry');
const { createProviderServer } = require('./server');
const { closeLogStream, TOKEN_LOG_FILE } = require('./token-tracker');
const { createProxyHandler, createWebSocketUpgradeHandler } = require('./server-factory');

describe('Foundry inference authorization', () => {
  it.each([
    ['POST', '/openai/v1/files'],
    ['GET', '/openai/v1/files/file123/content'],
    ['DELETE', '/openai/v1/files/file123'],
    ['GET', '/responses'],
    ['POST', '/providers/microsoft/v1/systemone/extra'],
    ['POST', '/openai/v1/%2e%2e/chat/completions'],
  ])('rejects %s %s before acquiring credentials or dispatching', (method, url) => {
    const adapter = createFoundryAdapter({ FOUNDRY_API_TARGET: 'resource.example', FOUNDRY_API_KEY: 'test-key' });
    const auth = jest.spyOn(adapter, 'getAuthHeaders');
    const dispatch = jest.fn();
    const res = { writeHead: jest.fn(), end: jest.fn() };
    createProxyHandler(adapter, () => false, dispatch)({ method, url, headers: {} }, res);
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(auth).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects WebSocket upgrades before acquiring credentials or dispatching', () => {
    const adapter = createFoundryAdapter({ FOUNDRY_API_TARGET: 'resource.example', FOUNDRY_API_KEY: 'test-key' });
    const auth = jest.spyOn(adapter, 'getAuthHeaders');
    const dispatch = jest.fn();
    const socket = { write: jest.fn(), destroy: jest.fn() };
    createWebSocketUpgradeHandler(adapter, dispatch)(
      { method: 'GET', url: '/responses', headers: { upgrade: 'websocket' } }, socket, Buffer.alloc(0),
    );
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403 Forbidden'));
    expect(socket.destroy).toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('Foundry HTTP forwarding and usage accounting', () => {
  const servers = [];
  const seen = [];
  const previousPricing = process.env.AWF_DEFAULT_AI_CREDITS_PRICING;

  beforeAll(() => {
    process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 0.042, output: 0 });
  });

  async function listen(server) {
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  }

  afterAll(async () => {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await closeLogStream();
    if (previousPricing === undefined) delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    else process.env.AWF_DEFAULT_AI_CREDITS_PRICING = previousPricing;
  });

  it('forwards native decisions and OpenAI-compatible requests and persists their usage', async () => {
    const decisionPath = '/providers/microsoft/v1/systemone';
    const responseFor = path => path === decisionPath ? {
      model: 'microsoft-decision-1',
      answers: [{ name: 'area', choice: 'docs', probabilities: { docs: 0.97, code: 0.03 } }],
      usage: { input_tokens: 420, output_tokens: 0, total_tokens: 420 },
    } : {
      model: 'foundry-chat',
      choices: [{ message: { role: 'assistant', content: 'docs' } }],
      usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
    };
    const upstreamPort = await listen(http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseFor(req.url)));
      });
    }));

    const decisionBody = {
      model: 'decision1',
      state: 'A documentation issue',
      questions: [{ name: 'area', type: 'choice', instructions: 'Which area owns this issue?', choices: ['docs', 'code'] }],
    };
    for (const [credential, path, body] of [
      [{ FOUNDRY_API_KEY: 'test-foundry-key' }, decisionPath, decisionBody],
      [{ FOUNDRY_API_KEY: 'test-foundry-key', FOUNDRY_ENTRA_TOKEN: 'test-entra-token' }, '/openai/v1/chat/completions',
        { model: 'foundry-chat', messages: [{ role: 'user', content: 'Classify this issue' }] }],
    ]) {
      const adapter = createFoundryAdapter({
        FOUNDRY_API_TARGET: `http://127.0.0.1:${upstreamPort}`,
        ...credential,
      });
      const proxyPort = await listen(createProviderServer(adapter));
      const response = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: proxyPort, method: 'POST', path,
          headers: { 'Content-Type': 'application/json', 'api-key': 'placeholder', Authorization: 'placeholder' },
          timeout: 5000,
        }, res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Foundry proxy test timed out')));
        req.end(JSON.stringify(body));
      });
      expect(response).toEqual({ status: 200, body: responseFor(path) });
      expect(seen.at(-1).body).toEqual(body);
    }

    expect(seen.map(request => request.path)).toEqual([decisionPath, '/openai/v1/chat/completions']);
    expect(seen[0].headers['api-key']).toBe('test-foundry-key');
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[1].headers.authorization).toBeUndefined();
    expect(seen[1].headers['api-key']).toBe('test-foundry-key');

    await closeLogStream();
    const log = fs.readFileSync(TOKEN_LOG_FILE, 'utf8');
    const records = log.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.provider === 'foundry');
    expect(records).toEqual([
      expect.objectContaining({
        provider: 'foundry', model: 'microsoft-decision-1', path: decisionPath,
        input_tokens: 420, output_tokens: 0, status: 200, streaming: false,
      }),
      expect.objectContaining({
        provider: 'foundry', model: 'foundry-chat', path: '/openai/v1/chat/completions',
        input_tokens: 20, output_tokens: 1, status: 200,
      }),
    ]);
    expect(records[0].ai_credits_this_response).toBeCloseTo(0.001764, 10);
    expect(records[0].ai_credits_total).toBeGreaterThan(0);
    expect(log).not.toContain('test-foundry-key');
    expect(log).not.toContain('test-entra-token');
    expect(log).not.toContain('A documentation issue');
  });
});
