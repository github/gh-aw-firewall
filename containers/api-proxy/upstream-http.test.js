const { EventEmitter } = require('events');
const {
  createSendUpstreamRequest,
  MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS,
  rebuildBodyFramingHeaders,
} = require('./upstream-http');
const { clearRuntimeModels, replaceRuntimeModels } = require('./runtime-model-catalog');
const { translateCopilotWireApi } = require('./wire-api-compat');
const { createRoutingObservation } = require('./routing-observation');

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

  test.each([
    ['http', 'localhost:11434', 'localhost', 11434],
    ['https', 'gateway.example.com:8443', 'gateway.example.com', 8443],
    ['http', 'localhost', 'localhost', 80],
    ['https', 'gateway.example.com', 'gateway.example.com', 443],
    ['http', '[::1]:11434', '::1', 11434],
  ])('dispatches %s://%s with separate hostname and port', (targetScheme, targetHost, hostname, port) => {
    const request = jest.fn(() => ({ on: jest.fn(), write: jest.fn(), end: jest.fn() }));
    const proxyAgent = {};
    const send = createSendUpstreamRequest({
      http: { request }, https: { request }, proxyAgent,
      handleUpstreamResponse: jest.fn(), sleep: jest.fn(),
      otel: {}, handleRequestError: jest.fn(), metrics: {},
    });
    send({}, createContext({ targetScheme, targetHost }));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      hostname, port, path: '/v1/chat/completions', agent: proxyAgent,
    }), expect.any(Function));
  });

  test('rejects exhausted invocation budgets before dispatching another upstream request', () => {
    const httpsRequest = jest.fn();
    const response = { headersSent: false, writeHead: jest.fn(), end: jest.fn() };
    const metrics = {
      gaugeDec: jest.fn(),
      increment: jest.fn(),
    };
    const modelBudget = {
      beginAttempt: jest.fn(() => ({ allowed: false, reason: 'request_limit' })),
    };
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse: jest.fn(),
      sleep: jest.fn(),
      otel: { endSpan: jest.fn() },
      handleRequestError: jest.fn(),
      metrics,
      modelBudget,
    });
    const ctx = createContext({
      req: { method: 'POST', headers: { authorization: 'invocation-capability' } },
      res: response,
    });

    sendUpstreamRequest({}, ctx);

    expect(modelBudget.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      authorization: 'invocation-capability',
      method: 'POST',
      path: '/v1/chat/completions',
      body: ctx.body,
    }));
    expect(response.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('awf_enclave_model_budget_request_limit'));
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  test.each(['missing', 'scheme', 'format', 'signature', 'claims', 'claims_changed'])(
    'logs a fixed capability %s event without credential material or upstream dispatch', capabilityFailure => {
      const { createInvocationModelBudget } = require('./enclave-model-budget');
      const realBudget = createInvocationModelBudget('a'.repeat(64));
      const modelBudget = capabilityFailure === 'missing' ? realBudget : {
        beginAttempt: () => ({ allowed: false, reason: 'invalid_capability', capabilityFailure }),
      };
      const logRequest = jest.fn();
      const httpsRequest = jest.fn();
      const res = { headersSent: false, writeHead: jest.fn(), end: jest.fn() };
      const send = createSendUpstreamRequest({
        https: { request: httpsRequest }, proxyAgent: {},
        handleUpstreamResponse: jest.fn(), sleep: jest.fn(),
        otel: { endSpan: jest.fn() }, handleRequestError: jest.fn(),
        metrics: { gaugeDec: jest.fn(), increment: jest.fn() }, modelBudget, logRequest,
      });
      send({}, createContext({ req: { method: 'POST', headers: {} }, res }));
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
      expect(httpsRequest).not.toHaveBeenCalled();
      expect(logRequest).toHaveBeenCalledWith('warn',
        `enclave_model_capability_${capabilityFailure}`, { status: 403 });
      expect(JSON.stringify(logRequest.mock.calls)).not.toContain('authorization');
    },
  );

  test.each([
    undefined, 'body_missing', 'input_reservation', 'request_json', 'request_shape',
    'output_conflict', 'output_shape', 'stream_options', 'budget_exhausted', 'PRIVATE_CREDENTIAL',
  ])('retains only a fixed token-budget rejection classification (%s)', tokenFailure => {
    const logRequest = jest.fn();
    const res = { headersSent: false, writeHead: jest.fn(), end: jest.fn() };
    const httpsRequest = jest.fn();
    const send = createSendUpstreamRequest({
      https: { request: httpsRequest }, proxyAgent: {},
      handleUpstreamResponse: jest.fn(), sleep: jest.fn(),
      otel: { endSpan: jest.fn() }, handleRequestError: jest.fn(),
      metrics: { gaugeDec: jest.fn(), increment: jest.fn() },
      modelBudget: { beginAttempt: () => ({ allowed: false, reason: 'token_limit', tokenFailure }) },
      logRequest,
    });
    send({}, createContext({ res }));
    expect(logRequest).toHaveBeenCalledWith('warn', 'enclave_model_token_limit', { status: 429 });
    expect(httpsRequest).not.toHaveBeenCalled();
    if (tokenFailure && tokenFailure !== 'PRIVATE_CREDENTIAL') {
      expect(logRequest).toHaveBeenCalledWith('warn',
        `enclave_model_token_${tokenFailure}`, { status: 429 });
    }
    expect(JSON.stringify(logRequest.mock.calls)).not.toContain('PRIVATE_CREDENTIAL');
  });

  test('aborts admitted work and suppresses retries and fallbacks after downstream close', async () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const responseCallbacks = [];
    const httpsRequest = jest.fn((_options, callback) => {
      responseCallbacks.push(callback);
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const settleMissing = jest.fn();
    const modelBudget = {
      beginAttempt: jest.fn(() => ({ allowed: true, body: null, settleMissing, settle: jest.fn() })),
    };
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(() => Promise.resolve()),
      otel: { endSpanError: jest.fn(), endSpan: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() },
      modelBudget,
      getFallbackModels: () => ['gpt-5.4-mini'],
    });
    const req = {
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {},
    };
    const res = new EventEmitter();
    Object.assign(res, { headersSent: false, destroyed: false, writableFinished: false });

    sendUpstreamRequest({}, createContext({
      body: Buffer.from('{"model":"gpt-5.4"}'),
      req,
      res,
    }));

    const signal = httpsRequest.mock.calls[0][0].signal;
    expect(signal.aborted).toBe(false);
    responseCallbacks[0]({ statusCode: 400, headers: {} });
    const responseOptions = handleUpstreamResponse.mock.calls[0][2];

    res.emit('close');
    expect(signal.aborted).toBe(true);
    expect(settleMissing).toHaveBeenCalledTimes(1);

    expect(responseOptions.onModelFallback({ statusCode: 400, reason: 'model_not_supported' }))
      .toBe(false);
    responseOptions.onModelNotSupportedRetry();
    await new Promise((resolve) => setImmediate(resolve));
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });

  test('aborts an admitted upstream request when the client closes before headers', () => {
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const responseCallbacks = [];
    const httpsRequest = jest.fn((_options, callback) => {
      responseCallbacks.push(callback);
      return proxyReq;
    });
    const proxyRes = { destroy: jest.fn() };
    const handleUpstreamResponse = jest.fn();
    const settleMissing = jest.fn();
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(),
      otel: { endSpanError: jest.fn(), endSpan: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() },
      modelBudget: {
        beginAttempt: jest.fn(() => ({ allowed: true, body: null, settleMissing })),
      },
    });
    const res = new EventEmitter();
    Object.assign(res, { headersSent: false, destroyed: false, writableFinished: false });

    sendUpstreamRequest({}, createContext({ res }));
    res.emit('close');

    expect(httpsRequest.mock.calls[0][0].signal.aborted).toBe(true);
    expect(settleMissing).toHaveBeenCalledTimes(1);
    responseCallbacks[0](proxyRes);
    expect(proxyRes.destroy).toHaveBeenCalledTimes(1);
    expect(handleUpstreamResponse).not.toHaveBeenCalled();
    expect(httpsRequest).toHaveBeenCalledTimes(1);
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

  test('retries a pre-translated request on its original endpoint after endpoint rejection', () => {
    replaceRuntimeModels('copilot', [
      { id: 'copilot/model', supportedEndpoints: ['/responses'] },
    ]);
    const sourceBody = Buffer.from(JSON.stringify({
      model: 'copilot/model',
      messages: [{ role: 'user', content: 'hello' }],
    }));
    const translated = translateCopilotWireApi(sourceBody, '/v1/chat/completions?foo=1');
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
      otel: { endSpanError: jest.fn(), endSpan: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() },
    });
    const req = { method: 'POST', url: '/v1/chat/completions?foo=1' };

    sendUpstreamRequest({ 'content-length': String(translated.body.length) }, createContext({
      body: translated.body,
      upstreamPath: '/v1/responses?foo=1',
      req,
      res: { headersSent: false },
      wireApiCompatibility: translated.compatibility,
      wireApiSourceBody: sourceBody,
    }));
    responseCallbacks[0]({ statusCode: 400, headers: {} });
    expect(handleUpstreamResponse.mock.calls[0][2].onWireApiEndpointRetry()).toBe(true);

    expect(httpsRequest).toHaveBeenCalledTimes(2);
    expect(httpsRequest.mock.calls[1][0].path).toBe('/v1/chat/completions?foo=1');
    expect(httpsRequest.mock.calls[1][0].headers['accept-encoding']).toBe('identity');
    expect(proxyReq.write.mock.calls[1][0]).toBe(sourceBody);
    responseCallbacks[1]({ statusCode: 400, headers: {} });
    expect(handleUpstreamResponse.mock.calls[1][2].wireApiCompatibility).toEqual({
      requestedEndpoint: '/chat/completions',
      upstreamEndpoint: '/chat/completions',
      passthrough: true,
    });
    expect(handleUpstreamResponse.mock.calls[1][2].onWireApiEndpointRetry()).toBe(false);
    expect(httpsRequest).toHaveBeenCalledTimes(2);
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
      awfCatalogue: Object.freeze({ revision: 'request-pinned' }),
      awfRuntimePricing: Object.freeze({}),
      awfModelCandidates: ['claude-sonnet-4.6', 'claude-opus-5', 'claude-haiku-4.5'],
    };
    sendUpstreamRequest({}, createContext({
      body: Buffer.from('{"model":"claude-sonnet-4.6","messages":[]}'),
      upstreamPath: '/v1/messages',
      req,
    }));
    responseCallbacks[0]({ statusCode: 400, headers: {} });
    expect(handleUpstreamResponse.mock.calls[0][2].onModelEndpointBlockedRetry()).toBe(eligible);
    expect(isFallbackModelPermitted).toHaveBeenCalledWith('claude-opus-5', 'copilot', req);
    expect(isFallbackModelPermitted).toHaveBeenCalledWith('claude-haiku-4.5', 'copilot', req);
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

  test('marks a local unsupported_reasoning_effort rejection on req.awfRouting', () => {
    replaceRuntimeModels('copilot', [{ id: 'low-only-model', supportedReasoningEfforts: ['low'] }]);
    const records = [];
    const observation = createRoutingObservation({
      getSelection: () => ({
        schema: 'awf-routing-selection/v1',
        engine: 'copilot',
        provider: 'copilot',
        choice: { id: 'choice-0001', model: 'github-copilot/low-only-model' },
        wire_model: 'low-only-model',
      }),
      recordFailure: jest.fn(),
      observer: { record: record => records.push(record) },
      generateRequestId: () => 'req-1',
    });
    const res = new EventEmitter();
    const written = [];
    res.statusCode = 200;
    res.headersSent = false;
    res.writeHead = jest.fn((statusCode) => { res.statusCode = statusCode; });
    res.write = jest.fn();
    res.end = jest.fn((chunk) => {
      written.push(chunk);
      res.writableFinished = true;
      res.emit('finish');
    });
    const req = { method: 'POST', url: '/v1/chat/completions', headers: {} };
    observation.observeRequest(req, res, { name: 'copilot' });
    const body = Buffer.from(JSON.stringify({ model: 'low-only-model', reasoning_effort: 'high', messages: [] }));
    req.awfRouting.bodyTransform(body);
    const httpsRequest = jest.fn();
    const handleUpstreamResponse = jest.fn();
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(),
      otel: { endSpanError: jest.fn(), endSpan: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() },
    });

    sendUpstreamRequest({ 'content-length': String(body.length) }, createContext({
      body,
      requestBytes: body.length,
      req,
      res,
    }));

    expect(httpsRequest).not.toHaveBeenCalled();
    expect(handleUpstreamResponse).not.toHaveBeenCalled();
    expect(req.awfRouting.localError).toEqual({
      code: 'unsupported_reasoning_effort',
      type: 'invalid_request_error',
    });
    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json', 'X-Request-ID': 'req-1' });
    expect(written).toEqual([JSON.stringify({
      error: {
        message: 'reasoning_effort "high" is not supported by model low-only-model; supported values: [low]',
        type: 'invalid_request_error',
        code: 'unsupported_reasoning_effort',
      },
    })]);
    expect(records).toEqual([expect.objectContaining({
      outcome: 'failed',
      status: 400,
      error_code: 'unsupported_reasoning_effort',
      error_type: 'invalid_request_error',
      error_source: 'awf',
    })]);
  });

  test('marks model_fallback_exhausted as AWF-originated without changing the 502 response', async () => {
    const records = [];
    const observation = createRoutingObservation({
      getSelection: () => ({ provider: 'copilot', choice: {}, wire_model: 'gpt-test' }),
      recordFailure: jest.fn(),
      observer: { record: record => records.push(record) },
      generateRequestId: () => 'req-1',
    });
    const res = new EventEmitter();
    const written = [];
    res.statusCode = 200;
    res.headersSent = false;
    res.writeHead = jest.fn((statusCode) => { res.statusCode = statusCode; res.headersSent = true; });
    res.write = jest.fn();
    res.end = jest.fn((chunk) => {
      written.push(chunk);
      res.writableFinished = true;
      res.emit('finish');
    });
    const req = { method: 'POST', url: '/v1/chat/completions', headers: {} };
    observation.observeRequest(req, res, { name: 'copilot' });
    // `n` cannot be translated to Anthropic Messages, so the only candidate fails to build.
    const body = Buffer.from(JSON.stringify({ model: 'gpt-test', n: 2, messages: [{ role: 'user', content: 'hi' }] }));
    let onModelFallback;
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: jest.fn((_options, cb) => {
        cb({ statusCode: 503, headers: {} });
        return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
      }) },
      proxyAgent: {},
      handleUpstreamResponse: jest.fn((_proxyRes, _headers, ctx) => { onModelFallback = ctx.onModelFallback; }),
      sleep: jest.fn(),
      otel: { endSpanError: jest.fn(), endSpan: jest.fn() },
      handleRequestError: jest.fn(),
      metrics: { gaugeDec: jest.fn(), gaugeInc: jest.fn(), increment: jest.fn(), observe: jest.fn() },
      logRequest: jest.fn(),
      getFallbackModels: () => ['anthropic/claude-sonnet-4.6'],
      getProviderAdapter: () => ({ name: 'anthropic', isEnabled: () => true }),
    });

    sendUpstreamRequest({ 'content-length': String(body.length) }, createContext({
      body, requestBytes: body.length, req, res,
    }));
    expect(onModelFallback({ statusCode: 503, reason: 'upstream_5xx' })).toBe(true);
    await new Promise(resolve => setImmediate(resolve));

    expect(req.awfRouting.localError).toEqual({ code: 'model_fallback_exhausted', type: 'model_fallback_exhausted' });
    expect(res.writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'application/json', 'X-Request-ID': 'req-1' });
    expect(written).toEqual([JSON.stringify({
      error: {
        message: 'Upstream request failed and no fallback model could be dispatched',
        type: 'model_fallback_exhausted',
        code: 'model_fallback_exhausted',
      },
    })]);
    expect(records).toEqual([expect.objectContaining({
      outcome: 'failed',
      status: 502,
      error_code: 'model_fallback_exhausted',
      error_type: 'model_fallback_exhausted',
      error_source: 'awf',
    })]);
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

    expect(isFallbackModelPermitted).toHaveBeenCalledWith('blocked-model', 'copilot', req);
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    expect(JSON.parse(proxyReqs[1].write.mock.calls[0][0].toString()).model).toBe('allowed-model');
    expect(req.awfModelFallback).toMatchObject({
      requested_model: 'first', model: 'allowed-model', reason: 'upstream_connection_error',
    });
    expect(logRequest).toHaveBeenCalledWith('warn', 'model_fallback', expect.objectContaining({
      from_model: 'first', to_model: 'allowed-model',
    }));
  });

  test('keeps fallback handling installed when every chain entry is rejected', () => {
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
    expect(handleUpstreamResponse.mock.calls[0][2].onModelFallback).toEqual(expect.any(Function));
  });

  test.each(['resolved', 'rejected'])('finalizes cancellation when async candidate build is %s', async (outcome) => {
    let resolveTransform;
    let rejectTransform;
    const transformPromise = new Promise((resolve, reject) => {
      resolveTransform = resolve;
      rejectTransform = reject;
    });
    const proxyReq = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    const httpsRequest = jest.fn((_options, cb) => {
      cb({ statusCode: 200, headers: {} });
      return proxyReq;
    });
    const handleUpstreamResponse = jest.fn();
    const gaugeDec = jest.fn();
    const endSpan = jest.fn();
    const span = {};
    const res = { headersSent: false, destroyed: false, writableEnded: false };
    const sendUpstreamRequest = createSendUpstreamRequest({
      https: { request: httpsRequest },
      proxyAgent: {},
      handleUpstreamResponse,
      sleep: jest.fn(),
      otel: { endSpanError: jest.fn(), endSpan },
      handleRequestError: jest.fn(),
      metrics: { gaugeDec, gaugeInc: jest.fn(), increment: jest.fn(), observe: jest.fn() },
      getFallbackModels: () => ['anthropic/claude-sonnet-4.6'],
      getProviderAdapter: () => ({
        isEnabled: () => true,
        getBodyTransform: () => () => transformPromise,
        getTargetHost: () => 'api.anthropic.com',
        getBasePath: () => '',
        getAuthHeaders: () => ({ 'x-api-key': 'key' }),
        getRequestSigner: () => null,
      }),
    });
    const req = { method: 'POST', url: '/v1/chat/completions', headers: {} };

    sendUpstreamRequest({}, createContext({
      req,
      res,
      span,
      body: Buffer.from(JSON.stringify({ model: 'first', messages: [{ role: 'user', content: 'hi' }] })),
    }));
    const fallback = handleUpstreamResponse.mock.calls[0][2].onModelFallback;
    expect(fallback({ reason: 'upstream_5xx', abandon: jest.fn() })).toBe(true);
    res.destroyed = true;
    if (outcome === 'resolved') resolveTransform(Buffer.from('{"model":"claude-sonnet-4.6"}'));
    else rejectTransform(new Error('transform failed'));
    await new Promise(resolve => setImmediate(resolve));

    expect(gaugeDec).toHaveBeenCalledTimes(1);
    expect(gaugeDec).toHaveBeenCalledWith('active_requests', { provider: 'copilot' });
    expect(endSpan).toHaveBeenCalledWith(span, 0);
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });
});
