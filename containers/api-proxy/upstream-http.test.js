const {
  createSendUpstreamRequest,
  MODEL_NOT_SUPPORTED_RETRY_DELAYS_MS,
  rebuildBodyFramingHeaders,
} = require('./upstream-http');

describe('upstream-http', () => {
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
});
