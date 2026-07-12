const { handle400WithRetry } = require('./upstream-retry');

describe('upstream-retry', () => {
  function createBaseOptions() {
    return {
      provider: 'copilot',
      requestId: 'req-1',
      hasRetried: false,
      onRetry: jest.fn(),
      modelNotSupportedRetryCount: 0,
      maxModelNotSupportedRetries: 2,
      onModelNotSupportedRetry: jest.fn(),
      onModelEndpointBlockedRetry: jest.fn(() => false),
      completionCtx: {},
      authErrCtx: { req: { url: '/v1/chat/completions' } },
      initiatorSent: null,
      billingInfo: null,
      res: { writeHead: jest.fn(), end: jest.fn() },
      span: {},
      parseDeprecatedHeaderFromBody: jest.fn(() => null),
      learnAndStripDeprecatedHeaderValue: jest.fn(() => false),
      parseModelNotSupportedFromBody: jest.fn(() => false),
      parseModelEndpointBlockedFromBody: jest.fn(() => false),
      logRequest: jest.fn(),
      sanitizeForLog: (value) => value,
      logRequestCompletion: jest.fn(),
      logUpstreamAuthError: jest.fn(),
      otel: { endSpan: jest.fn() },
    };
  }

  test('triggers deprecated-header retry on first attempt', () => {
    const opts = createBaseOptions();
    opts.parseDeprecatedHeaderFromBody.mockReturnValue({
      header: 'anthropic-beta',
      value: 'deprecated-value',
    });
    opts.learnAndStripDeprecatedHeaderValue.mockReturnValue(true);
    const proxyRes = { statusCode: 400, headers: {} };

    const didRetry = handle400WithRetry(proxyRes, { 'anthropic-beta': 'deprecated-value' }, Buffer.from('{}'), opts);

    expect(didRetry).toBe(true);
    expect(opts.onRetry).toHaveBeenCalledWith({ 'anthropic-beta': 'deprecated-value' });
    expect(opts.res.writeHead).not.toHaveBeenCalled();
  });

  test('logs model_unavailable and forwards response when retry is exhausted', () => {
    const opts = createBaseOptions();
    opts.hasRetried = true;
    opts.modelNotSupportedRetryCount = 2;
    opts.parseModelNotSupportedFromBody.mockReturnValue(true);
    const proxyRes = {
      statusCode: 400,
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    };
    const responseBody = Buffer.from('{"error":"The requested model is not supported"}');

    const didRetry = handle400WithRetry(proxyRes, {}, responseBody, opts);

    expect(didRetry).toBe(false);
    expect(opts.logRequest).toHaveBeenCalledWith('error', 'model_unavailable', expect.objectContaining({
      request_id: 'req-1',
      retries_attempted: 2,
    }));
    expect(opts.logRequestCompletion).toHaveBeenCalledWith(400, responseBody.length, null, null, {});
    expect(opts.logUpstreamAuthError).toHaveBeenCalledWith(400, expect.objectContaining({ responseBody }));
    expect(opts.res.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
      'x-request-id': 'req-1',
      'content-length': String(responseBody.length),
    }));
    expect(opts.otel.endSpan).toHaveBeenCalledWith(opts.span, 400);
  });

  describe('endpoint-blocked fallback', () => {
    const endpointBlockedBody = Buffer.from(
      '{"error":{"message":"model \\"gpt-5.4-mini\\" is not accessible via the /chat/completions endpoint"}}'
    );

    test('calls onModelEndpointBlockedRetry when endpoint-blocked pattern matches', () => {
      const opts = createBaseOptions();
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      opts.onModelEndpointBlockedRetry.mockReturnValue(true);
      const proxyRes = { statusCode: 400, headers: {} };

      const didRetry = handle400WithRetry(proxyRes, {}, endpointBlockedBody, opts);

      expect(didRetry).toBe(true);
      expect(opts.onModelEndpointBlockedRetry).toHaveBeenCalled();
      expect(opts.logRequest).toHaveBeenCalledWith(
        'warn', 'model_endpoint_blocked_fallback', expect.objectContaining({ provider: 'copilot' })
      );
    });

    test('falls through to forward response when onModelEndpointBlockedRetry returns false (no candidates)', () => {
      const opts = createBaseOptions();
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      opts.onModelEndpointBlockedRetry.mockReturnValue(false);
      const proxyRes = {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
      };

      const didRetry = handle400WithRetry(proxyRes, {}, endpointBlockedBody, opts);

      expect(didRetry).toBe(false);
      expect(opts.res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    });

    test('does not trigger when provider is not copilot', () => {
      const opts = createBaseOptions();
      opts.provider = 'openai';
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      const proxyRes = {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
      };

      const didRetry = handle400WithRetry(proxyRes, {}, endpointBlockedBody, opts);

      expect(didRetry).toBe(false);
      expect(opts.onModelEndpointBlockedRetry).not.toHaveBeenCalled();
    });

    test('does not trigger when onModelEndpointBlockedRetry is not provided', () => {
      const opts = createBaseOptions();
      delete opts.onModelEndpointBlockedRetry;
      opts.parseModelEndpointBlockedFromBody.mockReturnValue(true);
      const proxyRes = {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
      };

      const didRetry = handle400WithRetry(proxyRes, {}, endpointBlockedBody, opts);

      expect(didRetry).toBe(false);
    });
  });
});
