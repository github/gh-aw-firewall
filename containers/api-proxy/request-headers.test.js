const {
  isValidRequestId,
  buildRequestHeaders,
  resolveCopilotInteractionId,
  resetCopilotInteractionIdForTests,
} = require('./request-headers');
const { createCopilotAdapter } = require('./providers/copilot');

describe('request-headers', () => {
  afterEach(() => {
    resetCopilotInteractionIdForTests();
    delete process.env.COPILOT_INTEGRATION_ID;
  });

  test('isValidRequestId enforces expected constraints', () => {
    expect(isValidRequestId('req-123.ABC')).toBe(true);
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('bad value')).toBe(false);
    expect(isValidRequestId('a'.repeat(129))).toBe(false);
  });

  test('buildRequestHeaders strips sensitive inbound headers and injects auth/request id', () => {
    const req = {
      headers: {
        host: 'example.com',
        authorization: '******',
        'x-forwarded-for': '1.2.3.4',
        'x-custom': 'keep-me',
      },
    };
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, req, {
      injectHeaders: { authorization: '******' },
      provider: 'openai',
      targetHost: 'api.openai.com',
      requestId: 'req-1',
    });

    expect(headers.host).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers.authorization).toBe('******');
    expect(headers['x-custom']).toBe('keep-me');
    expect(headers['x-request-id']).toBe('req-1');
  });

  test('buildRequestHeaders applies copilot initiator and content length rewrite', () => {
    const req = {
      headers: {
        'x-custom': 'keep-me',
        'copilot-session-token': 'session-jwt',
        'x-github-tenant': 'tenant-id',
        'transfer-encoding': 'chunked',
      },
    };
    const body = Buffer.from('rewritten');
    const headers = buildRequestHeaders(body, 1, req, {
      injectHeaders: { authorization: '******' },
      provider: 'copilot',
      targetHost: 'api.githubcopilot.com',
      requestId: 'req-2',
    });

    expect(headers['x-initiator']).toBe('agent');
    expect(headers['copilot-session-token']).toBe('session-jwt');
    expect(headers['x-github-tenant']).toBe('tenant-id');
    expect(headers['content-length']).toBe(String(body.length));
    expect(headers['transfer-encoding']).toBeUndefined();
  });
});

describe('copilot interaction/integration headers', () => {
  afterEach(() => {
    resetCopilotInteractionIdForTests();
    delete process.env.COPILOT_INTEGRATION_ID;
  });

  const buildCopilotHeaders = (inboundHeaders, opts = {}) =>
    buildRequestHeaders(Buffer.from('{}'), 2, { headers: inboundHeaders }, {
      injectHeaders: { 'Copilot-Integration-Id': 'agentic-workflows', ...opts.injectHeaders },
      provider: 'copilot',
      targetHost: opts.targetHost || 'api.githubcopilot.com',
      requestId: 'req-copilot',
    });

  test('resolveCopilotInteractionId derives a stable id from the run env', () => {
    const env = { GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2' };
    expect(resolveCopilotInteractionId(env)).toBe('12345-2');
    // Cached: later calls ignore a changed env
    expect(resolveCopilotInteractionId({ GITHUB_RUN_ID: '999' })).toBe('12345-2');
  });

  test('resolveCopilotInteractionId defaults run attempt to 1', () => {
    expect(resolveCopilotInteractionId({ GITHUB_RUN_ID: '12345' })).toBe('12345-1');
  });

  test('resolveCopilotInteractionId mints one stable uuid when no run env exists', () => {
    const first = resolveCopilotInteractionId({});
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCopilotInteractionId({})).toBe(first);
  });

  test('resolveCopilotInteractionId ignores unsafe run env values', () => {
    const id = resolveCopilotInteractionId({ GITHUB_RUN_ID: 'bad value\r\ninjected: 1' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('injects both headers on copilot host requests', () => {
    const headers = buildCopilotHeaders({ 'x-custom': 'keep-me' });
    expect(headers['x-interaction-id']).toBe(resolveCopilotInteractionId());
    expect(headers['Copilot-Integration-Id']).toBe('agentic-workflows');
  });

  test('preserves a non-empty inbound interaction id', () => {
    const headers = buildCopilotHeaders({ 'x-interaction-id': 'caller-session' });
    expect(headers['x-interaction-id']).toBe('caller-session');
  });

  test('replaces an empty inbound interaction id', () => {
    const headers = buildCopilotHeaders({ 'X-Interaction-Id': '  ' });
    expect(headers['X-Interaction-Id']).toBeUndefined();
    expect(headers['x-interaction-id']).toBe(resolveCopilotInteractionId());
  });

  test('deduplicates case-variant integration id headers', () => {
    const headers = buildCopilotHeaders({ 'copilot-integration-id': 'from-caller' });
    const values = Object.entries(headers)
      .filter(([k]) => k.toLowerCase() === 'copilot-integration-id')
      .map(([, v]) => v);
    expect(values).toEqual(['from-caller']);
  });

  test('falls back to the configured integration id when none is injected', () => {
    process.env.COPILOT_INTEGRATION_ID = 'my-integration';
    const headers = buildCopilotHeaders({}, { injectHeaders: { 'Copilot-Integration-Id': undefined } });
    expect(headers['copilot-integration-id']).toBe('my-integration');
  });

  test('does not inject on BYOK / non-copilot hosts', () => {
    const adapter = createCopilotAdapter({ COPILOT_PROVIDER_API_KEY: 'byok-token' });
    const injectHeaders = adapter.getAuthHeaders({ url: '/v1/chat/completions', method: 'POST', headers: {} });
    expect(injectHeaders['Copilot-Integration-Id']).toBe('agentic-workflows');

    const headers = buildRequestHeaders(Buffer.from('{}'), 2, { headers: {} }, {
      injectHeaders,
      provider: 'copilot',
      targetHost: 'my-resource.openai.azure.com',
      requestId: 'req-byok',
    });
    expect(headers['x-interaction-id']).toBeUndefined();
    expect(headers['Copilot-Integration-Id']).toBeUndefined();
    expect(headers['copilot-integration-id']).toBeUndefined();
  });

  test('preserves the integration id without adding interaction headers on canonical GHEC hosts', () => {
    const headers = buildCopilotHeaders({}, { targetHost: 'copilot-api.myorg.ghe.com' });
    expect(headers['Copilot-Integration-Id']).toBe('agentic-workflows');
    expect(headers['x-interaction-id']).toBeUndefined();
    expect(headers['x-initiator']).toBeUndefined();
  });

  test('preserves a case-variant caller integration id on canonical GHEC hosts', () => {
    const headers = buildCopilotHeaders(
      { 'copilot-integration-id': 'from-caller' },
      { targetHost: 'copilot-api.myorg.ghe.com' }
    );
    expect(Object.entries(headers).filter(([name]) => name.toLowerCase() === 'copilot-integration-id'))
      .toEqual([['copilot-integration-id', 'from-caller']]);
  });

  test('does not inject on other providers', () => {
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, { headers: {} }, {
      injectHeaders: {},
      provider: 'anthropic',
      targetHost: 'api.anthropic.com',
      requestId: 'req-anthropic',
    });
    expect(headers['x-interaction-id']).toBeUndefined();
    expect(headers['copilot-integration-id']).toBeUndefined();
  });
});
