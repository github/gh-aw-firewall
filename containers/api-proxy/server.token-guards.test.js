/**
 * Tests for proxyRequest guards: effective token limit (429) and
 * max-runs limit (429).
 *
 * Extracted from server.proxy.test.js.
 */

const https = require('https');
const { EventEmitter } = require('events');

const originalHttpsProxy = process.env.HTTPS_PROXY;
let proxyRequest;
let resetEffectiveTokenGuardForTests;
let resetMaxRunsGuardForTests;

beforeAll(() => {
  delete process.env.HTTPS_PROXY;
  jest.resetModules();
  ({ proxyRequest } = require('./server'));
  ({
    resetEffectiveTokenGuardForTests,
    resetMaxRunsGuardForTests,
  } = require('./proxy-request'));
});

afterAll(() => {
  if (originalHttpsProxy === undefined) {
    delete process.env.HTTPS_PROXY;
  } else {
    process.env.HTTPS_PROXY = originalHttpsProxy;
  }
  jest.resetModules();
});

describe('proxyRequest effective token guard', () => {
  function makeReq(headers = {}) {
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', ...headers };
    return req;
  }

  function makeRes() {
    return {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn(),
    };
  }

  beforeEach(() => {
    // Keep the cap small so one tiny mocked usage payload deterministically exceeds it.
    // Environment variables are strings; parser converts this to Number(10).
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '10';
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    resetEffectiveTokenGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    resetEffectiveTokenGuardForTests();
    jest.restoreAllMocks();
  });

  it('returns 429 with structured payload when effective token limit is reached', () => {
    let responseHandler;
    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      responseHandler = cb;
      return upstreamRequest;
    });

    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('end');

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.pipe = jest.fn();

    responseHandler(proxyRes);
    const usageBody = JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    });
    proxyRes.emit('data', Buffer.from(usageBody));
    proxyRes.emit('end');

    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('end');

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res2.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('effective_tokens_limit_exceeded');
    expect(payload.error.max_effective_tokens).toBe(10);
    expect(payload.error.total_effective_tokens).toBeGreaterThanOrEqual(10);
  });
});

describe('proxyRequest max-runs guard', () => {
  function makeReq(headers = {}) {
    const req = new EventEmitter();
    req.url = '/v1/chat/completions';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', ...headers };
    return req;
  }

  function makeRes() {
    return {
      headersSent: false,
      setHeader: jest.fn(),
      writeHead: jest.fn(),
      end: jest.fn(),
    };
  }

  beforeEach(() => {
    process.env.AWF_MAX_RUNS = '1';
    resetMaxRunsGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_RUNS;
    resetMaxRunsGuardForTests();
    jest.restoreAllMocks();
  });

  it('returns 429 with structured payload when max runs limit is exceeded', () => {
    let responseHandler;
    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      responseHandler = cb;
      return upstreamRequest;
    });

    // First request completes successfully — consumes the single allowed run
    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req1.emit('end');

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.pipe = jest.fn();

    responseHandler(proxyRes);
    proxyRes.emit('end');

    // Second request — max-runs limit is now exceeded
    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req2.emit('end');

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res2.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('max_runs_exceeded');
    expect(payload.error.max_runs).toBe(1);
    expect(payload.error.invocation_count).toBe(1);
  });

  it('allows requests when max runs is not configured', () => {
    delete process.env.AWF_MAX_RUNS;
    resetMaxRunsGuardForTests();

    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req.emit('end');

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).not.toHaveBeenCalledWith(429, expect.anything());
  });
});
