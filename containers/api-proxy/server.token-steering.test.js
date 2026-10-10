/**
 * Tests for token steering: getAndClearPendingSteeringMessage,
 * getAndClearPendingTimeoutSteeringMessage, and injectSteeringMessage.
 *
 * Extracted from server.proxy.test.js.
 */

const https = require('https');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tokenLogDir } = require('./test-helpers/token-tracker-setup');
const { setupServerTestEnv, flushPromises, makeProxyReq, completeUpstreamResponse } = require('./test-helpers/server-mock-factories');

let proxyRequest;
let closeTokenUsageLog;
let getAndClearPendingSteeringMessage;
let getAndClearPendingTimeoutSteeringMessage;
let injectSteeringMessage;
let resetEffectiveTokenGuardForTests;
let resetAiCreditsGuardForTests;
let resetTimeoutSteeringForTests;
let replaceRuntimeModels;
let clearRuntimeModels;
let timeoutRuntimeDir;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  ({ closeLogStream: closeTokenUsageLog } = require('./token-tracker'));
  ({
    getAndClearPendingSteeringMessage,
    getAndClearPendingTimeoutSteeringMessage,
    injectSteeringMessage,
    resetEffectiveTokenGuardForTests,
    resetTimeoutSteeringForTests,
  } = require('./proxy-request'));
  ({ resetAiCreditsGuardForTests } = require('./guards/ai-credits-guard'));
  ({ replaceRuntimeModels, clearRuntimeModels } = require('./runtime-model-catalog'));
  return {
    proxyRequest,
    getAndClearPendingSteeringMessage,
    getAndClearPendingTimeoutSteeringMessage,
    injectSteeringMessage,
    resetEffectiveTokenGuardForTests,
    resetAiCreditsGuardForTests,
    resetTimeoutSteeringForTests,
    replaceRuntimeModels,
    clearRuntimeModels,
  };
});

describe('token steering — getAndClearPendingSteeringMessage and injectSteeringMessage', () => {
  // getAndClearPendingSteeringMessage and injectSteeringMessage are loaded here
  // for unit-level tests (pure function tests and "returns null" guard checks).
  // Integration tests that verify steering injection end-to-end use two
  // proxyRequest calls so that the same module instance that runs inside the
  // proxy handles both the threshold crossing and the body injection.

  beforeEach(() => {
    timeoutRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-timeout-steering-'));
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '100';
    process.env.AWF_ENABLE_TOKEN_STEERING = 'true';
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
    process.env.AWF_AGENT_RUNTIME_START_FILE = path.join(timeoutRuntimeDir, 'started-at-ms');
    resetEffectiveTokenGuardForTests();
    resetAiCreditsGuardForTests();
    resetTimeoutSteeringForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_ENABLE_TOKEN_STEERING;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
    delete process.env.AWF_AGENT_RUNTIME_START_FILE;
    resetEffectiveTokenGuardForTests();
    resetAiCreditsGuardForTests();
    resetTimeoutSteeringForTests();
    clearRuntimeModels();
    fs.rmSync(timeoutRuntimeDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTokenUsageLog();
  });

  it('returns null when no thresholds have been crossed', () => {
    expect(getAndClearPendingSteeringMessage()).toBeNull();
  });

  it('uses the runtime start marker when the first timeout check is delayed', () => {
    process.env.AWF_AGENT_TIMEOUT_MINUTES = '10';
    const start = 1_700_000_000_000;
    fs.writeFileSync(process.env.AWF_AGENT_RUNTIME_START_FILE, String(start));
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    resetTimeoutSteeringForTests();

    nowSpy.mockReturnValue(start + (8 * 60 * 1000));
    const msg80 = getAndClearPendingTimeoutSteeringMessage();
    expect(msg80).toContain('[AWF TIME WARNING]');
    expect(msg80).toContain('80%');
    expect(getAndClearPendingTimeoutSteeringMessage()).toBeNull();

    nowSpy.mockReturnValue(start + Math.floor(9.6 * 60 * 1000));
    const msg95 = getAndClearPendingTimeoutSteeringMessage();
    const msg90 = getAndClearPendingTimeoutSteeringMessage();
    expect(msg95).toContain('95%');
    expect(msg90).toContain('90%');
  });

  it('injects timeout steering warning into OpenAI request body', async () => {
    process.env.AWF_AGENT_TIMEOUT_MINUTES = '10';
    const start = 1_700_000_000_000;
    fs.writeFileSync(process.env.AWF_AGENT_RUNTIME_START_FILE, String(start));
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    resetTimeoutSteeringForTests();

    const upstreamReq1 = makeProxyReq();
    const upstreamReq2 = makeProxyReq();

    jest.spyOn(https, 'request')
      .mockImplementationOnce(() => upstreamReq1)
      .mockImplementationOnce(() => upstreamReq2);

    const req1Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'First request' }],
    }));
    const req1 = new EventEmitter();
    req1.url = '/v1/chat/completions';
    req1.method = 'POST';
    req1.headers = { 'content-type': 'application/json', 'content-length': String(req1Body.length) };
    const res1 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('data', req1Body);
    req1.emit('end');
    await flushPromises();

    nowSpy.mockReturnValue(start + (8 * 60 * 1000));

    const req2Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'Second request' }],
    }));
    const req2 = new EventEmitter();
    req2.url = '/v1/chat/completions';
    req2.method = 'POST';
    req2.headers = { 'content-type': 'application/json', 'content-length': String(req2Body.length) };
    const res2 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('data', req2Body);
    req2.emit('end');
    await flushPromises();

    expect(upstreamReq2.write).toHaveBeenCalledTimes(1);
    const writtenBody2 = JSON.parse(upstreamReq2.write.mock.calls[0][0].toString());
    expect(writtenBody2.messages[0].role).toBe('system');
    expect(writtenBody2.messages[0].content).toContain('[AWF TIME WARNING]');
    expect(writtenBody2.messages[0].content).toContain('80%');
  });

  it('injects Copilot Messages steering into the top-level system field', async () => {
    process.env.AWF_AGENT_TIMEOUT_MINUTES = '10';
    const start = 1_700_000_000_000;
    fs.writeFileSync(process.env.AWF_AGENT_RUNTIME_START_FILE, String(start));
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    resetTimeoutSteeringForTests();

    const upstreamReq1 = makeProxyReq();
    const upstreamReq2 = makeProxyReq();
    jest.spyOn(https, 'request')
      .mockImplementationOnce(() => upstreamReq1)
      .mockImplementationOnce(() => upstreamReq2);

    const makeCopilotRequest = (content) => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4',
        system: 'Be helpful.',
        messages: [{ role: 'user', content }],
      }));
      const req = new EventEmitter();
      req.url = '/v1/messages';
      req.method = 'POST';
      req.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
      const res = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
      proxyRequest(req, res, 'api.githubcopilot.com', { Authorization: '******' }, 'copilot');
      req.emit('data', body);
      req.emit('end');
      return flushPromises();
    };

    await makeCopilotRequest('First request');
    nowSpy.mockReturnValue(start + (8 * 60 * 1000));
    await makeCopilotRequest('Second request');

    expect(upstreamReq2.write).toHaveBeenCalledTimes(1);
    const writtenBody = JSON.parse(upstreamReq2.write.mock.calls[0][0].toString());
    expect(writtenBody.system).toContain('[AWF TIME WARNING]');
    expect(writtenBody.system).toContain('80%');
    expect(writtenBody.messages).toEqual([{ role: 'user', content: 'Second request' }]);
  });

  it('injects 80% warning into an OpenAI request body and clears it on the next request', async () => {
    // Two upstream request objects — one per proxyRequest call.
    let responseHandler;
    const upstreamReq1 = makeProxyReq();
    const upstreamReq2 = makeProxyReq();
    const upstreamReq3 = makeProxyReq();

    jest.spyOn(https, 'request')
      .mockImplementationOnce((_opts, cb) => { responseHandler = cb; return upstreamReq1; })
      .mockImplementationOnce(() => upstreamReq2)
      .mockImplementationOnce(() => upstreamReq3);

    // Request 1: triggers 84 effective tokens (21 output × 4.0) → 84% of 100 → crosses 80%
    const req1 = new EventEmitter();
    req1.url = '/v1/chat/completions';
    req1.method = 'POST';
    req1.headers = { 'content-type': 'application/json' };
    const res1 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    proxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('end');
    await flushPromises();

    completeUpstreamResponse(responseHandler, {
      statusCode: 200,
      body: { model: 'gpt-4o', usage: { prompt_tokens: 0, completion_tokens: 21 } },
    });

    // Request 2: the proxy should inject the 80% warning into the outgoing body.
    // We send a minimal OpenAI chat body and inspect what the proxy writes upstream.
    const req2Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'Hello' }],
    }));
    const req2 = new EventEmitter();
    req2.url = '/v1/chat/completions';
    req2.method = 'POST';
    req2.headers = { 'content-type': 'application/json', 'content-length': String(req2Body.length) };
    const res2 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    proxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('data', req2Body);
    req2.emit('end');
    await flushPromises();

    // The proxy writes the (modified) body to the upstream request.
    expect(upstreamReq2.write).toHaveBeenCalledTimes(1);
    const writtenBody2 = JSON.parse(upstreamReq2.write.mock.calls[0][0].toString());
    // A system message with the budget warning should be prepended.
    expect(writtenBody2.messages[0].role).toBe('system');
    expect(writtenBody2.messages[0].content).toContain('[AWF TOKEN WARNING]');
    expect(writtenBody2.messages[0].content).toContain('80%');
    // The original user message should follow.
    expect(writtenBody2.messages[1]).toMatchObject({ role: 'user', content: 'Hello' });

    // Request 3: the 80% threshold has already been injected; no further steering.
    const req3Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'Hello again' }],
    }));
    const req3 = new EventEmitter();
    req3.url = '/v1/chat/completions';
    req3.method = 'POST';
    req3.headers = { 'content-type': 'application/json', 'content-length': String(req3Body.length) };
    const res3 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    proxyRequest(req3, res3, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req3.emit('data', req3Body);
    req3.emit('end');
    await flushPromises();

    expect(upstreamReq3.write).toHaveBeenCalledTimes(1);
    const writtenBody3 = JSON.parse(upstreamReq3.write.mock.calls[0][0].toString());
    const systemMessages3 = writtenBody3.messages.filter(m => m.role === 'system' && m.content.includes('[AWF TOKEN WARNING]'));
    expect(systemMessages3).toHaveLength(0);
  });

  it('steers gh-aw default AI-credit-only Copilot Responses requests end to end', async () => {
    process.env.AWF_MAX_AI_CREDITS = '1000';
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
    const cycles = [];
    jest.spyOn(https, 'request').mockImplementation((_options, callback) => {
      const upstreamReq = makeProxyReq();
      cycles.push({ upstreamReq, responseHandler: callback });
      return upstreamReq;
    });

    const sendRequest = async (requestId, body, usage, purpose) => {
      const bodyBuffer = Buffer.from(JSON.stringify(body));
      const req = new EventEmitter();
      req.url = '/v1/responses';
      req.method = 'POST';
      req.headers = {
        'content-type': 'application/json',
        'content-length': String(bodyBuffer.length),
        'x-request-id': requestId,
      };
      if (purpose) req.awfRequestContext = { purpose };
      const res = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

      proxyRequest(req, res, 'api.githubcopilot.com', { Authorization: '******' }, 'copilot');
      req.emit('data', bodyBuffer);
      req.emit('end');
      await flushPromises();

      const cycle = cycles.at(-1);
      expect(cycle.upstreamReq.write).toHaveBeenCalledTimes(1);
      const writtenBody = JSON.parse(cycle.upstreamReq.write.mock.calls[0][0].toString());
      completeUpstreamResponse(cycle.responseHandler, {
        body: usage === null ? null : { model: 'gpt-5-mini', usage },
      });
      await flushPromises();
      return writtenBody;
    };

    await sendRequest(
      'credit-crossing-80',
      { input: 'Count usage.' },
      { input_tokens: 32_000_000, output_tokens: 0 },
    );

    const classifier = await sendRequest(
      'credit-classifier',
      { input: 'Classify this request.' },
      null,
      'routing_classification',
    );
    expect(classifier).toEqual({ input: 'Classify this request.' });

    const input = [
      { role: 'user', content: 'Continue.' },
      { type: 'function_call', call_id: 'call-1', name: 'explore', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'Research complete.' },
    ];
    const delivered = [];
    for (const [threshold, inputTokens] of [
      [80, 4_000_000],
      [90, 2_000_000],
      [95, 1_600_000],
      [99, 0],
    ]) {
      const requestId = `credit-delivery-${threshold}`;
      const requestBody = {
        instructions: 'Keep working on the task.',
        input,
        stream: true,
      };
      const writtenBody = await sendRequest(
        requestId,
        requestBody,
        { input_tokens: inputTokens, output_tokens: 0 },
      );

      expect(writtenBody.instructions).toContain('Keep working on the task.');
      expect(writtenBody.instructions).toContain(`[AWF AI CREDIT WARNING] You have used ${threshold}%`);
      expect(writtenBody.instructions).not.toContain('[AWF TIME WARNING]');
      expect(writtenBody.input).toEqual(input);
      expect(writtenBody.stream).toBe(true);
      delivered.push(requestId);
    }

    expect(getAndClearPendingTimeoutSteeringMessage()).toBeNull();
    await closeTokenUsageLog();
    const tokenRecords = fs.readFileSync(path.join(tokenLogDir, 'token-usage.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    for (const threshold of [80, 90, 95, 99]) {
      const requestId = `credit-delivery-${threshold}`;
      expect(tokenRecords.find(record => record.request_id === requestId).steering).toEqual({
        type: 'ai_credit',
        threshold,
      });
    }
    expect(delivered).toEqual([80, 90, 95, 99].map(value => `credit-delivery-${value}`));
  });

  it('rejects an unsupported effort after model routing and token steering', async () => {
    replaceRuntimeModels('copilot', [{
      id: 'gpt-5-mini',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    }]);
    let responseHandler;
    const upstreamReq = makeProxyReq();
    jest.spyOn(https, 'request').mockImplementationOnce((_opts, cb) => {
      responseHandler = cb;
      return upstreamReq;
    });

    const firstReq = new EventEmitter();
    firstReq.url = '/v1/chat/completions';
    firstReq.method = 'POST';
    firstReq.headers = { 'content-type': 'application/json' };
    const firstRes = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    proxyRequest(firstReq, firstRes, 'api.githubcopilot.com', { Authorization: '******' }, 'copilot');
    firstReq.emit('end');
    await flushPromises();
    completeUpstreamResponse(responseHandler, {
      statusCode: 200,
      body: { model: 'gpt-4o', usage: { prompt_tokens: 0, completion_tokens: 21 } },
    });

    const invalidBody = Buffer.from(JSON.stringify({
      model: 'routed-model',
      reasoning_effort: 'short',
      messages: [{ role: 'user', content: 'Second request' }],
    }));
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', 'content-length': String(invalidBody.length) };
    const res = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    const routeToMini = body => {
      const parsed = JSON.parse(body.toString('utf8'));
      parsed.model = 'gpt-5-mini';
      return Buffer.from(JSON.stringify(parsed));
    };

    proxyRequest(req, res, 'api.githubcopilot.com', { Authorization: '******' }, 'copilot', '', routeToMini);
    req.emit('data', invalidBody);
    req.emit('end');
    await flushPromises();

    expect(https.request).toHaveBeenCalledTimes(1);
    expect(getAndClearPendingSteeringMessage()).toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_reasoning_effort',
        message: 'reasoning_effort "short" is not supported by model gpt-5-mini; supported values: [low medium high]',
      },
    });
  });

  it('does not inject any warning when AWF_ENABLE_TOKEN_STEERING is not set', async () => {
    // Disable token steering for this test
    delete process.env.AWF_ENABLE_TOKEN_STEERING;

    // Re-require proxyRequest from the cached server module so it shares the same
    // proxy-request module instance as the steering functions (set in top-level beforeAll).
    // This ensures the same module instance handles both the threshold crossing
    // and the body injection.
    const { proxyRequest: localProxyRequest } = require('./server');

    let responseHandler;
    const upstreamReq1 = makeProxyReq();
    const upstreamReq2 = makeProxyReq();

    jest.spyOn(https, 'request')
      .mockImplementationOnce((_opts, cb) => { responseHandler = cb; return upstreamReq1; })
      .mockImplementationOnce(() => upstreamReq2);

    // Request 1: triggers 84 effective tokens (21 output × 4.0) → 84% of 100 → would cross 80% if steering enabled
    const req1 = new EventEmitter();
    req1.url = '/v1/chat/completions';
    req1.method = 'POST';
    req1.headers = { 'content-type': 'application/json' };
    const res1 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    localProxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('end');
    await flushPromises();

    completeUpstreamResponse(responseHandler, {
      statusCode: 200,
      body: { model: 'gpt-4o', usage: { prompt_tokens: 0, completion_tokens: 21 } },
    });

    // Request 2: steering is disabled, so no warning should be injected.
    const req2Body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'Hello' }],
    }));
    const req2 = new EventEmitter();
    req2.url = '/v1/chat/completions';
    req2.method = 'POST';
    req2.headers = { 'content-type': 'application/json', 'content-length': String(req2Body.length) };
    const res2 = { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };

    localProxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('data', req2Body);
    req2.emit('end');
    await flushPromises();

    expect(upstreamReq2.write).toHaveBeenCalledTimes(1);
    const writtenBody2 = JSON.parse(upstreamReq2.write.mock.calls[0][0].toString());
    const systemMessages = writtenBody2.messages.filter(m => m.role === 'system' && m.content.includes('[AWF TOKEN WARNING]'));
    expect(systemMessages).toHaveLength(0);
  });

  describe('injectSteeringMessage', () => {
    const WARNING = '[AWF TOKEN WARNING] Test warning message.';

    it('injects into OpenAI messages array after existing system messages', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      }));
      const result = injectSteeringMessage(body, 'openai', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.messages[1].role).toBe('system');
      expect(parsed.messages[1].content).toBe(WARNING);
      expect(parsed.messages[2].role).toBe('user');
    });

    it('injects system message at position 0 when no existing system message', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const result = injectSteeringMessage(body, 'openai', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.messages[0].role).toBe('system');
      expect(parsed.messages[0].content).toBe(WARNING);
    });

    it('injects into Anthropic string system field', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-opus-4-5',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const result = injectSteeringMessage(body, 'anthropic', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(typeof parsed.system).toBe('string');
      expect(parsed.system).toContain('You are a helpful assistant.');
      expect(parsed.system).toContain(WARNING);
    });

    it('appends text block to Anthropic array system field', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-opus-4-5',
        system: [{ type: 'text', text: 'Original system.' }],
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const result = injectSteeringMessage(body, 'anthropic', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(Array.isArray(parsed.system)).toBe(true);
      expect(parsed.system).toHaveLength(2);
      expect(parsed.system[1]).toEqual({ type: 'text', text: WARNING });
    });

    it('creates system field in Anthropic body when absent', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-opus-4-5',
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const result = injectSteeringMessage(body, 'anthropic', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.system).toBe(WARNING);
    });

    it('injects into Gemini systemInstruction', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gemini-2.0-flash',
        systemInstruction: { parts: [{ text: 'Be helpful.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      }));
      const result = injectSteeringMessage(body, 'gemini', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.systemInstruction.parts).toHaveLength(2);
      expect(parsed.systemInstruction.parts[1]).toEqual({ text: WARNING });
    });

    it('creates systemInstruction in Gemini body when absent', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gemini-2.0-flash',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      }));
      const result = injectSteeringMessage(body, 'gemini', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.systemInstruction).toEqual({ parts: [{ text: WARNING }] });
    });

    it('returns null for non-JSON body', () => {
      const body = Buffer.from('not json');
      const result = injectSteeringMessage(body, 'openai', WARNING);
      expect(result).toBeNull();
    });

    it('returns null for OpenAI body without messages array', () => {
      const body = Buffer.from(JSON.stringify({ model: 'gpt-4o' }));
      const result = injectSteeringMessage(body, 'openai', WARNING);
      expect(result).toBeNull();
    });
  });
});
