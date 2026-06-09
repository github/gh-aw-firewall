/**
 * Tests for proxyRequest anthropic deprecated beta header handling:
 * retry logic, proactive stripping, and learning across requests.
 *
 * Extracted from server.proxy.test.js.
 */

const https = require('https');
const {
  makeReq: makeReqFactory,
  makeRes,
  makeProxyReq,
  makeProxyRes,
  getStructuredLogs,
  setupServerTestEnv,
  flushPromises,
} = require('./test-helpers/server-mock-factories');

let proxyRequest;
let resetAnthropicDeprecatedBetaHeadersForTests;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  ({ resetAnthropicDeprecatedBetaHeadersForTests } = require('./proxy-request'));
  return { proxyRequest, resetAnthropicDeprecatedBetaHeadersForTests };
});

beforeEach(() => {
  resetAnthropicDeprecatedBetaHeadersForTests();
});

describe('proxyRequest anthropic deprecated beta handling', () => {
  let stdoutWriteSpy;
  let responseHandlers;
  let capturedOptions;
  function makeReq(headers = {}) {
    return makeReqFactory('/v1/messages', headers);
  }

  beforeEach(() => {
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    responseHandlers = [];
    capturedOptions = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      return makeProxyReq();
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retries once after Anthropic rejects a deprecated anthropic-beta value', async () => {
    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07,other-beta' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].headers['anthropic-beta']).toBe('context-1m-2025-08-07,other-beta');

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      '400 Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['anthropic-beta']).toBe('other-beta');

    const secondResponse = makeProxyRes(200);
    responseHandlers[1](secondResponse);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'x-request-id': expect.any(String),
    }));
    secondResponse.emit('data', Buffer.from('{"ok":true}'));
    secondResponse.emit('end');

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'retry',
        header: 'anthropic-beta',
        removed_values: ['context-1m-2025-08-07'],
        remaining_values: ['other-beta'],
      }),
    ]));
  });

  it('proactively strips learned deprecated anthropic-beta values on later requests', async () => {
    const learnReq = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const learnRes = makeRes();
    proxyRequest(learnReq, learnRes, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    learnReq.emit('end');
    await flushPromises();

    const rejection = makeProxyRes(400);
    responseHandlers[0](rejection);
    rejection.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header'
    ));
    rejection.emit('end');

    expect(capturedOptions[1].headers['anthropic-beta']).toBeUndefined();

    const retrySuccess = makeProxyRes(200);
    responseHandlers[1](retrySuccess);
    retrySuccess.emit('data', Buffer.from('{"ok":true}'));
    retrySuccess.emit('end');

    const nextReq = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const nextRes = makeRes();
    proxyRequest(nextReq, nextRes, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    nextReq.emit('end');
    await flushPromises();

    expect(capturedOptions[2].headers['anthropic-beta']).toBeUndefined();

    const laterSuccess = makeProxyRes(200);
    responseHandlers[2](laterSuccess);
    laterSuccess.emit('data', Buffer.from('{"ok":true}'));
    laterSuccess.emit('end');

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'cached',
        header: 'anthropic-beta',
        removed_values: ['context-1m-2025-08-07'],
        remaining_values: [],
      }),
    ]));
  });

  it('retries after deprecated anthropic-beta rejection via copilot provider', async () => {
    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07,prompt-caching-2024-07-31' });
    const res = makeRes();
    proxyRequest(req, res, 'api.githubcopilot.com', { authorization: 'Bearer ghu_test' }, 'copilot');
    req.emit('end');
    await flushPromises();

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0].headers['anthropic-beta']).toBe('context-1m-2025-08-07,prompt-caching-2024-07-31');

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      '400 Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header. Please consult our documentation.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');

    const secondResponse = makeProxyRes(200);
    responseHandlers[1](secondResponse);
    secondResponse.emit('data', Buffer.from('{"ok":true}'));
    secondResponse.emit('end');

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'x-request-id': expect.any(String),
    }));

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'retry',
        provider: 'copilot',
        header: 'anthropic-beta',
        removed_values: ['context-1m-2025-08-07'],
        remaining_values: ['prompt-caching-2024-07-31'],
      }),
    ]));
  });

  it('proactively strips learned deprecated values for copilot provider requests', async () => {
    // First: learn via anthropic provider
    const learnReq = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const learnRes = makeRes();
    proxyRequest(learnReq, learnRes, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    learnReq.emit('end');
    await flushPromises();

    const rejection = makeProxyRes(400);
    responseHandlers[0](rejection);
    rejection.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header'
    ));
    rejection.emit('end');

    const retrySuccess = makeProxyRes(200);
    responseHandlers[1](retrySuccess);
    retrySuccess.emit('data', Buffer.from('{"ok":true}'));
    retrySuccess.emit('end');

    // Second: copilot provider request should proactively strip the learned value
    const copilotReq = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07,prompt-caching-2024-07-31' });
    const copilotRes = makeRes();
    proxyRequest(copilotReq, copilotRes, 'api.githubcopilot.com', { authorization: 'Bearer ghu_test' }, 'copilot');
    copilotReq.emit('end');
    await flushPromises();

    expect(capturedOptions[2].headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'cached',
        provider: 'copilot',
        header: 'anthropic-beta',
        removed_values: ['context-1m-2025-08-07'],
      }),
    ]));
  });

  it('handles deprecated values in arbitrary headers (not just anthropic-beta)', async () => {
    const req = makeReq({ 'x-custom-feature': 'old-feature-2024,new-feature-2025' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();

    expect(capturedOptions).toHaveLength(1);

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `old-feature-2024` for the `x-custom-feature` header. Please update.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['x-custom-feature']).toBe('new-feature-2025');

    const secondResponse = makeProxyRes(200);
    responseHandlers[1](secondResponse);
    secondResponse.emit('data', Buffer.from('{"ok":true}'));
    secondResponse.emit('end');

    // Subsequent request should proactively strip the learned value
    const nextReq = makeReq({ 'x-custom-feature': 'old-feature-2024,new-feature-2025' });
    const nextRes = makeRes();
    proxyRequest(nextReq, nextRes, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    nextReq.emit('end');
    await flushPromises();

    expect(capturedOptions[2].headers['x-custom-feature']).toBe('new-feature-2025');

    const stripLogs = getStructuredLogs(stdoutWriteSpy, 'deprecated_header_stripped');
    expect(stripLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mode: 'retry',
        header: 'x-custom-feature',
        removed_values: ['old-feature-2024'],
        remaining_values: ['new-feature-2025'],
      }),
      expect.objectContaining({
        mode: 'cached',
        header: 'x-custom-feature',
        removed_values: ['old-feature-2024'],
        remaining_values: ['new-feature-2025'],
      }),
    ]));
  });

  it('does not retry when 400 body does not match the deprecated header pattern', async () => {
    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be less than 8192"}}'
    ));
    firstResponse.emit('end');

    // Should NOT retry — only 1 request made
    expect(capturedOptions).toHaveLength(1);
    // Should pass through the 400 to the client
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(res.end).toHaveBeenCalled();
  });

  it('does not retry more than once (retry itself returns 400)', async () => {
    const req = makeReq({ 'anthropic-beta': 'bad-value-1,bad-value-2' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();

    // First 400 — triggers retry after stripping bad-value-1
    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `bad-value-1` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['anthropic-beta']).toBe('bad-value-2');

    // Second 400 on retry — should NOT trigger another retry (hasRetried=true)
    const secondResponse = makeProxyRes(400);
    responseHandlers[1](secondResponse);
    // Simulate streaming data through pipe
    secondResponse.emit('data', Buffer.from(
      'Unexpected value(s) `bad-value-2` for the `anthropic-beta` header.'
    ));
    secondResponse.emit('end');

    // Only 2 requests total — no infinite loop
    expect(capturedOptions).toHaveLength(2);
    // The second 400 is streamed back to the client via pipe
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
      'x-request-id': expect.any(String),
    }));
  });

  it('removes header entirely when all values are deprecated', async () => {
    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    // Header should be completely removed since it was the only value
    expect(capturedOptions[1].headers['anthropic-beta']).toBeUndefined();

    const secondResponse = makeProxyRes(200);
    responseHandlers[1](secondResponse);
    secondResponse.emit('data', Buffer.from('{"ok":true}'));
    secondResponse.emit('end');

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });

  it('does not buffer 400 responses for non-anthropic/non-copilot providers', async () => {
    const req = makeReq({ 'anthropic-beta': 'context-1m-2025-08-07' });
    req.url = '/v1/chat/completions';
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { authorization: 'Bearer sk-test' }, 'openai');
    req.emit('end');
    await flushPromises();

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    // Even if the body matches, openai provider should NOT trigger retry
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    // Should NOT retry — only 1 request
    expect(capturedOptions).toHaveLength(1);
  });

  it('learns multiple deprecated values across separate requests', async () => {
    // First request: learn that value-a is deprecated
    const req1 = makeReq({ 'anthropic-beta': 'value-a,value-b,value-c' });
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req1.emit('end');
    await flushPromises();

    const rej1 = makeProxyRes(400);
    responseHandlers[0](rej1);
    rej1.emit('data', Buffer.from('Unexpected value(s) `value-a` for the `anthropic-beta` header'));
    rej1.emit('end');

    // Retry succeeds
    const ok1 = makeProxyRes(200);
    responseHandlers[1](ok1);
    ok1.emit('data', Buffer.from('{"ok":true}'));
    ok1.emit('end');

    // Second request: learn that value-b is also deprecated
    const req2 = makeReq({ 'anthropic-beta': 'value-a,value-b,value-c' });
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req2.emit('end');
    await flushPromises();

    // value-a was proactively stripped, so only value-b,value-c sent
    expect(capturedOptions[2].headers['anthropic-beta']).toBe('value-b,value-c');

    const rej2 = makeProxyRes(400);
    responseHandlers[2](rej2);
    rej2.emit('data', Buffer.from('Unexpected value(s) `value-b` for the `anthropic-beta` header'));
    rej2.emit('end');

    // Retry with only value-c
    expect(capturedOptions[3].headers['anthropic-beta']).toBe('value-c');

    const ok2 = makeProxyRes(200);
    responseHandlers[3](ok2);
    ok2.emit('data', Buffer.from('{"ok":true}'));
    ok2.emit('end');

    // Third request: both value-a and value-b should be proactively stripped
    const req3 = makeReq({ 'anthropic-beta': 'value-a,value-b,value-c' });
    const res3 = makeRes();
    proxyRequest(req3, res3, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req3.emit('end');
    await flushPromises();

    expect(capturedOptions[4].headers['anthropic-beta']).toBe('value-c');
  });

  it('handles whitespace in comma-separated header values', async () => {
    // Header with spaces around commas
    const req = makeReq({ 'anthropic-beta': ' context-1m-2025-08-07 , prompt-caching-2024-07-31 ' });
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();

    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      'Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header.'
    ));
    firstResponse.emit('end');

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });
});
