/**
 * Tests for proxyRequest X-Initiator injection and tool_calls normalisation.
 *
 * Extracted from server.proxy.test.js.
 */

const https = require('https');
const { EventEmitter } = require('events');

const originalHttpsProxy = process.env.HTTPS_PROXY;
let proxyRequest;

beforeAll(() => {
  delete process.env.HTTPS_PROXY;
  jest.resetModules();
  ({ proxyRequest } = require('./server'));
});

afterAll(() => {
  if (originalHttpsProxy === undefined) {
    delete process.env.HTTPS_PROXY;
  } else {
    process.env.HTTPS_PROXY = originalHttpsProxy;
  }
  jest.resetModules();
});

describe('proxyRequest X-Initiator injection', () => {
  /** Minimal mock for http.IncomingMessage backed by EventEmitter. */
  function makeReq(headers = {}) {
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', ...headers };
    return req;
  }

  /** Minimal mock for http.ServerResponse. */
  function makeRes() {
    return {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn(),
    };
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
      const proxyReq = new EventEmitter();
      proxyReq.end = jest.fn();
      proxyReq.write = jest.fn();
      proxyReq.destroy = jest.fn();
      capturedProxyReq = proxyReq;
      return proxyReq;
    });
    return {
      getCaptured: () => capturedOptions,
      getWrittenBody: () => capturedProxyReq?.write?.mock?.calls?.[0]?.[0],
    };
  }

  it('injects x-initiator: agent when absent on direct copilot requests', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('end');
    expect(getCaptured().headers['x-initiator']).toBe('agent');
  });

  it('injects x-initiator: agent when absent on enterprise githubcopilot.com target', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.enterprise.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('end');
    expect(getCaptured().headers['x-initiator']).toBe('agent');
  });

  it('preserves a client-supplied x-initiator value on copilot requests', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq({ 'x-initiator': 'user' });
    proxyRequest(req, makeRes(), 'api.githubcopilot.com', { 'Authorization': 'Bearer token' }, 'copilot');
    req.emit('end');
    expect(getCaptured().headers['x-initiator']).toBe('user');
  });

  it('does not inject x-initiator for non-copilot provider targets', () => {
    const { getCaptured } = mockHttpsRequest();
    const req = makeReq();
    proxyRequest(req, makeRes(), 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    expect(getCaptured().headers['x-initiator']).toBeUndefined();
  });

  it('normalizes null tool_calls[].type to function before forwarding', () => {
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

    const forwarded = JSON.parse(getWrittenBody().toString('utf8'));
    expect(forwarded.messages[0].tool_calls[0].type).toBe('function');
  });

  it('drops malformed tool calls with null type and no function payload', () => {
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

    const forwarded = JSON.parse(getWrittenBody().toString('utf8'));
    expect(forwarded.messages[0].tool_calls).toEqual([
      { id: 'call_ok', type: 'function', function: { name: 'edit', arguments: '{}' } },
    ]);
  });
});
