const {
  isValidRequestId,
  buildRequestHeaders,
  resolveCopilotInteractionId,
  resetCopilotInteractionIdForTests,
} = require('./request-headers');
const { createCopilotAdapter } = require('./providers/copilot');

describe('configured endpoint trace headers', () => {
  const traceparent = '00-aabbccddeeff00112233445566778899-1122334455667788-01';
  const targetEnvVars = [
    'COPILOT_PROVIDER_BASE_URL', 'COPILOT_API_TARGET', 'OPENAI_API_TARGET',
    'ANTHROPIC_API_TARGET', 'GEMINI_API_TARGET', 'VERTEX_API_TARGET', 'FOUNDRY_API_TARGET',
  ];
  let savedEnv;

  beforeEach(() => {
    savedEnv = Object.fromEntries(targetEnvVars.map(name => [name, process.env[name]]));
    for (const name of targetEnvVars) delete process.env[name];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function build(targetHost = 'gateway.example.com', options = {}) {
    return buildRequestHeaders(Buffer.from('{}'), 2, {
      headers: {
        Traceparent: 'caller-trace', tracestate: 'caller=value', Baggage: 'private=value',
      },
    }, {
      injectHeaders: { baggage: 'injected-private=value' },
      provider: 'copilot', targetHost, requestId: 'trace-test',
      traceHeaders: { traceparent, tracestate: 'vendor=value', baggage: 'span-private=value' },
      ...options,
    });
  }

  test.each([
    ['copilot', 'COPILOT_PROVIDER_BASE_URL'],
    ['copilot', 'COPILOT_API_TARGET'],
    ['openai', 'COPILOT_PROVIDER_BASE_URL'],
    ['openai', 'OPENAI_API_TARGET'],
    ['anthropic', 'ANTHROPIC_API_TARGET'],
    ['gemini', 'GEMINI_API_TARGET'],
    ['vertex', 'VERTEX_API_TARGET'],
    ['foundry', 'FOUNDRY_API_TARGET'],
  ])('injects proxy trace context for %s using %s', (provider, envVar) => {
    process.env[envVar] = 'https://Gateway.Example.com/openai/v1';
    const headers = build('gateway.example.com', { provider });
    expect(headers.traceparent).toBe(traceparent);
    expect(headers.tracestate).toBe('vendor=value');
    expect(headers).not.toHaveProperty('Traceparent');
    expect(Object.keys(headers).map(name => name.toLowerCase())).not.toContain('baggage');
  });

  test.each([
    ['https://gateway.example.com:8443/openai/v1', 'gateway.example.com:8443', 'https'],
    ['http://localhost:8080/openai/v1', 'localhost:8080', 'http'],
    ['http://[::1]:8080/openai/v1', '[::1]:8080', 'http'],
    [`https://${'user'}:${'pass'}@Gateway.Example.com:8443/openai/v1`, 'gateway.example.com:8443', 'https'],
    ['http://user@localhost:8080/openai/v1', 'localhost:8080', 'http'],
    ['user:password@gateway.example.com/v1', 'gateway.example.com', 'https'],
  ])('propagates to the configured origin %s', (configured, targetHost, targetScheme) => {
    process.env.COPILOT_PROVIDER_BASE_URL = configured;
    expect(build(targetHost, { targetScheme }).traceparent).toBe(traceparent);
  });

  test.each([
    ['https://gateway.example.com/openai/v1', 'other.example.com', 'https'],
    ['https://gateway.example.com/openai/v1', 'sub.gateway.example.com', 'https'],
    ['https://gateway.example.com/openai/v1', 'gateway.example.com.evil.test', 'https'],
    ['https://gateway.example.com:8443/openai/v1', 'gateway.example.com', 'https'],
    ['https://gateway.example.com/openai/v1', 'gateway.example.com', 'http'],
    [`https://${'user'}:${'pass'}@gateway.example.com:8443/v1`, 'gateway.example.com', 'https'],
    [`https://${'user'}:${'pass'}@gateway.example.com/v1`, 'other.example.com', 'https'],
    [`https://${'user'}:${'pass'}@gateway.example.com/v1`, 'gateway.example.com', 'http'],
    ['ftp://gateway.example.com', 'gateway.example.com', 'https'],
    ['not a URL', 'gateway.example.com', 'https'],
    ['', 'api.githubcopilot.com', 'https'],
  ])('does not propagate trace context from %s to %s (%s)', (configured, targetHost, targetScheme) => {
    process.env.COPILOT_PROVIDER_BASE_URL = configured;
    const headers = build(targetHost, { targetScheme });
    for (const name of ['traceparent', 'tracestate', 'baggage', 'Traceparent', 'Baggage']) {
      expect(headers).not.toHaveProperty(name);
    }
  });

  test('does not use a different provider configuration', () => {
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://gateway.example.com';
    const headers = build('gateway.example.com', { provider: 'anthropic' });
    expect(headers).not.toHaveProperty('traceparent');
    expect(headers).not.toHaveProperty('tracestate');
  });

  test.each(['api.githubcopilot.com', 'copilot-api.tenant.ghe.com',
    'api.githubcopilot.com.', 'GITHUBCOPILOT.COM.:443', 'copilot-api.tenant.ghe.com.:8443'])(
    'does not propagate to the first-party Copilot target %s even when supplied by broker setup',
    targetHost => {
      process.env.COPILOT_API_TARGET = targetHost;
      const headers = build(targetHost);
      expect(headers).not.toHaveProperty('traceparent');
      expect(headers).not.toHaveProperty('tracestate');
    },
  );

  test('omits tracestate when the request span has none', () => {
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://gateway.example.com';
    const headers = build('gateway.example.com', { traceHeaders: { traceparent } });
    expect(headers.traceparent).toBe(traceparent);
    expect(headers).not.toHaveProperty('tracestate');
  });

  test('does not forward caller context when no request span exists', () => {
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://gateway.example.com';
    const headers = build('gateway.example.com', { traceHeaders: null });
    for (const name of ['traceparent', 'tracestate', 'baggage', 'Traceparent', 'Baggage']) {
      expect(headers).not.toHaveProperty(name);
    }
  });

  test.each([
    { traceparent: 7, tracestate: 'vendor=value' },
    { traceparent: `${traceparent}\r\nx-injected: 1` },
    { traceparent, tracestate: 'vendor=value\r\nx-injected: 1' },
  ])('ignores unsafe trace headers: %p', traceHeaders => {
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://gateway.example.com';
    const headers = build('gateway.example.com', { traceHeaders });
    expect(headers).not.toHaveProperty('traceparent');
    expect(headers).not.toHaveProperty('tracestate');
  });
});

describe('request-headers', () => {
  afterEach(() => {
    resetCopilotInteractionIdForTests();
    delete process.env.COPILOT_INTEGRATION_ID;
  });

  test.each([
    ['api.githubcopilot.com:8443', true],
    ['copilot-api.tenant.ghe.com:8443', true],
    ['gateway.example.com:8443', false],
  ])('retains Copilot integration-header scoping with port on %s', (targetHost, expected) => {
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, { headers: {} }, {
      injectHeaders: { 'Copilot-Integration-Id': 'test-integration' },
      provider: 'copilot', targetHost, requestId: 'port-test',
    });
    expect(headers['Copilot-Integration-Id'] === 'test-integration').toBe(expected);
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
        'api-key': 'untrusted-placeholder',
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
    expect(headers['api-key']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers.authorization).toBe('******');
    expect(headers['x-custom']).toBe('keep-me');
    expect(headers['x-request-id']).toBe('req-1');
  });

  test('buildRequestHeaders strips x-awf-caller before forwarding upstream', () => {
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, {
      headers: { 'x-awf-caller': 'subagent/file-summarizer', 'X-AWF-Caller': 'main', 'x-custom': 'keep-me' },
    }, {
      injectHeaders: {},
      provider: 'openai',
      targetHost: 'api.openai.com',
      requestId: 'req-caller',
    });

    expect(Object.keys(headers).map(name => name.toLowerCase())).not.toContain('x-awf-caller');
    expect(headers['x-custom']).toBe('keep-me');
  });

  test('buildRequestHeaders strips an invalid x-awf-caller', () => {
    for (const value of ['x'.repeat(129), 'subagent/file summarizer', 'subagent/', 'admin', 'main, main']) {
      const headers = buildRequestHeaders(Buffer.from('{}'), 2, { headers: { 'x-awf-caller': value } }, {
        injectHeaders: {},
        provider: 'openai',
        targetHost: 'api.openai.com',
        requestId: 'req-invalid-caller',
      });
      expect(headers).not.toHaveProperty('x-awf-caller');
    }
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

  test('buildRequestHeaders forces identity accept-encoding for Codex-compatibility-translated requests', () => {
    const req = { headers: { 'accept-encoding': 'gzip, br' } };
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, req, {
      injectHeaders: {},
      provider: 'copilot',
      targetHost: 'api.githubcopilot.com',
      requestId: 'req-3',
      codexCompatibility: { customTools: new Set(['apply_patch']) },
    });

    // The compatibility adapter rewrites the plaintext response body; a
    // compressed response would otherwise leave the rewrite unapplied.
    expect(headers['accept-encoding']).toBe('identity');
  });

  test('buildRequestHeaders leaves accept-encoding sanitization untouched when not Codex-translated', () => {
    const req = { headers: { 'accept-encoding': 'gzip, br, zstd' } };
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, req, {
      injectHeaders: {},
      provider: 'copilot',
      targetHost: 'api.githubcopilot.com',
      requestId: 'req-4',
    });

    expect(headers['accept-encoding']).toBe('gzip, br');
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

  test('forwards the integration id on Copilot Decisions requests', () => {
    const adapter = createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'test-token' });
    const injectHeaders = adapter.getAuthHeaders({ url: '/v1/decisions', method: 'POST', headers: {} });
    expect(injectHeaders['Copilot-Integration-Id']).toBe('agentic-workflows');
    const headers = buildCopilotHeaders({}, { injectHeaders });
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
