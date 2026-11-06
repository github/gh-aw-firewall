/**
 * Tests for proxyRequest X-Initiator injection and tool_calls normalisation.
 *
 * Extracted from server.proxy.test.js.
 */

const https = require('https');
const {
  makeReq: makeReqFactory,
  makeRes,
  makeProxyReq,
  setupServerTestEnv,
  flushPromises,
} = require('./test-helpers/server-mock-factories');

let proxyRequest;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  return { proxyRequest };
});

describe('proxyRequest X-Initiator injection', () => {
  /** Minimal mock for http.IncomingMessage backed by EventEmitter. */
  function makeReq(headers = {}) {
    return makeReqFactory('/v1/chat/completions', headers);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Mock https.request to capture the outgoing options (including headers)
   * without making a real network connection.
   */
  function mockHttpsRequest() {
    let capturedOptions;
    let capturedProxyReq;
    jest.spyOn(https, 'request').mockImplementation((options) => {
      capturedOptions = options;
      const proxyReq = makeProxyReq();
      capturedProxyReq = proxyReq;
      return proxyReq;
    });
    return {
      getCaptured: () => capturedOptions,
      getWrittenBody: () => capturedProxyReq?.write?.mock?.calls?.[0]?.[0],
    };
  }

  it('replaces Codex placeholder auth through the OpenAI adapter on HTTPS fallback', async () => {
    const { createOpenAIAdapter } = require('./providers/openai');
    const { createProxyHandler } = require('./server-factory');
    const adapter = createOpenAIAdapter({ OPENAI_API_KEY: 'test-only-sidecar-key' });
    const { getCaptured, getWrittenBody } = mockHttpsRequest();
    const placeholder = 'sk-placeholder-for-api-proxy';
    const req = makeReqFactory('/v1/responses', {
      authorization: 'Bearer ' + placeholder,
      'proxy-authorization': 'Bearer ' + placeholder,
      'x-api-key': placeholder,
    });
    const body = { model: 'gpt-5.4', input: 'fixture', stream: true };
    createProxyHandler(adapter, () => false, proxyRequest)(req, makeRes());
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    await flushPromises();
    const options = getCaptured();
    expect(options.hostname).toBe('api.openai.com');
    expect(options.path).toBe('/v1/responses');
    expect(options.headers.Authorization).toBe(adapter.getAuthHeaders().Authorization);
    expect(Object.keys(options.headers).filter(name => name.toLowerCase() === 'authorization'))
      .toHaveLength(1);
    expect(JSON.stringify(options.headers)).not.toContain(placeholder);
    expect(options.headers['proxy-authorization']).toBeUndefined();
    expect(options.headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(getWrittenBody())).toEqual(body);
  });

  it('injects x-initiator: agent when absent on direct copilot requests', async () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('end');
    await flushPromises();
    expect(getCaptured().headers['x-initiator']).toBe('agent');
  });

  it('injects x-initiator: agent when absent on enterprise githubcopilot.com target', async () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.enterprise.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('end');
    await flushPromises();
    expect(getCaptured().headers['x-initiator']).toBe('agent');
  });

  it('preserves a client-supplied x-initiator value on copilot requests', async () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq({ 'x-initiator': 'user' });
    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('end');
    await flushPromises();
    expect(getCaptured().headers['x-initiator']).toBe('user');
  });

  it('does not inject x-initiator for non-copilot provider targets', async () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();
    expect(getCaptured().headers['x-initiator']).toBeUndefined();
  });

  it('normalizes null tool_calls[].type to function before forwarding', async () => {
    const { getWrittenBody } = mockHttpsRequest();
    const req = makeReq();

    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-5.4',
      messages: [{
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          type: null,
          function: { name: 'edit', arguments: '{"file":"x.ts"}' },
        }],
      }],
    })));
    req.emit('end');
    await flushPromises();

    const forwarded = JSON.parse(getWrittenBody().toString('utf8'));
    expect(forwarded.messages[0].tool_calls[0].type).toBe('function');
  });

  it('drops malformed tool calls with null type and no function payload', async () => {
    const { getWrittenBody } = mockHttpsRequest();
    const req = makeReq();

    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-5.4',
      messages: [{
        role: 'assistant',
        tool_calls: [
          { id: 'call_ok', type: null, function: { name: 'edit', arguments: '{}' } },
          { id: 'call_bad', type: null },
        ],
      }],
    })));
    req.emit('end');
    await flushPromises();

    const forwarded = JSON.parse(getWrittenBody().toString('utf8'));
    expect(forwarded.messages[0].tool_calls).toEqual([
      { id: 'call_ok', type: 'function', function: { name: 'edit', arguments: '{}' } },
    ]);
  });
});
