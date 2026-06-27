const {
  createLogRequestCompletion,
  createLogUpstreamAuthError,
  isInferenceRequest,
} = require('./upstream-log');

describe('upstream-log', () => {
  test('logRequestCompletion records metrics and invokes max-runs on inference POST', () => {
    const metrics = {
      statusClass: jest.fn(() => '2xx'),
      gaugeDec: jest.fn(),
      increment: jest.fn(),
      observe: jest.fn(),
    };
    const logRequest = jest.fn();
    const applyMaxRunsInvocation = jest.fn();
    const logRequestCompletion = createLogRequestCompletion({
      metrics,
      logRequest,
      sanitizeForLog: (value) => value,
      applyMaxRunsInvocation,
    });

    logRequestCompletion(200, 42, 'agent', { prompt_tokens: 10 }, {
      startTime: Date.now() - 5,
      provider: 'copilot',
      req: { method: 'POST', url: '/v1/chat/completions' },
      requestBytes: 12,
      targetHost: 'api.githubcopilot.com',
      requestId: 'req-1',
    });

    expect(metrics.gaugeDec).toHaveBeenCalledWith('active_requests', { provider: 'copilot' });
    expect(applyMaxRunsInvocation).toHaveBeenCalledTimes(1);
    expect(logRequest).toHaveBeenCalledWith('info', 'request_complete', expect.objectContaining({
      request_id: 'req-1',
      status: 200,
      x_initiator: 'agent',
    }));
  });

  test('logRequestCompletion does NOT invoke max-runs for GET /models', () => {
    const metrics = {
      statusClass: jest.fn(() => '2xx'),
      gaugeDec: jest.fn(),
      increment: jest.fn(),
      observe: jest.fn(),
    };
    const logRequest = jest.fn();
    const applyMaxRunsInvocation = jest.fn();
    const logRequestCompletion = createLogRequestCompletion({
      metrics,
      logRequest,
      sanitizeForLog: (value) => value,
      applyMaxRunsInvocation,
    });

    logRequestCompletion(200, 100, null, null, {
      startTime: Date.now() - 3,
      provider: 'openai',
      req: { method: 'GET', url: '/models' },
      requestBytes: 0,
      targetHost: 'api.openai.com',
      requestId: 'req-2',
    });

    expect(applyMaxRunsInvocation).not.toHaveBeenCalled();
  });

  test('logRequestCompletion does NOT invoke max-runs for non-inference POST', () => {
    const metrics = {
      statusClass: jest.fn(() => '2xx'),
      gaugeDec: jest.fn(),
      increment: jest.fn(),
      observe: jest.fn(),
    };
    const logRequest = jest.fn();
    const applyMaxRunsInvocation = jest.fn();
    const logRequestCompletion = createLogRequestCompletion({
      metrics,
      logRequest,
      sanitizeForLog: (value) => value,
      applyMaxRunsInvocation,
    });

    logRequestCompletion(200, 50, null, null, {
      startTime: Date.now() - 2,
      provider: 'openai',
      req: { method: 'POST', url: '/v1/embeddings' },
      requestBytes: 20,
      targetHost: 'api.openai.com',
      requestId: 'req-3',
    });

    expect(applyMaxRunsInvocation).not.toHaveBeenCalled();
  });

  describe('isInferenceRequest', () => {
    test.each([
      ['POST', '/v1/chat/completions'],
      ['POST', '/chat/completions'],
      ['POST', '/v1/responses'],
      ['POST', '/responses'],
      ['POST', '/v1/messages'],
    ])('returns true for %s %s', (method, url) => {
      expect(isInferenceRequest(method, url)).toBe(true);
    });

    test.each([
      ['GET', '/models'],
      ['GET', '/v1/models'],
      ['POST', '/v1/embeddings'],
      ['GET', '/v1/chat/completions'],
      ['POST', '/models'],
    ])('returns false for %s %s', (method, url) => {
      expect(isInferenceRequest(method, url)).toBe(false);
    });
  });

  test('logUpstreamAuthError suppresses 400 model-not-supported auth log noise', () => {
    const logRequest = jest.fn();
    const applyPermissionDenied = jest.fn();
    const logUpstreamAuthError = createLogUpstreamAuthError({
      logRequest,
      sanitizeForLog: (value) => value,
      applyPermissionDenied,
      parseModelNotSupportedFromBody: () => true,
    });

    logUpstreamAuthError(400, {
      requestId: 'req-1',
      provider: 'copilot',
      targetHost: 'api.githubcopilot.com',
      req: { url: '/v1/chat/completions' },
      responseBody: Buffer.from('The requested model is not supported'),
    });

    expect(logRequest).not.toHaveBeenCalled();
    expect(applyPermissionDenied).not.toHaveBeenCalled();
  });
});
