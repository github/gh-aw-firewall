'use strict';

const { MAX_CLASSIFIER_RESPONSE_BYTES, createRoutingProviderExecutor } = require('./routing-provider-executor');

function createAdapter(overrides = {}) {
  return {
    name: 'copilot',
    isEnabled: () => true,
    getRoutingProviderIdentity: () => 'github-copilot',
    getTargetHost: () => 'api.githubcopilot.com',
    getAuthHeaders: () => ({ authorization: '******' }),
    getBasePath: () => '',
    getTargetScheme: () => 'https',
    ...overrides,
  };
}

function createExecutor({ proxyRequest, checkRateLimit = () => false, adapter = createAdapter(), getGuardChecks = () => [] } = {}) {
  return createRoutingProviderExecutor({
    getCopilotAdapter: () => adapter,
    proxyRequest,
    checkRateLimit,
    getGuardChecks,
  });
}

function respond(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(Buffer.from(body));
}

const request = { purpose: 'routing_classification', path: '/chat/completions', body: { model: 'gpt-5.4', messages: [] } };

describe('routing provider executor', () => {
  it('requires a complete dependency set', () => {
    expect(() => createRoutingProviderExecutor({ proxyRequest: () => {}, checkRateLimit: () => false }))
      .toThrow(/provider executor is incomplete/);
  });

  it('rejects requests which do not carry the trusted routing purpose', async () => {
    const proxyRequest = jest.fn();
    const executor = createExecutor({ proxyRequest });
    await expect(executor.execute({ ...request, purpose: 'agent' }))
      .rejects.toMatchObject({ code: 'routing_configuration_error' });
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it('rejects execution when the Copilot provider is unavailable', async () => {
    const proxyRequest = jest.fn();
    for (const adapter of [
      null,
      createAdapter({ name: 'openai' }),
      createAdapter({ isEnabled: () => false }),
      createAdapter({ getRoutingProviderIdentity: () => 'other' }),
    ]) {
      const executor = createExecutor({ proxyRequest, adapter });
      await expect(executor.execute(request)).rejects.toMatchObject({ code: 'provider_unavailable' });
    }
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it('executes through the shared proxy with a trusted in-process request context', async () => {
    const controller = new AbortController();
    let captured = null;
    const proxyRequest = jest.fn((req, res, targetHost, authHeaders, provider) => {
      captured = { req, targetHost, authHeaders, provider };
      respond(res, 200, '{"ok":true}');
    });
    const executor = createExecutor({ proxyRequest });

    const result = await executor.execute(request, { signal: controller.signal });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body.toString('utf8'))).toEqual({ ok: true });
    expect(result.terminal).toBeUndefined();
    expect(result.availabilityFailure).toBeUndefined();
    expect(captured.provider).toBe('copilot');
    expect(captured.targetHost).toBe('api.githubcopilot.com');
    expect(captured.authHeaders).toEqual({ authorization: '******' });
    expect(captured.req.method).toBe('POST');
    expect(captured.req.url).toBe('/chat/completions');
    expect(captured.req.headers['content-type']).toBe('application/json');
    expect(captured.req.awfRequestContext).toEqual({ purpose: 'routing_classification', signal: controller.signal });
    expect(Object.isFrozen(captured.req.awfRequestContext)).toBe(true);
  });

  it('settles when the rate limiter answers the request without reaching the provider', async () => {
    const proxyRequest = jest.fn();
    const checkRateLimit = jest.fn((req, res) => {
      respond(res, 429, '{"error":{"code":"rate_limit_exceeded"}}');
      return true;
    });
    const executor = createExecutor({ proxyRequest, checkRateLimit });

    const result = await executor.execute(request);

    expect(proxyRequest).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(429);
    expect(result.terminal).toEqual({
      code: 'rate_limit_exceeded',
      detail: 'Classifier execution was rejected with rate_limit_exceeded',
    });
  });

  it('raises blocked guards before any provider spend', () => {
    const executor = createExecutor({
      proxyRequest: jest.fn(),
      getGuardChecks: () => [{
        isBlocked: () => true,
        block: {},
        eventName: 'ai_credits_limit',
        buildError: () => ({ error: { type: 'ai_credits_exceeded', message: 'AI credit limit reached' } }),
      }],
    });

    expect(() => executor.checkBeforePrimary({ selection: { wire_model: 'gpt-5.4' } }))
      .toThrow('AI credit limit reached');
  });

  it('does not raise when no guard is blocked', () => {
    const executor = createExecutor({
      proxyRequest: jest.fn(),
      getGuardChecks: () => [{ isBlocked: () => false, block: {}, eventName: 'ai_credits_limit', buildError: () => ({}) }],
    });
    expect(() => executor.checkBeforePrimary({ selection: { wire_model: 'gpt-5.4' } })).not.toThrow();
  });

  it('normalizes provider availability failures and terminal provider errors', async () => {
    const cases = [
      { status: 500, body: '{"error":{"code":"server_error"}}', expected: { availabilityFailure: true } },
      { status: 400, body: '{"error":{"message":"the requested model is not supported"}}', expected: { availabilityFailure: true } },
      { status: 400, body: '{"error":{"message":"This model is not accessible via the responses endpoint"}}', expected: { availabilityFailure: true } },
      { status: 400, body: '{"error":{"code":"invalid_request"}}', expected: { terminal: { code: 'invalid_request', detail: 'Classifier execution was rejected with invalid_request' } } },
      { status: 403, body: '{"error":{"type":"forbidden"}}', expected: { terminal: { code: 'forbidden', detail: 'Classifier execution was rejected with forbidden' } } },
      { status: 402, body: 'not json', expected: { terminal: { code: 'provider_unavailable', detail: 'Classifier execution was rejected with provider_unavailable' } } },
    ];

    for (const { status, body, expected } of cases) {
      const executor = createExecutor({ proxyRequest: (req, res) => respond(res, status, body) });
      const result = await executor.execute(request);
      expect(result.statusCode).toBe(status);
      expect(result).toMatchObject(expected);
    }
  });

  it('rejects responses which exceed the classifier response bound', async () => {
    const executor = createExecutor({
      proxyRequest: (req, res) => {
        res.writeHead(200, {});
        res.end(Buffer.alloc(MAX_CLASSIFIER_RESPONSE_BYTES + 1, 0x61));
      },
    });
    await expect(executor.execute(request)).rejects.toMatchObject({ code: 'routing_contract_error' });
  });

  it('cancels execution when the caller aborts before or during the call', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const neverCalled = jest.fn();
    await expect(createExecutor({ proxyRequest: neverCalled }).execute(request, { signal: preAborted.signal }))
      .rejects.toMatchObject({ code: 'routing_cancelled' });
    expect(neverCalled).not.toHaveBeenCalled();

    const controller = new AbortController();
    const executor = createExecutor({ proxyRequest: () => { controller.abort(); } });
    await expect(executor.execute(request, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'routing_cancelled' });
  });

  it('propagates a synchronous proxy failure', async () => {
    const executor = createExecutor({
      proxyRequest: () => { throw new Error('proxy exploded'); },
    });
    await expect(executor.execute(request)).rejects.toThrow('proxy exploded');
  });
});
