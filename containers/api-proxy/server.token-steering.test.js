/**
 * Tests for runtime/AI-credit steering and injectSteeringMessage.
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
let getAndClearPendingTimeoutSteeringMessage;
let getAiCreditsReflectState;
let getPendingAiCreditSteeringWarning;
let injectSteeringMessage;
let resetAiCreditsGuardForTests;
let resetTimeoutSteeringForTests;
let replaceRuntimeModels;
let clearRuntimeModels;
let timeoutRuntimeDir;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  ({ closeLogStream: closeTokenUsageLog } = require('./token-tracker'));
  ({
    getAndClearPendingTimeoutSteeringMessage,
    injectSteeringMessage,
    resetTimeoutSteeringForTests,
  } = require('./proxy-request'));
  ({
    getAiCreditsReflectState,
    getPendingAiCreditSteeringWarning,
    resetAiCreditsGuardForTests,
  } = require('./guards/ai-credits-guard'));
  ({ replaceRuntimeModels, clearRuntimeModels } = require('./runtime-model-catalog'));
  return {
    proxyRequest,
    getAndClearPendingTimeoutSteeringMessage,
    getAiCreditsReflectState,
    getPendingAiCreditSteeringWarning,
    injectSteeringMessage,
    resetAiCreditsGuardForTests,
    resetTimeoutSteeringForTests,
    replaceRuntimeModels,
    clearRuntimeModels,
  };
});

// Budget notices go only on requests that end with tool results; the opening
// user message identifies the conversation.
const chatToolResult = (opening = 'Continue.') => ({
  messages: [
    { role: 'user', content: opening },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'contents' },
  ],
});

describe('budget steering and injectSteeringMessage', () => {
  // injectSteeringMessage is loaded here
  // for unit-level tests (pure function tests).
  // Integration tests that verify steering injection end-to-end use two
  // proxyRequest calls so that the same module instance that runs inside the
  // proxy handles both the threshold crossing and the body injection.

  beforeEach(() => {
    timeoutRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-timeout-steering-'));
    process.env.AWF_ENABLE_TOKEN_STEERING = 'true';
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_MODEL_MULTIPLIERS;
    delete process.env.AWF_DEFAULT_MODEL_MULTIPLIER;
    delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
    process.env.AWF_AGENT_RUNTIME_START_FILE = path.join(timeoutRuntimeDir, 'started-at-ms');
    resetAiCreditsGuardForTests();
    resetTimeoutSteeringForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_ENABLE_TOKEN_STEERING;
    delete process.env.AWF_MODEL_MULTIPLIERS;
    delete process.env.AWF_DEFAULT_MODEL_MULTIPLIER;
    delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
    delete process.env.AWF_AGENT_RUNTIME_START_FILE;
    resetAiCreditsGuardForTests();
    resetTimeoutSteeringForTests();
    clearRuntimeModels();
    fs.rmSync(timeoutRuntimeDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await closeTokenUsageLog();
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
    expect(msg95).toContain('95%');
    // The superseded 90% notice is dropped once the 95% notice is delivered.
    expect(getAndClearPendingTimeoutSteeringMessage()).toBeNull();
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

    const req2Body = Buffer.from(JSON.stringify(chatToolResult('Second request')));
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
    expect(writtenBody2.messages.slice(0, 3)).toEqual(chatToolResult('Second request').messages);
    expect(writtenBody2.messages[3].role).toBe('user');
    expect(writtenBody2.messages[3].content).toContain('[AWF TIME WARNING]');
    expect(writtenBody2.messages[3].content).toContain('80%');
  });

  it('injects Copilot Messages steering after the final user content, leaving system unchanged', async () => {
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

    const toolResultMessages = [
      { role: 'user', content: 'Start.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'Second request' }] },
    ];
    const makeCopilotRequest = (content) => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-sonnet-4',
        system: 'Be helpful.',
        messages: content === null ? toolResultMessages : [{ role: 'user', content }],
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
    await makeCopilotRequest(null);

    expect(upstreamReq2.write).toHaveBeenCalledTimes(1);
    const writtenBody = JSON.parse(upstreamReq2.write.mock.calls[0][0].toString());
    expect(writtenBody.system).toBe('Be helpful.');
    expect(writtenBody.messages).toEqual([
      ...toolResultMessages.slice(0, 2),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu-1', content: 'Second request' },
          { type: 'text', text: expect.stringContaining('[AWF TIME WARNING]') },
        ],
      },
    ]);
    expect(writtenBody.messages[2].content[1].text).toContain('80%');
  });

  it('steers gh-aw default AI-credit-only Copilot Responses requests end to end', async () => {
    process.env.AWF_MAX_AI_CREDITS = '1000';
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

    const input = [
      { role: 'user', content: 'Continue.' },
      { type: 'function_call', call_id: 'call-1', name: 'explore', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'Research complete.' },
    ];
    const requestBody = {
      instructions: 'Keep working on the task.',
      input,
      stream: true,
    };
    const baseline = await sendRequest('credit-baseline', requestBody, null);
    const baselineBuffer = cycles.at(-1).upstreamReq.write.mock.calls[0][0];

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

    const delivered = [];
    for (const [threshold, inputTokens] of [
      [80, 4_000_000],
      [90, 2_000_000],
      [95, 1_600_000],
      [99, 0],
    ]) {
      const requestId = `credit-delivery-${threshold}`;
      const writtenBody = await sendRequest(
        requestId,
        requestBody,
        { input_tokens: inputTokens, output_tokens: 0 },
      );

      const writtenBuffer = cycles.at(-1).upstreamReq.write.mock.calls[0][0];
      const prefixEnd = baselineBuffer.indexOf(Buffer.from(JSON.stringify(input)))
        + Buffer.byteLength(JSON.stringify(input)) - 1;
      expect(writtenBuffer.subarray(0, prefixEnd)).toEqual(baselineBuffer.subarray(0, prefixEnd));
      expect(writtenBody.input).toHaveLength(input.length + 1);
      const notice = writtenBody.input.pop();
      expect(notice).toEqual({
        type: 'message',
        role: 'developer',
        content: expect.stringContaining(`[AWF AI CREDIT WARNING] You have used ${threshold}%`),
      });
      expect(notice.content).not.toContain('[AWF TIME WARNING]');
      expect(Buffer.from(JSON.stringify(writtenBody))).toEqual(baselineBuffer);
      delivered.push(requestId);
    }

    expect(await sendRequest('credit-after-notices', requestBody, null)).toEqual(baseline);
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
    process.env.AWF_MAX_AI_CREDITS = '1';
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
      body: { model: 'gpt-5-mini', usage: { prompt_tokens: 32_000, completion_tokens: 0 } },
    });
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([80]);

    const invalidBody = Buffer.from(JSON.stringify({
      model: 'routed-model',
      reasoning_effort: 'short',
      messages: [{ role: 'user', content: 'Second request' }],
    }));
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', 'content-length': String(invalidBody.length) };
    const res = Object.assign(new EventEmitter(), {
      headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn(),
    });
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
    res.emit('close');
    // The rejected request never reached the provider, so its notice stays pending.
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([80]);
    expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);
  });

  it('redelivers a notice after a failed request and never follows it with a superseded one', async () => {
    process.env.AWF_MAX_AI_CREDITS = '1';
    const cycles = [];
    jest.spyOn(https, 'request').mockImplementation((_options, callback) => {
      const upstreamReq = makeProxyReq();
      cycles.push({ upstreamReq, responseHandler: callback });
      return upstreamReq;
    });

    const sendRequest = async (requestId, response) => {
      const body = Buffer.from(JSON.stringify(chatToolResult()));
      const req = new EventEmitter();
      req.url = '/v1/chat/completions';
      req.method = 'POST';
      req.headers = {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'x-request-id': requestId,
      };
      const res = Object.assign(new EventEmitter(), {
        headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn(),
      });
      proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai');
      req.emit('data', body);
      req.emit('end');
      await flushPromises();
      const cycle = cycles.at(-1);
      const writtenBody = JSON.parse(cycle.upstreamReq.write.mock.calls[0][0].toString());
      completeUpstreamResponse(cycle.responseHandler, response);
      await flushPromises();
      if (response.statusCode === undefined || (response.statusCode >= 200 && response.statusCode < 300)) {
        res.writableFinished = true;
        res.emit('finish');
      }
      res.emit('close');
      const notice = writtenBody.messages.find(message => message.content?.includes('[AWF AI CREDIT WARNING]'));
      return notice ? notice.content : null;
    };

    // One expensive request crosses both 80% and 90%.
    expect(await sendRequest('expensive', {
      body: { model: 'gpt-5-mini', usage: { prompt_tokens: 36_000, completion_tokens: 0 } },
    })).toBeNull();
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([80, 90]);

    const failed = await sendRequest('upstream-error', { statusCode: 500, body: { error: { message: 'boom' } } });
    expect(failed).toContain('90%');
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([80, 90]);

    const delivered = await sendRequest('redelivered', { body: { model: 'gpt-5-mini', usage: { prompt_tokens: 1, completion_tokens: 0 } } });
    expect(delivered).toContain('90%');
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([]);

    expect(await sendRequest('after-notice', { body: { model: 'gpt-5-mini', usage: { prompt_tokens: 1, completion_tokens: 0 } } }))
      .toBeNull();
  });

  it('leaves a notice pending when the client disconnects before dispatch', async () => {
    process.env.AWF_MAX_AI_CREDITS = '1';
    let responseHandler;
    jest.spyOn(https, 'request').mockImplementation((_options, callback) => {
      responseHandler = callback;
      return makeProxyReq();
    });
    const firstReq = new EventEmitter();
    firstReq.url = '/v1/chat/completions';
    firstReq.method = 'POST';
    firstReq.headers = { 'content-type': 'application/json' };
    proxyRequest(firstReq, { headersSent: false, setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() },
      'api.openai.com', { Authorization: '******' }, 'openai');
    firstReq.emit('end');
    await flushPromises();
    completeUpstreamResponse(responseHandler, {
      body: { model: 'gpt-5-mini', usage: { prompt_tokens: 32_000, completion_tokens: 0 } },
    });
    expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);

    const body = Buffer.from(JSON.stringify(chatToolResult('Disconnected')));
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
    const res = Object.assign(new EventEmitter(), {
      headersSent: false, destroyed: true, writableFinished: false,
      setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn(),
    });
    proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai');
    req.emit('data', body);
    req.emit('end');
    await flushPromises();

    expect(req.awfSteering).toEqual({
      type: 'ai_credit', threshold: 80, conversation: expect.stringMatching(/^[0-9a-f]{12}$/), first: false,
    });
    expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);
  });

  describe('notice delivery completion', () => {
    let cycles;

    const makeRequest = async (requestId, {
      provider = 'openai',
      targetHost = 'api.openai.com',
      url = '/v1/responses',
      requestBody = {
        model: 'gpt-5-mini',
        input: [
          { role: 'user', content: 'Continue.' },
          { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: requestId },
        ],
      },
    } = {}) => {
      const body = Buffer.from(JSON.stringify(requestBody));
      const req = new EventEmitter();
      req.url = url;
      req.method = 'POST';
      req.headers = {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'x-request-id': requestId,
      };
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writableFinished: false,
        statusCode: 200,
        setHeader: jest.fn(),
        writeHead: jest.fn(function writeHead(statusCode) {
          this.headersSent = true;
          this.statusCode = statusCode;
        }),
        end: jest.fn(function end() {
          this.writableFinished = true;
          this.emit('finish');
        }),
      });
      proxyRequest(req, res, targetHost, { Authorization: '******' }, provider);
      req.emit('data', body);
      req.emit('end');
      await flushPromises();
      const cycle = cycles.at(-1);
      return {
        req,
        res,
        cycle,
        body: JSON.parse(cycle.upstreamReq.write.mock.calls[0][0].toString()),
      };
    };

    const seedPendingNotice = async () => {
      const initial = await makeRequest('cross-credit-threshold');
      completeUpstreamResponse(initial.cycle.responseHandler, {
        body: { model: 'gpt-5-mini', usage: { prompt_tokens: 36_000, completion_tokens: 0 } },
      });
      initial.res.writableFinished = true;
      initial.res.emit('finish');
      await flushPromises();
      expect(getPendingAiCreditSteeringWarning()).not.toBeNull();
    };

    const noticeIn = body => body.input.some(item =>
      item.role === 'developer' && item.content.includes('[AWF AI CREDIT WARNING]'));

    const steeringRecordsFor = async requestIds => {
      await closeTokenUsageLog();
      return fs.readFileSync(path.join(tokenLogDir, 'token-usage.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
        .filter(record => requestIds.includes(record.request_id) && record.steering);
    };

    beforeEach(() => {
      process.env.AWF_MAX_AI_CREDITS = '1';
      cycles = [];
      jest.spyOn(https, 'request').mockImplementation((_options, callback) => {
        const upstreamReq = makeProxyReq();
        cycles.push({ upstreamReq, responseHandler: callback });
        return upstreamReq;
      });
    });

    const startStream = cycle => {
      const proxyRes = new EventEmitter();
      proxyRes.statusCode = 200;
      proxyRes.headers = { 'content-type': 'text/event-stream' };
      proxyRes.pipe = jest.fn();
      cycle.responseHandler(proxyRes);
      return proxyRes;
    };

    it('does not repeat a notice when the client closes after response.completed but before upstream EOF', async () => {
      await seedPendingNotice();
      const delivered = await makeRequest('completed-stream');
      expect(noticeIn(delivered.body)).toBe(true);

      const proxyRes = startStream(delivered.cycle);
      proxyRes.emit('data', Buffer.from('data: {"type":"response.completed","response":{}}\n\n'));
      delivered.res.emit('close');

      const next = await makeRequest('after-completed-stream');
      expect(noticeIn(next.body)).toBe(false);
    });

    it('counts a 2xx stream that ends with response.failed as delivered', async () => {
      await seedPendingNotice();
      const failed = await makeRequest('failed-stream');
      expect(noticeIn(failed.body)).toBe(true);

      const proxyRes = startStream(failed.cycle);
      proxyRes.emit('data', Buffer.from('data: {"type":"response.failed","response":{"error":{"code":"failed"}}}\n\n'));
      proxyRes.emit('end');
      failed.res.emit('close');

      const next = await makeRequest('after-failed-stream');
      expect(noticeIn(next.body)).toBe(false);
    });

    it('does not repeat a non-streaming notice when the client closes before finish', async () => {
      await seedPendingNotice();
      const interrupted = await makeRequest('interrupted-response');
      expect(noticeIn(interrupted.body)).toBe(true);

      const proxyRes = new EventEmitter();
      proxyRes.statusCode = 200;
      proxyRes.headers = { 'content-type': 'application/json' };
      proxyRes.pipe = jest.fn();
      interrupted.cycle.responseHandler(proxyRes);
      proxyRes.emit('data', Buffer.from('{"id":"response"}'));
      proxyRes.emit('end');
      interrupted.res.emit('close');

      const retry = await makeRequest('retry-interrupted-response');
      expect(noticeIn(retry.body)).toBe(false);
    });

    it('records a usage-bearing non-streaming notice once when the client closes before finish', async () => {
      await seedPendingNotice();
      const interrupted = await makeRequest('interrupted-usage-response');
      expect(noticeIn(interrupted.body)).toBe(true);

      const proxyRes = new EventEmitter();
      proxyRes.statusCode = 200;
      proxyRes.headers = { 'content-type': 'application/json' };
      proxyRes.pipe = jest.fn();
      interrupted.cycle.responseHandler(proxyRes);
      proxyRes.emit('data', Buffer.from(JSON.stringify({
        model: 'gpt-5-mini',
        usage: { input_tokens: 1, output_tokens: 0 },
      })));
      proxyRes.emit('end');
      interrupted.res.emit('close');

      const retry = await makeRequest('retry-interrupted-usage-response');
      expect(noticeIn(retry.body)).toBe(false);
      completeUpstreamResponse(retry.cycle.responseHandler, {
        body: { model: 'gpt-5-mini', usage: { input_tokens: 1, output_tokens: 0 } },
      });
      await flushPromises();

      const records = await steeringRecordsFor(['interrupted-usage-response', 'retry-interrupted-usage-response']);
      expect(records.map(record => record.request_id)).toEqual(['interrupted-usage-response']);
    });

    it('does not repeat a notice when a Gemini JSON stream closes before upstream EOF', async () => {
      await seedPendingNotice();
      const gemini = requestId => makeRequest(requestId, {
        provider: 'gemini',
        targetHost: 'generativelanguage.googleapis.com',
        url: '/v1beta/models/gemini-2.5-pro:streamGenerateContent',
        requestBody: {
          contents: [
            { role: 'user', parts: [{ text: 'Continue.' }] },
            { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: requestId } } }] },
          ],
        },
      });
      const geminiNoticeIn = body => JSON.stringify(body.contents.at(-1))
        .includes('[AWF AI CREDIT WARNING]');
      const geminiReply = JSON.stringify([{
        modelVersion: 'gemini-2.5-pro',
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }]);

      const interrupted = await gemini('interrupted-gemini-stream');
      expect(geminiNoticeIn(interrupted.body)).toBe(true);

      const proxyRes = new EventEmitter();
      proxyRes.statusCode = 200;
      proxyRes.headers = { 'content-type': 'application/json' };
      proxyRes.pipe = jest.fn();
      interrupted.cycle.responseHandler(proxyRes);
      proxyRes.emit('data', Buffer.from(geminiReply.slice(0, 20)));
      interrupted.res.emit('close');

      const retry = await gemini('retry-interrupted-gemini-stream');
      expect(geminiNoticeIn(retry.body)).toBe(false);

      proxyRes.emit('data', Buffer.from(geminiReply.slice(20)));
      proxyRes.emit('end');
      const retryRes = new EventEmitter();
      retryRes.statusCode = 200;
      retryRes.headers = { 'content-type': 'application/json' };
      retryRes.pipe = jest.fn();
      retry.cycle.responseHandler(retryRes);
      retryRes.emit('data', Buffer.from(geminiReply));
      retryRes.emit('end');
      await flushPromises();

      const records = await steeringRecordsFor(['interrupted-gemini-stream', 'retry-interrupted-gemini-stream']);
      expect(records.length).toBeLessThanOrEqual(1);
      expect(records.map(record => record.request_id)).not.toContain('retry-interrupted-gemini-stream');
    });

    it('delivers a notice to each conversation and records steering once per threshold', async () => {
      await seedPendingNotice();
      const conversation = (opening, requestId) => ({
        model: 'gpt-5-mini',
        input: [
          { role: 'user', content: opening },
          { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: requestId },
        ],
      });
      const complete = request => completeUpstreamResponse(request.cycle.responseHandler, {
        body: { model: 'gpt-5-mini', usage: { input_tokens: 1, output_tokens: 0 } },
      });

      const main = await makeRequest('main-notice', { requestBody: conversation('Main task.', 'main-notice') });
      const sub = await makeRequest('sub-notice', { requestBody: conversation('Sub-agent task.', 'sub-notice') });
      expect(noticeIn(main.body)).toBe(true);
      expect(noticeIn(sub.body)).toBe(true);
      complete(sub);
      complete(main);
      await flushPromises();

      const mainAgain = await makeRequest('main-again', { requestBody: conversation('Main task.', 'main-again') });
      expect(noticeIn(mainAgain.body)).toBe(false);
      complete(mainAgain);
      await flushPromises();

      await closeTokenUsageLog();
      const records = fs.readFileSync(path.join(tokenLogDir, 'token-usage.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      const recordFor = requestId => records.find(record => record.request_id === requestId);
      expect(recordFor('sub-notice').steering).toEqual({ type: 'ai_credit', threshold: 90 });
      expect(recordFor('sub-notice').steering_delivery).toEqual({
        type: 'ai_credit', threshold: 90, conversation: expect.stringMatching(/^[0-9a-f]{12}$/), first: true,
      });
      expect(recordFor('main-notice').steering).toBeUndefined();
      expect(recordFor('main-notice').steering_delivery).toEqual({
        type: 'ai_credit', threshold: 90, conversation: expect.stringMatching(/^[0-9a-f]{12}$/), first: false,
      });
      expect(recordFor('main-notice').steering_delivery.conversation)
        .not.toBe(recordFor('sub-notice').steering_delivery.conversation);
      expect(recordFor('main-again').steering_delivery).toBeUndefined();
    });

    it('redelivers a notice when the client disconnects before the upstream response arrives', async () => {
      await seedPendingNotice();
      const abandoned = await makeRequest('abandoned-request');
      expect(noticeIn(abandoned.body)).toBe(true);

      abandoned.res.emit('close');
      startStream(abandoned.cycle);

      const retry = await makeRequest('retry-abandoned-request');
      expect(noticeIn(retry.body)).toBe(true);
    });
  });

  it('does not inject any warning when AWF_ENABLE_TOKEN_STEERING is not set', async () => {
    // Disable token steering for this test
    delete process.env.AWF_ENABLE_TOKEN_STEERING;
    process.env.AWF_MAX_AI_CREDITS = '1000';

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

    // Cross the AI-credit threshold, but keep steering disabled.
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
      body: { model: 'gpt-4o', usage: { prompt_tokens: 3_200_000, completion_tokens: 0 } },
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
    expect(writtenBody2.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  describe('injectSteeringMessage', () => {
    const WARNING = '[AWF AI CREDIT WARNING] Test warning message.';

    it('appends a final user message to OpenAI messages after the last tool message', () => {
      const messages = [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'result' },
      ];
      const body = Buffer.from(JSON.stringify({ model: 'gpt-4o', messages }));
      const result = injectSteeringMessage(body, 'openai', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.messages).toEqual([...messages, { role: 'user', content: WARNING }]);
    });

    it('does not add an OpenAI system message', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const parsed = JSON.parse(injectSteeringMessage(body, 'openai', WARNING).toString());
      expect(parsed.messages).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'user', content: WARNING },
      ]);
    });

    it('returns null for OpenAI messages ending in an assistant message or empty', () => {
      expect(injectSteeringMessage(Buffer.from(JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Prefill' }],
      })), 'openai', WARNING)).toBeNull();
      expect(injectSteeringMessage(Buffer.from(JSON.stringify({ messages: [] })), 'openai', WARNING)).toBeNull();
    });

    it('leaves the Anthropic string system field unchanged', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-opus-4-5',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      const result = injectSteeringMessage(body, 'anthropic', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.system).toBe('You are a helpful assistant.');
      expect(parsed.messages).toEqual([{
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: WARNING }],
      }]);
    });

    it('appends a text block after Anthropic tool_result blocks in the final user message', () => {
      const system = [{ type: 'text', text: 'Original system.', cache_control: { type: 'ephemeral' } }];
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'f', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-1', content: 'result', cache_control: { type: 'ephemeral' } },
          ],
        },
      ];
      const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-5', system, messages }));
      const result = injectSteeringMessage(body, 'anthropic', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.system).toEqual(system);
      expect(parsed.messages.slice(0, 2)).toEqual(messages.slice(0, 2));
      expect(parsed.messages[2].content).toEqual([
        messages[2].content[0],
        { type: 'text', text: WARNING },
      ]);
    });

    it('does not create an Anthropic system field when absent', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'claude-opus-4-5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      }));
      const parsed = JSON.parse(injectSteeringMessage(body, 'anthropic', WARNING).toString());
      expect(parsed).not.toHaveProperty('system');
      expect(parsed.messages[0].content.at(-1)).toEqual({ type: 'text', text: WARNING });
    });

    it('returns null for Anthropic messages ending in an assistant prefill or empty', () => {
      expect(injectSteeringMessage(Buffer.from(JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Prefill' }],
      })), 'anthropic', WARNING)).toBeNull();
      expect(injectSteeringMessage(Buffer.from(JSON.stringify({ messages: [] })), 'anthropic', WARNING)).toBeNull();
      expect(injectSteeringMessage(Buffer.from(JSON.stringify({
        messages: [{ role: 'user', content: null }],
      })), 'anthropic', WARNING)).toBeNull();
    });

    it('appends a text part after Gemini function responses, leaving systemInstruction unchanged', () => {
      const contents = [
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }] },
      ];
      const body = Buffer.from(JSON.stringify({
        model: 'gemini-2.0-flash',
        systemInstruction: { parts: [{ text: 'Be helpful.' }] },
        contents,
      }));
      const result = injectSteeringMessage(body, 'gemini', WARNING);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result.toString());
      expect(parsed.systemInstruction).toEqual({ parts: [{ text: 'Be helpful.' }] });
      expect(parsed.contents.slice(0, 2)).toEqual(contents.slice(0, 2));
      expect(parsed.contents[2].parts).toEqual([...contents[2].parts, { text: WARNING }]);
    });

    it('does not create Gemini systemInstruction when absent', () => {
      const body = Buffer.from(JSON.stringify({
        model: 'gemini-2.0-flash',
        contents: [{ parts: [{ text: 'Hello' }] }],
      }));
      const parsed = JSON.parse(injectSteeringMessage(body, 'gemini', WARNING).toString());
      expect(parsed).not.toHaveProperty('systemInstruction');
      expect(parsed.contents).toEqual([{ parts: [{ text: 'Hello' }, { text: WARNING }] }]);
    });

    it('adds a Gemini user turn after a final function-role turn', () => {
      const contents = [{ role: 'function', parts: [{ functionResponse: { name: 'f', response: {} } }] }];
      const parsed = JSON.parse(injectSteeringMessage(
        Buffer.from(JSON.stringify({ contents })), 'gemini', WARNING,
      ).toString());
      expect(parsed.contents).toEqual([...contents, { role: 'user', parts: [{ text: WARNING }] }]);
    });

    it('returns null for Gemini contents ending in a model turn or empty', () => {
      expect(injectSteeringMessage(Buffer.from(JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }, { role: 'model', parts: [{ text: 'Hi' }] }],
      })), 'gemini', WARNING)).toBeNull();
      expect(injectSteeringMessage(Buffer.from(JSON.stringify({ contents: [] })), 'gemini', WARNING)).toBeNull();
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
