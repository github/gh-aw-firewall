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
      completionCtx: {},
      authErrCtx: { req: { url: '/v1/chat/completions' } },
      initiatorSent: null,
      billingInfo: null,
      res: { writeHead: jest.fn(), end: jest.fn() },
      span: {},
      parseDeprecatedHeaderFromBody: jest.fn(() => null),
      learnAndStripDeprecatedHeaderValue: jest.fn(() => false),
      parseModelNotSupportedFromBody: jest.fn(() => false),
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
});
