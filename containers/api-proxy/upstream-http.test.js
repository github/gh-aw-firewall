const {
  createSendUpstreamRequest,
  MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS,
  rebuildBodyFramingHeaders,
} = require('./upstream-http');
const { clearRuntimeModels, replaceRuntimeModels } = require('./runtime-model-catalog');
const { translateCopilotWireApi } = require('./wire-api-compat');

describe('upstream-http', () => {
  afterEach(() => clearRuntimeModels());

  test('rebuilds body framing headers case-insensitively', () => {
    expect(rebuildBodyFramingHeaders({
      'Content-Length': '10',
      'Transfer-Encoding': 'chunked',
      authorization: 'signed',
    }, 42)).toEqual({
      authorization: 'signed',
      'content-length': '42',
    });
  });

  function createContext(overrides = {}) {
    return {
      body: Buffer.from('{"ok":true}'),
      targetHost: 'api.example.com',
      upstreamPath: '/v1/chat/completions',
      req: { method: 'POST' },
      res: {},
      provider: 'copilot',
      requestId: 'req-1',
      startTime: Date.now(),
      span: {},
      requestBytes: 11,
      ...overrides,
    };
  }

  test('dispatches upstream HTTPS requests with proxy agent and request body', () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const httpsRequest = jest.fn((_options, cb) => {
      cb({ statusCode: 200, headers: {} });
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const proxyAgent = { keepAlive: true };

    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent,
      handleUpstreamResponse,
      sleep: jest.fn(() => Promise.resolve()),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
    });

    sendUpstreamRequest({ authorization: '******' }, createContext());

    expect(httpsRequest).toHaveBeenCalledWith(expect.objectContaining({
      hostname: 'api.example.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { authorization: '******' },
      agent: proxyAgent,
    }), expect.any(Function));
    expect(proxyReq.write).toHaveBeenCalledWith(Buffer.from('{"ok":true}'));
    expect(proxyReq.end).toHaveBeenCalled();
    expect(handleUpstreamResponse).toHaveBeenCalled();
  });

  test('does not let a scoped auto request escape through the global fallback chain', () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const handleUpstreamResponse = jest.fn();
    const getFallbackModels = jest.fn(() => ['gpt-5.4-mini']);
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: jest.fn((_options, callback) => {
        callback({ statusCode: 503, headers: {} });
        return proxyReq;
      }) },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
      getFallbackModels,
    });
    sendUpstreamRequest({}, createContext({
      body: Buffer.from('{"model":"claude-sonnet-4.6"}'),
      upstreamPath: '/v1/messages',
      req: { method: 'POST', awfScopedAuto: true },
    }));
    expect(getFallbackModels).not.toHaveBeenCalled();
    expect(handleUpstreamResponse.mock.calls[0][2].onModelFallback).toBeNull();
  });

  test('rebuilds the wire API request for the selected ordered fallback model', () => {
    replaceRuntimeModels('copilot', [
      { id: 'claude-sonnet-5', supportedEndpoints: ['/chat/completions'] },
      { id: 'gpt-5.4-mini', supportedEndpoints: ['/responses'] },
    ]);
    const sourceBody = Buffer.from(JSON.stringify({
      model: 'claude-sonnet-5',
      input: [{ role: 'user', content: 'hello' }],
    }));
    const translated = translateCopilotWireApi(sourceBody, '/v1/responses?foo=1');
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const responseCallbacks = [];
    const httpsRequest = jest.fn((options, cb) => {
      responseCallbacks.push(cb);
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(),
      otel: { endSpanError: jest.fn(), endSpan: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() },
      getFallbackModels: () => ['gpt-5.4-mini'],
    });
    const onEndpointTranslation = jest.fn();
    const req = {
      method: 'POST',
      url: '/v1/responses?foo=1',
      awfRouting: { onEndpointTranslation },
    };

    sendUpstreamRequest({ 'content-length': String(translated.body.length) }, createContext({
      body: translated.body,
      upstreamPath: '/v1/chat/completions?foo=1',
      req,
      res: { headersSent: false },
      wireApiCompatibility: translated.compatibility,
      wireApiSourceBody: sourceBody,
    }));
    responseCallbacks[0]({ statusCode: 503, headers: {} });
    expect(handleUpstreamResponse.mock.calls[0][2].onModelFallback({
      statusCode: 503,
      reason: 'upstream_5xx',
    })).toBe(true);

    expect(httpsRequest).toHaveBeenCalledTimes(2);
    expect(httpsRequest.mock.calls[1][0].path).toBe('/v1/responses?foo=1');
    expect(JSON.parse(proxyReq.write.mock.calls[1][0].toString())).toEqual({
      model: 'gpt-5.4-mini',
      input: [{ role: 'user', content: 'hello' }],
    });
    responseCallbacks[1]({ statusCode: 200, headers: {} });
    expect(handleUpstreamResponse.mock.calls[1][2].wireApiCompatibility).toEqual({
      requestedEndpoint: '/responses',
      upstreamEndpoint: '/responses',
      passthrough: true,
    });
    expect(onEndpointTranslation).toHaveBeenCalledWith({
      requestedEndpoint: '/responses',
      upstreamEndpoint: '/responses',
      passthrough: true,
    });
  });

  test('dispatches upstream HTTP requests on port 80 when targetScheme is http', () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const httpRequest = jest.fn((_options, cb) => {
      cb({ statusCode: 200, headers: {} });
      return proxyReq;
    });
    const httpsRequest = jest.fn();
    const handleUpstreamResponse = jest.fn();
    const proxyAgent = { keepAlive: true };

    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      http: { request: httpRequest },
      proxyAgent,
      handleUpstreamResponse,
      sleep: jest.fn(() => Promise.resolve()),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
    });

    sendUpstreamRequest({ authorization: '******' }, createContext({ targetScheme: 'http' }));

    expect(httpsRequest).not.toHaveBeenCalled();
    expect(httpRequest).toHaveBeenCalledWith(expect.objectContaining({
      hostname: 'api.example.com',
      port: 80,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { authorization: '******' },
      agent: proxyAgent,
    }), expect.any(Function));
    expect(proxyReq.write).toHaveBeenCalledWith(Buffer.from('{"ok":true}'));
    expect(proxyReq.end).toHaveBeenCalled();
    expect(handleUpstreamResponse).toHaveBeenCalled();
  });

  test('defaults to HTTPS on port 443 when targetScheme is omitted', () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const httpsRequest = jest.fn((_options, cb) => {
      cb({ statusCode: 200, headers: {} });
      return proxyReq;
    });

    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      http: { request: jest.fn() },
      proxyAgent: undefined,
      handleUpstreamResponse: jest.fn(),
      sleep: jest.fn(() => Promise.resolve()),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
    });

    sendUpstreamRequest({}, createContext());

    expect(httpsRequest).toHaveBeenCalledWith(expect.objectContaining({ port: 443 }), expect.any(Function));
  });

  test('applies model-not-supported backoff before recursive retry', async () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const responseCallbacks = [];
    const httpsRequest = jest.fn((_options, cb) => {
      responseCallbacks.push(cb);
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const sleep = jest.fn(() => Promise.resolve());

    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep,
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
    });

    sendUpstreamRequest({ authorization: '******' }, createContext());
    responseCallbacks[0]({ statusCode: 400, headers: {} });
    const firstCallCtx = handleUpstreamResponse.mock.calls[0][2];
    firstCallCtx.onModelNotSupportedRetry();
    await Promise.resolve();

    expect(sleep).toHaveBeenCalledWith(MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS[0]);
    expect(httpsRequest).toHaveBeenCalledTimes(2);
  });

  test('signs every upstream attempt with the final body', async () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const responseCallbacks = [];
    const httpsRequest = jest.fn((_options, cb) => {
      responseCallbacks.push(cb);
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const requestSigner = jest.fn(({ headers, body }) => ({
      ...headers,
      authorization: `signed-${body.toString('utf8')}`,
    }));
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(() => Promise.resolve()),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
    });

    sendUpstreamRequest({}, createContext({ requestSigner }));
    responseCallbacks[0]({ statusCode: 400, headers: {} });
    handleUpstreamResponse.mock.calls[0][2].onModelNotSupportedRetry();
    await Promise.resolve();

    expect(requestSigner).toHaveBeenCalledTimes(2);
    expect(httpsRequest.mock.calls[0][0].headers.authorization).toBe('signed-{"ok":true}');
    expect(httpsRequest.mock.calls[1][0].headers.authorization).toBe('signed-{"ok":true}');
  });

  test('fails closed without opening an upstream request when signing fails', () => {
    const httpsRequest = jest.fn();
    const handleRequestError = jest.fn();
    const endSpanError = jest.fn();
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse: jest.fn(),
      sleep: jest.fn(),
      otel: { endSpanError },
      handleRequestError,
      metrics: { increment: jest.fn(), observe: jest.fn() },
    });
    const error = new Error('AWS temporary credentials are unavailable');

    sendUpstreamRequest({}, createContext({
      requestSigner: () => { throw error; },
    }));

    expect(httpsRequest).not.toHaveBeenCalled();
    expect(endSpanError).toHaveBeenCalledWith(expect.anything(), error, 503);
    expect(handleRequestError).toHaveBeenCalledWith(error, expect.objectContaining({
      statusCode: 503,
      clientMessage: 'AWS request signing unavailable',
    }));
  });

  test.each([true, false])('rechecks model guards on scoped endpoint retries (eligible candidate: %s)', eligible => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const responseCallbacks = [];
    const httpsRequest = jest.fn((_options, callback) => {
      responseCallbacks.push(callback);
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const isFallbackModelPermitted = jest.fn(model => eligible && model === 'claude-haiku-4.5');
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
      isFallbackModelPermitted,
    });
    const req = {
      method: 'POST',
      awfScopedAuto: true,
      awfModelCandidates: ['claude-sonnet-4.6', 'claude-opus-5', 'claude-haiku-4.5'],
    };
    sendUpstreamRequest({}, createContext({
      body: Buffer.from('{"model":"claude-sonnet-4.6","messages":[]}'),
      upstreamPath: '/v1/messages',
      req,
    }));
    responseCallbacks[0]({ statusCode: 400, headers: {} });
    expect(handleUpstreamResponse.mock.calls[0][2].onModelEndpointBlockedRetry()).toBe(eligible);
    expect(isFallbackModelPermitted).toHaveBeenCalledWith('claude-opus-5', 'copilot');
    expect(isFallbackModelPermitted).toHaveBeenCalledWith('claude-haiku-4.5', 'copilot');
    expect(httpsRequest).toHaveBeenCalledTimes(eligible ? 2 : 1);
    if (eligible) {
      expect(JSON.parse(proxyReq.write.mock.calls[1][0]).model).toBe('claude-haiku-4.5');
    }
  });

  test('reframes and re-signs endpoint-blocked fallback bodies', () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const responseCallbacks = [];
    const httpsRequest = jest.fn((_options, cb) => {
      responseCallbacks.push(cb);
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const requestSigner = jest.fn(({ headers }) => ({
      ...headers,
      authorization: 'fresh-signature',
    }));
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
    });
    const originalBody = Buffer.from('{"model":"a","messages":[]}');
    const req = {
      method: 'POST',
      awfModelCandidates: ['a', 'much-longer-model-name'],
    };

    sendUpstreamRequest({
      'content-length': String(originalBody.length),
      'transfer-encoding': 'chunked',
    }, createContext({
      body: originalBody,
      requestBytes: originalBody.length,
      req,
      requestSigner,
    }));
    responseCallbacks[0]({ statusCode: 400, headers: {} });
    const retried = handleUpstreamResponse.mock.calls[0][2].onModelEndpointBlockedRetry();

    const retryBody = Buffer.from('{"model":"much-longer-model-name","messages":[]}');
    expect(retried).toBe(true);
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    responseCallbacks[1]({ statusCode: 200, headers: {} });
    expect(httpsRequest.mock.calls[1][0].headers).toEqual(expect.objectContaining({
      'content-length': String(retryBody.length),
      authorization: 'fresh-signature',
    }));
    expect(httpsRequest.mock.calls[1][0].headers).not.toHaveProperty('transfer-encoding');
    expect(proxyReq.write).toHaveBeenLastCalledWith(retryBody);
    expect(handleUpstreamResponse.mock.calls[1][2].requestBytes).toBe(retryBody.length);
    expect(requestSigner).toHaveBeenLastCalledWith(expect.objectContaining({
      body: retryBody,
      headers: expect.objectContaining({ 'content-length': String(retryBody.length) }),
    }));
  });

  test.each(['ordered fallback', 'endpoint-blocked fallback'])(
    'rejects unsupported reasoning effort after %s rewrites the model',
    (fallbackType) => {
      replaceRuntimeModels('copilot', [
        { id: 'initial-model', supportedReasoningEfforts: ['low', 'high'] },
        { id: 'fallback-model', supportedReasoningEfforts: ['low'] },
      ]);
      const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
      const responseCallbacks = [];
      const httpsRequest = jest.fn((_options, cb) => {
        responseCallbacks.push(cb);
        return proxyReq;
      });
      const handleUpstreamResponse = jest.fn();
      const res = { headersSent: false, writeHead: jest.fn(), end: jest.fn() };
      const sendUpstreamRequest = createSendUpstreamRequest({
        https: { request: httpsRequest },
        proxyAgent: {},
        handleUpstreamResponse,
        sleep: jest.fn(),
        otel: { endSpanError: jest.fn(), endSpan: jest.fn() },
        handleRequestError: jest.fn(),
        metrics: { gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() },
        getFallbackModels: () => ['fallback-model'],
      });
      const req = {
        method: 'POST',
        url: '/v1/chat/completions',
        ...(fallbackType === 'endpoint-blocked fallback'
          ? { awfModelCandidates: ['initial-model', 'fallback-model'] }
          : {}),
      };
      const body = Buffer.from(JSON.stringify({
        model: 'initial-model',
        reasoning_effort: 'high',
        messages: [],
      }));

      sendUpstreamRequest({ 'content-length': String(body.length) }, createContext({
        body,
        requestBytes: body.length,
        req,
        res,
      }));

      if (fallbackType === 'ordered fallback') {
        const errorHandler = proxyReq.on.mock.calls.find(([event]) => event === 'error')[1];
        errorHandler(new Error('ECONNRESET'));
      } else {
        responseCallbacks[0]({ statusCode: 400, headers: {} });
        handleUpstreamResponse.mock.calls[0][2].onModelEndpointBlockedRetry();
      }

      expect(httpsRequest).toHaveBeenCalledTimes(1);
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({
        error: {
          code: 'unsupported_reasoning_effort',
          message: 'reasoning_effort "high" is not supported by model fallback-model; supported values: [low]',
        },
      });
    },
  );

    test('carries compatibility metadata forward across the endpoint-blocked retry', () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const responseCallbacks = [];
    const httpsRequest = jest.fn((_options, cb) => {
      responseCallbacks.push(cb);
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
    });
    const originalBody = Buffer.from('{"model":"a","messages":[]}');
    const req = { method: 'POST', awfModelCandidates: ['a', 'much-longer-model-name'] };
    const codexCompatibility = { customTools: new Set(['apply_patch']) };
    const wireApiCompatibility = {
      requestedEndpoint: '/chat/completions',
      upstreamEndpoint: '/responses',
      direction: 'chat_to_responses',
    };

    sendUpstreamRequest({ 'content-length': String(originalBody.length) }, createContext({
      body: originalBody,
      requestBytes: originalBody.length,
      req,
      codexCompatibility,
      wireApiCompatibility,
    }));
    responseCallbacks[0]({ statusCode: 400, headers: {} });
    handleUpstreamResponse.mock.calls[0][2].onModelEndpointBlockedRetry();
    responseCallbacks[1]({ statusCode: 200, headers: {} });

    // The retry rebuilds the body as a brand-new Buffer object; compatibility
    // metadata must not depend on the (now-stale) original buffer identity.
    expect(handleUpstreamResponse.mock.calls[1][2].codexCompatibility).toBe(codexCompatibility);
    expect(handleUpstreamResponse.mock.calls[1][2].wireApiCompatibility).toBe(wireApiCompatibility);
  });

  test('skips fallback models rejected by isFallbackModelPermitted', () => {
    const proxyReqs = [];
    const httpsRequest = jest.fn(() => {
      const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
      proxyReqs.push(proxyReq);
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const isFallbackModelPermitted = jest.fn(model => model !== 'blocked-model');
    const logRequest = jest.fn();

    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(() => Promise.resolve()),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
      logRequest,
      isFallbackModelPermitted,
      getFallbackModels: () => ['blocked-model', 'allowed-model'],
    });

    const req = { method: 'POST' };
    sendUpstreamRequest({ 'content-length': '17' }, createContext({
      req,
      res: { headersSent: false },
      body: Buffer.from('{"model":"first"}'),
    }));

    // Simulate a connection error before any response.
    const errorHandler = proxyReqs[0].on.mock.calls.find(([event]) => event === 'error')[1];
    errorHandler(new Error('ECONNRESET'));

    expect(isFallbackModelPermitted).toHaveBeenCalledWith('blocked-model', 'copilot');
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    expect(JSON.parse(proxyReqs[1].write.mock.calls[0][0].toString()).model).toBe('allowed-model');
    expect(req.awfModelFallback).toMatchObject({
      requested_model: 'first', model: 'allowed-model', reason: 'upstream_connection_error',
    });
    expect(logRequest).toHaveBeenCalledWith('warn', 'model_fallback', expect.objectContaining({
      from_model: 'first', to_model: 'allowed-model',
    }));
  });

  test('does not offer a fallback when every chain entry is rejected', () => {
    const httpsRequest = jest.fn((_options, cb) => {
      cb({ statusCode: 503, headers: {} });
      return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    });
    const handleUpstreamResponse = jest.fn();

    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(() => Promise.resolve()),
      otel: { endSpanError: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { increment: jest.fn(), observe: jest.fn() },
      isFallbackModelPermitted: () => false,
      getFallbackModels: () => ['blocked-model'],
    });

    sendUpstreamRequest({}, createContext({ body: Buffer.from('{"model":"first"}') }));
    expect(handleUpstreamResponse.mock.calls[0][2].onModelFallback).toBeNull();
  });
});
