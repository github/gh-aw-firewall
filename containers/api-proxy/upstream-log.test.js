const {
  createLogRequestCompletion,
  createLogUpstreamAuthError,
} = require('./upstream-log');

describe('upstream-log', () => {
  test('logRequestCompletion records metrics and invokes max-runs on success', () => {
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
