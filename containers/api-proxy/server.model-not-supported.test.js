/**
 * Tests for the transient Copilot "400 model not supported" retry logic.
 *
 * When the Copilot catalogue API returns a model set that does not include the
 * requested model, the proxy retries the request up to MAX_MODEL_NOT_SUPPORTED_RETRIES
 * times with a configurable backoff delay before surfacing the error to the caller.
 */

const https = require('https');
const {
  makeReq: makeReqFactory,
  makeRes,
  makeProxyReq,
  makeProxyRes,
  getStructuredLogs,
  setupServerTestEnv,
} = require('./test-helpers/server-mock-factories');

let proxyRequest;
let _setSleepForTests;
let _resetSleepForTests;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  ({ _setSleepForTests, _resetSleepForTests } = require('./proxy-request'));
  // Make retries instant — no real setTimeout delays in unit tests.
  _setSleepForTests(() => Promise.resolve());
  return { proxyRequest, _setSleepForTests, _resetSleepForTests };
});

afterAll(() => {
  _resetSleepForTests();
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeReq(headers = {}) {
  return makeReqFactory('/v1/chat/completions', headers);
}

/** Flush all pending microtasks/promises so async retry callbacks can run. */
function flushPromises() {
  return new Promise(resolve => setImmediate(resolve));
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('proxyRequest copilot model-not-supported retry', () => {
  let stdoutWriteSpy;
  let responseHandlers;
  let capturedOptions;

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

  it('retries once after Copilot returns 400 model not supported, then succeeds', async () => {
    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.githubcopilot.com', { Authorization: '******' }, 'copilot');
    req.emit('end');
    await flushPromises();

    expect(capturedOptions).toHaveLength(1);

    // First response: 400 model not supported
    const firstResponse = makeProxyRes(400);
    responseHandlers[0](firstResponse);
    firstResponse.emit('data', Buffer.from(
      '{"message":"The requested model is not supported"}'
    ));
    firstResponse.emit('end');

    await flushPromises();

    // Retry should have been dispatched
    expect(capturedOptions).toHaveLength(2);

    // Second response: 200 success
    const secondResponse = makeProxyRes(200);
    responseHandlers[1](secondResponse);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'x-request-id': expect.any(String),
    }));

    const retryLogs = getStructuredLogs(stdoutWriteSpy, 'model_not_supported_retry');
    expect(retryLogs).toHaveLength(1);
    expect(retryLogs[0]).toMatchObject({
      provider: 'copilot',
      retry_attempt: 1,
      max_retries: 2,
    });
  });

  it('retries a second time when the first retry also returns 400 model not supported', async () => {
    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.githubcopilot.com', { Authorization: '******' }, 'copilot');
    req.emit('end');
    await flushPromises();

    // First attempt: 400 model not supported → retry 1
    const resp1 = makeProxyRes(400);
    responseHandlers[0](resp1);
    resp1.emit('data', Buffer.from('{"message":"The requested model is not supported"}'));
    resp1.emit('end');
    await flushPromises();

    expect(capturedOptions).toHaveLength(2);

    // Retry 1: 400 model not supported → retry 2
    const resp2 = makeProxyRes(400);
    responseHandlers[1](resp2);
    resp2.emit('data', Buffer.from('{"message":"The requested model is not supported"}'));
    resp2.emit('end');
    await flushPromises();

    expect(capturedOptions).toHaveLength(3);

    // Retry 2: 200 success
    const resp3 = makeProxyRes(200);
    responseHandlers[2](resp3);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });

  it('surfaces the 400 to the client after exhausting all retries', async () => {
    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.githubcopilot.com', { Authorization: '******' }, 'copilot');
    req.emit('end');
    await flushPromises();

    const errorBody = '{"message":"The requested model is not supported"}';

    // All 3 attempts return 400 model not supported
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = makeProxyRes(400);
      responseHandlers[attempt](resp);
      resp.emit('data', Buffer.from(errorBody));
      resp.emit('end');
      await flushPromises();
    }

    // 3 total attempts (original + 2 retries), no 4th
    expect(capturedOptions).toHaveLength(3);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
      'x-request-id': expect.any(String),
    }));
    expect(res.end).toHaveBeenCalledWith(Buffer.from(errorBody));
  });

  it('does not retry a 400 that is not model-not-supported', async () => {
    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.githubcopilot.com', { Authorization: '******' }, 'copilot');
    req.emit('end');
    await flushPromises();

    const resp = makeProxyRes(400);
    responseHandlers[0](resp);
    resp.emit('data', Buffer.from('{"message":"max_tokens exceeded"}'));
    resp.emit('end');
    await flushPromises();

    // No retry for unrelated 400
    expect(capturedOptions).toHaveLength(1);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  it('does not retry model-not-supported for non-copilot providers', async () => {
    const req = makeReq();
    const res = makeRes();
    // Use openai provider — model-not-supported retry only applies to copilot
    proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai');
    req.emit('end');
    await flushPromises();

    const resp = makeProxyRes(400);
    responseHandlers[0](resp);
    resp.emit('data', Buffer.from('{"message":"The requested model is not supported"}'));
    resp.emit('end');
    await flushPromises();

    expect(capturedOptions).toHaveLength(1);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  it('sends an identical request body on retry', async () => {
    const capturedBodies = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      const proxyReq = makeProxyReq();
      proxyReq.write = jest.fn(chunk => capturedBodies.push(chunk));
      return proxyReq;
    });

    const req = makeReq();
    const requestPayload = '{"model":"claude-opus-4.6","messages":[{"role":"user","content":"hi"}]}';
    const res = makeRes();
    proxyRequest(req, res, 'api.githubcopilot.com', { Authorization: '******' }, 'copilot');
    req.emit('data', Buffer.from(requestPayload));
    req.emit('end');
    await flushPromises();

    const resp1 = makeProxyRes(400);
    responseHandlers[0](resp1);
    resp1.emit('data', Buffer.from('{"message":"The requested model is not supported"}'));
    resp1.emit('end');
    await flushPromises();

    expect(capturedOptions).toHaveLength(2);
    // Both attempts should carry the same body
    expect(capturedBodies[0].toString()).toBe(capturedBodies[1].toString());

    const resp2 = makeProxyRes(200);
    responseHandlers[1](resp2);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });
});
