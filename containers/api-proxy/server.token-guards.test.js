/**
 * Tests for proxyRequest guards: effective token limit (429) and
 * max-runs limit (429).
 *
 * Extracted from server.proxy.test.js.
 */

const https = require('https');
const {
  makeReq: makeReqFactory,
  makeRes,
  makeProxyReq,
  getStructuredLogs,
  setupServerTestEnv,
  flushPromises,
  createMockUpstreamCycle,
  completeUpstreamResponse,
} = require('./test-helpers/server-mock-factories');

let proxyRequest;
let resetEffectiveTokenGuardForTests;
let resetMaxRunsGuardForTests;
let resetMaxCacheMissesGuardForTests;
let resetPermissionDeniedGuardForTests;
let resetMaxModelMultiplierGuardForTests;
let resetAiCreditsGuardForTests;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  ({
    resetEffectiveTokenGuardForTests,
    resetMaxRunsGuardForTests,
    resetMaxCacheMissesGuardForTests,
    resetPermissionDeniedGuardForTests,
    resetMaxModelMultiplierGuardForTests,
    resetAiCreditsGuardForTests,
  } = require('./proxy-request'));
  return { proxyRequest, resetEffectiveTokenGuardForTests, resetMaxRunsGuardForTests, resetMaxCacheMissesGuardForTests, resetPermissionDeniedGuardForTests, resetMaxModelMultiplierGuardForTests, resetAiCreditsGuardForTests };
});

describe('proxyRequest effective token guard', () => {
  function makeReq(headers = {}) {
    return makeReqFactory('/v1/chat/completions', headers);
  }

  beforeEach(() => {
    // Keep the cap small so one tiny mocked usage payload deterministically exceeds it.
    // Environment variables are strings; parser converts this to Number(10).
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '10';
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    resetEffectiveTokenGuardForTests();
    resetAiCreditsGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    resetEffectiveTokenGuardForTests();
    resetAiCreditsGuardForTests();
    jest.restoreAllMocks();
  });

  it('returns 429 with structured payload when effective token limit is reached', async () => {
    const cycle = createMockUpstreamCycle(https);

    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: '******' }, 'openai');
    req1.emit('end');
    await flushPromises();

    completeUpstreamResponse(cycle.responseHandler, {
      statusCode: 200,
      body: { model: 'gpt-4o', usage: { prompt_tokens: 2, completion_tokens: 3 } },
    });

    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: '******' }, 'openai');
    req2.emit('end');
    await flushPromises();

    expect(cycle.spy).toHaveBeenCalledTimes(1);
    expect(res2.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('effective_tokens_limit_exceeded');
    expect(payload.error.max_effective_tokens).toBe(10);
    expect(payload.error.total_effective_tokens).toBeGreaterThanOrEqual(10);
  });

  it('logs ai credits for each response usage update', async () => {
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cycle = createMockUpstreamCycle(https);

    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai');
    req.emit('end');
    await flushPromises();

    completeUpstreamResponse(cycle.responseHandler, {
      statusCode: 200,
      body: { model: 'gpt-5-mini', usage: { prompt_tokens: 1000, completion_tokens: 500 } },
    });

    const budgetLogs = getStructuredLogs(writeSpy, 'token_budget_usage');
    expect(budgetLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ai_credits_this_response: 0.125,
        ai_credits_total: 0.125,
      }),
    ]));
    expect(process.env.AWF_AI_CREDITS_USED).toBe('0.125');

    writeSpy.mockRestore();
  });
});

describe('proxyRequest max-runs guard', () => {
  function makeReq(headers = {}) {
    return makeReqFactory('/v1/chat/completions', headers);
  }

  beforeEach(() => {
    process.env.AWF_MAX_RUNS = '1';
    resetMaxRunsGuardForTests();
  });

  describe('proxyRequest max-cache-misses guard', () => {
    function makeReq(headers = {}) {
      return makeReqFactory('/v1/chat/completions', headers);
    }

    beforeEach(() => {
      delete process.env.AWF_MAX_RUNS;
      resetMaxRunsGuardForTests();
      process.env.AWF_MAX_CACHE_MISSES = '2';
      resetMaxCacheMissesGuardForTests();
    });

    afterEach(() => {
      delete process.env.AWF_MAX_CACHE_MISSES;
      delete process.env.AWF_MAX_RUNS;
      resetMaxRunsGuardForTests();
      resetMaxCacheMissesGuardForTests();
      jest.restoreAllMocks();
    });

    it('returns 429 after max consecutive cache misses with non-zero input tokens', async () => {
      const cycle = createMockUpstreamCycle(https);

      const req1 = makeReq();
      const res1 = makeRes();
      proxyRequest(req1, res1, 'api.openai.com', { Authorization: '******' }, 'openai');
      req1.emit('end');
      await flushPromises();
      completeUpstreamResponse(cycle.responseHandler, {
        statusCode: 200,
        body: { model: 'gpt-4o', usage: { prompt_tokens: 50, completion_tokens: 10 } },
      });

      const req2 = makeReq();
      const res2 = makeRes();
      proxyRequest(req2, res2, 'api.openai.com', { Authorization: '******' }, 'openai');
      req2.emit('end');
      await flushPromises();
      completeUpstreamResponse(cycle.responseHandler, {
        statusCode: 200,
        body: { model: 'gpt-4o', usage: { prompt_tokens: 25, completion_tokens: 5 } },
      });

      const req3 = makeReq();
      const res3 = makeRes();
      proxyRequest(req3, res3, 'api.openai.com', { Authorization: '******' }, 'openai');
      req3.emit('end');
      await flushPromises();

      expect(cycle.spy).toHaveBeenCalledTimes(2);
      expect(res3.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
        'Content-Type': 'application/json',
      }));
      const payload = JSON.parse(res3.end.mock.calls[0][0]);
      expect(payload.error.type).toBe('max_cache_misses_exceeded');
      expect(payload.error.max_cache_misses).toBe(2);
      expect(payload.error.consecutive_cache_misses).toBe(2);
    });

    it('resets miss streak after a response with cache_read_tokens', async () => {
      const cycle = createMockUpstreamCycle(https);

      const req1 = makeReq();
      const res1 = makeRes();
      proxyRequest(req1, res1, 'api.openai.com', { Authorization: '******' }, 'openai');
      req1.emit('end');
      await flushPromises();
      completeUpstreamResponse(cycle.responseHandler, {
        statusCode: 200,
        body: { model: 'gpt-4o', usage: { prompt_tokens: 40, completion_tokens: 10 } },
      });

      const req2 = makeReq();
      const res2 = makeRes();
      proxyRequest(req2, res2, 'api.openai.com', { Authorization: '******' }, 'openai');
      req2.emit('end');
      await flushPromises();
      completeUpstreamResponse(cycle.responseHandler, {
        statusCode: 200,
        body: {
          model: 'gpt-4o',
          usage: { prompt_tokens: 40, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } },
        },
      });

      const req3 = makeReq();
      const res3 = makeRes();
      proxyRequest(req3, res3, 'api.openai.com', { Authorization: '******' }, 'openai');
      req3.emit('end');
      await flushPromises();

      expect(cycle.spy).toHaveBeenCalledTimes(3);
      expect(res3.writeHead).not.toHaveBeenCalledWith(429, expect.anything());
    });
  });

  afterEach(() => {
    delete process.env.AWF_MAX_RUNS;
    resetMaxRunsGuardForTests();
    jest.restoreAllMocks();
  });

  it('returns 429 with structured payload when max runs limit is exceeded', async () => {
    const cycle = createMockUpstreamCycle(https);

    // First request completes successfully — consumes the single allowed run
    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: '******' }, 'openai');
    req1.emit('end');
    await flushPromises();

    completeUpstreamResponse(cycle.responseHandler, { statusCode: 200 });

    // Second request — max-runs limit is now exceeded
    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: '******' }, 'openai');
    req2.emit('end');
    await flushPromises();

    expect(cycle.spy).toHaveBeenCalledTimes(1);
    expect(res2.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('max_runs_exceeded');
    expect(payload.error.max_runs).toBe(1);
    expect(payload.error.invocation_count).toBe(1);
  });

  it('allows requests when max runs is not configured', async () => {
    delete process.env.AWF_MAX_RUNS;
    resetMaxRunsGuardForTests();


    const upstreamRequest = makeProxyReq();
    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);
    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req.emit('end');
    await flushPromises();

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).not.toHaveBeenCalledWith(429, expect.anything());
  });
});

describe('proxyRequest max-ai-credits guard', () => {
  function makeReq(headers = {}) {
    return makeReqFactory('/v1/chat/completions', headers);
  }

  beforeEach(() => {
    process.env.AWF_MAX_AI_CREDITS = '0.1';
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    resetEffectiveTokenGuardForTests();
    resetAiCreditsGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_AI_CREDITS;
    resetEffectiveTokenGuardForTests();
    resetAiCreditsGuardForTests();
    jest.restoreAllMocks();
  });

  it('returns 429 with structured payload when ai credits limit is reached', async () => {
    const cycle = createMockUpstreamCycle(https);

    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: '******' }, 'openai');
    req1.emit('end');
    await flushPromises();

    completeUpstreamResponse(cycle.responseHandler, {
      statusCode: 200,
      body: { model: 'gpt-5-mini', usage: { prompt_tokens: 1000, completion_tokens: 500 } },
    });

    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: '******' }, 'openai');
    req2.emit('end');
    await flushPromises();

    expect(cycle.spy).toHaveBeenCalledTimes(1);
    expect(res2.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('ai_credits_limit_exceeded');
    expect(payload.error.max_ai_credits).toBe(0.1);
    expect(payload.error.total_ai_credits).toBeGreaterThanOrEqual(0.1);
  });
});

describe('proxyRequest permission-denied guard', () => {
  function makeReq(headers = {}) {
    return makeReqFactory('/v1/chat/completions', headers);
  }

  beforeEach(() => {
    process.env.AWF_MAX_PERMISSION_DENIED = '1';
    resetPermissionDeniedGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_PERMISSION_DENIED;
    resetPermissionDeniedGuardForTests();
    jest.restoreAllMocks();
  });

  it('returns 403 with structured payload when permission denied limit is exceeded', async () => {
    const cycle = createMockUpstreamCycle(https);

    // First request returns 403 from upstream — triggers the permission denied counter
    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: '******' }, 'openai');
    req1.emit('end');
    await flushPromises();

    completeUpstreamResponse(cycle.responseHandler, { statusCode: 403 });

    // Second request — permission denied limit is now exceeded
    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: '******' }, 'openai');
    req2.emit('end');
    await flushPromises();

    expect(cycle.spy).toHaveBeenCalledTimes(1);
    expect(res2.writeHead).toHaveBeenCalledWith(403, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('permission_denied_limit_exceeded');
    expect(payload.error.max_permission_denied).toBe(1);
    expect(payload.error.denied_count).toBe(1);
  });

  it('also triggers on 401 upstream responses', async () => {
    const cycle = createMockUpstreamCycle(https);

    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: '******' }, 'openai');
    req1.emit('end');
    await flushPromises();

    completeUpstreamResponse(cycle.responseHandler, { statusCode: 401 });

    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: '******' }, 'openai');
    req2.emit('end');
    await flushPromises();

    expect(cycle.spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('permission_denied_limit_exceeded');
  });

  it('allows requests when permission denied limit is not configured', async () => {
    delete process.env.AWF_MAX_PERMISSION_DENIED;
    resetPermissionDeniedGuardForTests();

    const upstreamRequest = makeProxyReq();
    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai');
    req.emit('end');
    await flushPromises();

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).not.toHaveBeenCalledWith(403, expect.anything());
  });
});

describe('proxyRequest max-model-multiplier guard', () => {
  function makeModelReq(body, headers = {}) {
    const req = makeReqFactory('/v1/messages', headers);
    const bodyBuf = Buffer.from(body);
    const originalEmit = req.emit.bind(req);
    req.emit = function(event, ...args) {
      if (event === 'end') {
        originalEmit('data', bodyBuf);
      }
      return originalEmit(event, ...args);
    };
    return req;
  }

  beforeEach(() => {
    process.env.AWF_MAX_MODEL_MULTIPLIER = '5';
    process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({
      'claude-opus-4.7': 27,
      'gpt-4o': 2,
    });
    resetMaxModelMultiplierGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_MODEL_MULTIPLIER;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    resetMaxModelMultiplierGuardForTests();
    jest.restoreAllMocks();
  });

  it('returns 400 when the requested model multiplier exceeds the cap', async () => {
    jest.spyOn(https, 'request').mockImplementation(() => makeProxyReq());

    const body = JSON.stringify({ model: 'claude-opus-4.7', messages: [{ role: 'user', content: 'hi' }] });
    const req = makeModelReq(body);
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();

    expect(https.request).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('model_multiplier_cap_exceeded');
    expect(payload.error.model).toBe('claude-opus-4.7');
    expect(payload.error.model_multiplier).toBe(27);
    expect(payload.error.max_model_multiplier).toBe(5);
  });

  it('allows requests when the model multiplier is within the cap', async () => {
    const upstreamRequest = makeProxyReq();
    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

    const body = JSON.stringify({ model: 'gpt-4o', messages: [] });
    const req = makeModelReq(body);
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai');
    req.emit('end');
    await flushPromises();

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).not.toHaveBeenCalledWith(400, expect.anything());
  });

  it('allows requests when AWF_MAX_MODEL_MULTIPLIER is not configured', async () => {
    delete process.env.AWF_MAX_MODEL_MULTIPLIER;
    resetMaxModelMultiplierGuardForTests();

    const upstreamRequest = makeProxyReq();
    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

    const body = JSON.stringify({ model: 'claude-opus-4.7', messages: [] });
    const req = makeModelReq(body);
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).not.toHaveBeenCalledWith(400, expect.anything());
  });

  it('does not enforce model multiplier guard on GET requests', async () => {
    const upstreamRequest = makeProxyReq();
    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

    const body = JSON.stringify({ model: 'claude-opus-4.7', messages: [] });
    const req = makeModelReq(body);
    req.method = 'GET';
    const res = makeRes();
    proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic');
    req.emit('end');
    await flushPromises();

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).not.toHaveBeenCalledWith(400, expect.anything());
  });
});
