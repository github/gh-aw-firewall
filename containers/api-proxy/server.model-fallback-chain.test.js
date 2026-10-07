/**
 * Tests for the ordered model fallback chain (AWF_FALLBACK_MODELS) across the
 * provider adapters: a model-specific upstream failure is retried with the
 * next model in the chain, while credential and rate-limit failures are not.
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
let _setSleepForTests;
let _resetSleepForTests;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  ({ _setSleepForTests, _resetSleepForTests } = require('./proxy-request'));
  _setSleepForTests(() => Promise.resolve());
  return { proxyRequest };
});

afterAll(() => {
  _resetSleepForTests();
});

const PROVIDERS = [
  {
    provider: 'openai',
    host: 'api.openai.com',
    path: '/v1/chat/completions',
    headers: { Authorization: '******' },
    modelError: '{"error":{"message":"The model `gpt-9` does not exist","code":"model_not_found"}}',
    modelErrorStatus: 404,
  },
  {
    provider: 'anthropic',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    headers: { 'x-api-key': 'test' },
    modelError: '{"type":"error","error":{"type":"not_found_error","message":"model: claude-9"}}',
    modelErrorStatus: 404,
  },
  {
    provider: 'copilot',
    host: 'api.githubcopilot.com',
    path: '/chat/completions',
    headers: { Authorization: '******' },
    modelError: '{"error":{"message":"model \\"gpt-9\\" is not accessible via the /chat/completions endpoint","code":"unsupported_api_for_model"}}',
    modelErrorStatus: 400,
  },
];

describe('proxyRequest ordered model fallback chain', () => {
  let stdoutWriteSpy;
  let responseHandlers;
  let capturedOptions;
  let proxyReqs;
  const originalFallbackModels = process.env.AWF_FALLBACK_MODELS;

  beforeEach(() => {
    process.env.AWF_FALLBACK_MODELS = 'fallback-a, fallback-b';
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    responseHandlers = [];
    capturedOptions = [];
    proxyReqs = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      const proxyReq = makeProxyReq();
      proxyReqs.push(proxyReq);
      return proxyReq;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFallbackModels === undefined) delete process.env.AWF_FALLBACK_MODELS;
    else process.env.AWF_FALLBACK_MODELS = originalFallbackModels;
  });

  function sentModel(index) {
    const written = proxyReqs[index].write.mock.calls.map(([chunk]) => chunk);
    return JSON.parse(Buffer.concat(written).toString('utf8')).model;
  }

  async function startRequest({ provider, host, path, headers }, body = { model: 'primary', messages: [] }) {
    const req = makeReqFactory(path);
    const res = makeRes();
    proxyRequest(req, res, host, headers, provider);
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    await flushPromises();
    return { req, res };
  }

  function respond(index, status, body) {
    const proxyRes = makeProxyRes(status);
    responseHandlers[index](proxyRes);
    if (body) proxyRes.emit('data', Buffer.from(body));
    proxyRes.emit('end');
    return proxyRes;
  }

  describe.each(PROVIDERS)('$provider adapter', (cfg) => {
    it('falls back to the next model on a 5xx and records the model used', async () => {
      const { req, res } = await startRequest(cfg);
      expect(sentModel(0)).toBe('primary');

      respond(0, 503, '{"error":"overloaded"}');
      await flushPromises();

      expect(capturedOptions).toHaveLength(2);
      expect(sentModel(1)).toBe('fallback-a');
      expect(capturedOptions[1].headers['content-length']).toBe(
        String(Buffer.concat(proxyReqs[1].write.mock.calls.map(([c]) => c)).length),
      );
      expect(res.writeHead).not.toHaveBeenCalledWith(503, expect.anything());
      expect(req.awfModelFallback).toMatchObject({
        requested_model: 'primary',
        model: 'fallback-a',
        attempt: 1,
        reason: 'upstream_5xx',
        status: 503,
      });

      const logs = getStructuredLogs(stdoutWriteSpy, 'model_fallback');
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ provider: cfg.provider, from_model: 'primary', to_model: 'fallback-a', status: 503 });

      respond(1, 200, '{"ok":true}');
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

    it('falls back on a model-specific error response', async () => {
      await startRequest(cfg);
      respond(0, cfg.modelErrorStatus, cfg.modelError);
      await flushPromises();
      if (cfg.provider === 'copilot') {
        expect(sentModel(1)).toBe('primary');
        expect(capturedOptions[1].path).toBe('/responses');
        respond(1, cfg.modelErrorStatus, cfg.modelError);
        await flushPromises();
      }
      expect(sentModel(capturedOptions.length - 1)).toBe('fallback-a');
    });

    it('walks the full chain then surfaces the last error', async () => {
      const { res } = await startRequest(cfg);
      respond(0, 500, '{"error":"boom"}');
      await flushPromises();
      respond(1, 502, '{"error":"bad gateway"}');
      await flushPromises();
      expect(capturedOptions).toHaveLength(3);
      expect(sentModel(2)).toBe('fallback-b');

      // Chain exhausted: the final error is streamed straight to the client.
      const last = respond(2, 500, '{"error":"still broken"}');
      await flushPromises();
      expect(capturedOptions).toHaveLength(3);
      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
      expect(res.end).toHaveBeenCalledWith(Buffer.from('{"error":"still broken"}'));
    });

    it.each([401, 403, 429])('does not fall back on %i', async (status) => {
      const { res } = await startRequest(cfg);
      respond(0, status, '{"error":"model_not_supported"}');
      await flushPromises();
      expect(capturedOptions).toHaveLength(1);
      expect(res.writeHead).toHaveBeenCalledWith(status, expect.any(Object));
    });

    it('does not fall back on a generic 400 validation error', async () => {
      const { res } = await startRequest(cfg);
      respond(0, 400, '{"error":{"message":"invalid tool schema"}}');
      await flushPromises();
      expect(capturedOptions).toHaveLength(1);
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    it('falls back when the upstream connection fails before a response', async () => {
      const { res } = await startRequest(cfg);
      proxyReqs[0].emit('error', new Error('ETIMEDOUT'));
      await flushPromises();
      expect(capturedOptions).toHaveLength(2);
      expect(sentModel(1)).toBe('fallback-a');
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('skips a fallback entry equal to the requested model', async () => {
      await startRequest(cfg, { model: 'fallback-a', messages: [] });
      respond(0, 500, '{"error":"boom"}');
      await flushPromises();
      expect(sentModel(1)).toBe('fallback-b');
    });

    it('passes 5xx through unchanged when no fallback chain is configured', async () => {
      delete process.env.AWF_FALLBACK_MODELS;
      const { res } = await startRequest(cfg);
      const proxyRes = makeProxyRes(503);
      responseHandlers[0](proxyRes);
      expect(proxyRes.pipe).toHaveBeenCalledWith(res);
      expect(capturedOptions).toHaveLength(1);
    });
  });

  describe('gemini adapter', () => {
    it('rewrites the model in the upstream path', async () => {
      const req = makeReqFactory('/v1beta/models/gemini-primary:generateContent');
      const res = makeRes();
      proxyRequest(req, res, 'generativelanguage.googleapis.com', { 'x-goog-api-key': 'test' }, 'gemini');
      req.emit('data', Buffer.from('{"contents":[]}'));
      req.emit('end');
      await flushPromises();

      expect(capturedOptions[0].path).toContain('/models/gemini-primary:generateContent');
      respond(0, 404, '{"error":{"code":404,"message":"models/gemini-primary is not found for API version v1beta"}}');
      await flushPromises();

      expect(capturedOptions).toHaveLength(2);
      expect(capturedOptions[1].path).toContain('/models/fallback-a:generateContent');
      expect(req.awfModelFallback).toMatchObject({ requested_model: 'gemini-primary', model: 'fallback-a' });
      respond(1, 200, '{"ok":true}');
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });
  });
});
