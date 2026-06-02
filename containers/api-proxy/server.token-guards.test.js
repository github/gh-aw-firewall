/**
 * Tests for proxyRequest guards: effective token limit (429) and
 * max-runs limit (429).
 *
 * Extracted from server.proxy.test.js.
 */

const https = require('https');
const { EventEmitter } = require('events');
const {
  makeReq: makeReqFactory,
  makeRes,
  setupServerTestEnv,
} = require('./test-helpers/server-mock-factories');

let proxyRequest;
let resetEffectiveTokenGuardForTests;
let resetMaxRunsGuardForTests;
let resetPermissionDeniedGuardForTests;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  ({
    resetEffectiveTokenGuardForTests,
    resetMaxRunsGuardForTests,
    resetPermissionDeniedGuardForTests,
  } = require('./proxy-request'));
  return { proxyRequest, resetEffectiveTokenGuardForTests, resetMaxRunsGuardForTests, resetPermissionDeniedGuardForTests };
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
    return makeReqFactory('/v1/chat/completions', headers);
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

  it('returns 403 with structured payload when permission denied limit is exceeded', () => {
    let responseHandler;
    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      responseHandler = cb;
      return upstreamRequest;
    });

    // First request returns 403 from upstream — triggers the permission denied counter
    const req1 = makeReq();
    const res1 = makeRes();
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: '******' }, 'openai');
    req1.emit('end');

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 403;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.pipe = jest.fn();

    responseHandler(proxyRes);
    proxyRes.emit('end');

    // Second request — permission denied limit is now exceeded
    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: '******' }, 'openai');
    req2.emit('end');

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res2.writeHead).toHaveBeenCalledWith(403, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('permission_denied_limit_exceeded');
    expect(payload.error.max_permission_denied).toBe(1);
    expect(payload.error.denied_count).toBe(1);
  });

  it('also triggers on 401 upstream responses', () => {
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
    proxyRequest(req1, res1, 'api.openai.com', { Authorization: '******' }, 'openai');
    req1.emit('end');

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 401;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.pipe = jest.fn();

    responseHandler(proxyRes);
    proxyRes.emit('end');

    const req2 = makeReq();
    const res2 = makeRes();
    proxyRequest(req2, res2, 'api.openai.com', { Authorization: '******' }, 'openai');
    req2.emit('end');

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(res2.end.mock.calls[0][0]);
    expect(payload.error.type).toBe('permission_denied_limit_exceeded');
  });

  it('allows requests when permission denied limit is not configured', () => {
    delete process.env.AWF_MAX_PERMISSION_DENIED;
    resetPermissionDeniedGuardForTests();

    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    const httpsRequestSpy = jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai');
    req.emit('end');

    expect(httpsRequestSpy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).not.toHaveBeenCalledWith(403, expect.anything());
  });
});
