/**
 * Tests for custom API auth header support (AWF_OPENAI_AUTH_HEADER, AWF_ANTHROPIC_AUTH_HEADER).
 *
 * These env vars allow internal AI gateways (e.g. Azure OpenAI) to use custom
 * auth header names instead of the provider defaults.
 */

const { createAnthropicAdapter } = require('./providers/anthropic');
const { createOpenAIAdapter } = require('./providers/openai');
const { buildRequestHeaders } = require('./request-headers');
const { rememberInjectedCredentials, redactCredentialText } = require('./credential-protection');

describe.each([
  ['openai', createOpenAIAdapter, 'OPENAI_API_KEY', 'OPENAI_API_TARGET', 'AWF_OPENAI_AUTH_HEADER', 'AWF_OPENAI_AUTH_SCHEME'],
  ['anthropic', createAnthropicAdapter, 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_TARGET', 'AWF_ANTHROPIC_AUTH_HEADER', 'AWF_ANTHROPIC_AUTH_SCHEME'],
])('%s static auth scheme and Databricks', (name, create, keyEnv, targetEnv, headerEnv, schemeEnv) => {
  const fakeReq = { method: 'POST', url: '/v1/messages', headers: {} };
  const oidcEnv = {
    AWF_AUTH_TYPE: 'github-oidc',
    AWF_AUTH_PROVIDER: 'databricks',
    AWF_AUTH_DATABRICKS_HOST: 'https://workspace.cloud.databricks.com',
    AWF_AUTH_OIDC_AUDIENCE: 'workspace-audience',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-actions-token',
    [targetEnv]: 'workspace.cloud.databricks.com',
  };

  it.each([undefined, 'X-Workspace-Key', 'Authorization'])('uses explicit static scheme consistently for request, startup and models with header %p', header => {
    const adapter = create({
      [keyEnv]: 'synthetic-key',
      [schemeEnv]: 'Basic',
      ...(header ? { [headerEnv]: header } : {}),
    });
    const authName = header || 'Authorization';
    for (const headers of [
      adapter.getAuthHeaders(fakeReq),
      adapter.getValidationProbe().opts.headers,
      adapter.getModelsFetchConfig().opts.headers,
    ]) {
      expect(headers[authName]).toBe('Basic synthetic-key');
      if (authName !== 'x-api-key') expect(headers['x-api-key']).toBeUndefined();
    }
  });

  it('does not double-prefix a static key and protects both raw and prefixed values', () => {
    const adapter = create({
      [keyEnv]: 'bAsIc synthetic-secret',
      [schemeEnv]: 'Basic',
      [headerEnv]: 'X-Workspace-Key',
    });
    for (const headers of [
      adapter.getAuthHeaders(fakeReq),
      adapter.getValidationProbe().opts.headers,
      adapter.getModelsFetchConfig().opts.headers,
    ]) {
      expect(headers['X-Workspace-Key']).toBe('bAsIc synthetic-secret');
      const req = { headers: {} };
      rememberInjectedCredentials(req, headers);
      expect(redactCredentialText(req, 'synthetic-secret')).not.toContain('synthetic-secret');
    }
  });

  it('also protects the raw token in a legacy prefixed static key sent to a custom header', () => {
    const adapter = create({ [keyEnv]: ['Bearer', 'synthetic-secret'].join(' '), [headerEnv]: 'X-Workspace-Key' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['X-Workspace-Key']).toBe(['Bearer', 'synthetic-secret'].join(' '));
    const req = { headers: {} };
    rememberInjectedCredentials(req, headers);
    expect(redactCredentialText(req, 'synthetic-secret')).not.toContain('synthetic-secret');
  });

  it('rejects invalid scheme without reflecting the supplied value', () => {
    expect(() => create({ [keyEnv]: 'synthetic-key', [schemeEnv]: 'Basic\r\nX-Injection: secret' }))
      .toThrow(`Invalid ${schemeEnv} value: expected an HTTP authentication scheme token`);
  });

  it('rejects header injection in static credentials', () => {
    const adapter = create({ [keyEnv]: 'synthetic-key\r\nX-Injection: yes', [schemeEnv]: 'Basic' });
    expect(() => adapter.getAuthHeaders(fakeReq)).toThrow('Invalid static authentication credential');
  });

  it('strips all client auth headers and replaces the configured custom credential', () => {
    const previous = process.env[headerEnv];
    process.env[headerEnv] = 'X-Workspace-Key';
    try {
      const adapter = create({ [keyEnv]: 'synthetic-key', [headerEnv]: 'X-Workspace-Key', [schemeEnv]: 'Basic' });
      const req = { ...fakeReq, headers: {
        authorization: 'caller-auth',
        'proxy-authorization': 'caller-proxy-auth',
        'x-api-key': 'caller-key',
        'api-key': 'caller-key',
        'x-workspace-key': 'caller-custom-key',
      } };
      const headers = buildRequestHeaders(Buffer.alloc(0), 0, req, {
        injectHeaders: adapter.getAuthHeaders(req), provider: name, targetHost: 'gateway.example', requestId: 'test-id',
      });
      expect(headers['X-Workspace-Key']).toBe('Basic synthetic-key');
      for (const clientHeader of Object.keys(req.headers)) expect(headers[clientHeader]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[headerEnv];
      else process.env[headerEnv] = previous;
    }
  });

  it('forces Databricks bearer auth regardless of static scheme/header and preserves correct reflection', () => {
    const adapter = create({
      ...oidcEnv,
      [keyEnv]: 'synthetic-static-key',
      [headerEnv]: 'X-Workspace-Key',
      [schemeEnv]: 'Basic',
    });
    const provider = adapter.getOidcProvider();
    try {
      expect(adapter.isEnabled()).toBe(false);
      expect(adapter.getAuthHeaders(fakeReq)).toEqual({});
      provider._cachedToken = 'synthetic-oidc-token';
      provider._expiresAt = Date.now() / 1000 + 60;
      expect(adapter.isEnabled()).toBe(true);
      const headers = adapter.getAuthHeaders(fakeReq);
      expect(headers.Authorization).toBe(['Bearer', 'synthetic-oidc-token'].join(' '));
      expect(headers['X-Workspace-Key']).toBeUndefined();
      expect(headers['anthropic-beta']).toBeUndefined();
      expect(adapter.getModelsFetchConfig().opts.headers.Authorization).toBe(headers.Authorization);
      expect(adapter.getReflectionInfo().auth_type).toBe('github-oidc/databricks');
    } finally {
      provider.shutdown();
    }
  });

  it.each(['api.openai.com', 'api.anthropic.com', 'other.cloud.databricks.com', 'https://[malformed'])('fails closed for an explicitly selected Databricks refused/malformed target %p without static fallback', target => {
    const adapter = create({ ...oidcEnv, [targetEnv]: target, [keyEnv]: 'synthetic-static-key' });
    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.getAuthHeaders(fakeReq)).toEqual({});
    expect(adapter.getUnconfiguredResponse().body.error.message).toContain('Databricks OIDC');
  });

  it('preserves unrelated static first-party auth and model discovery when this adapter did not select Databricks', () => {
    const adapter = create({ ...oidcEnv, [targetEnv]: undefined, [keyEnv]: 'synthetic-static-key', [schemeEnv]: 'Basic' });
    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.getAuthHeaders(fakeReq).Authorization).toBe('Basic synthetic-static-key');
    expect(adapter.getModelsFetchConfig().opts.headers.Authorization).toBe('Basic synthetic-static-key');
  });
});

describe('reserved trace authentication headers', () => {
  it.each([
    ['openai', createOpenAIAdapter, 'AWF_OPENAI_AUTH_HEADER'],
    ['anthropic', createAnthropicAdapter, 'AWF_ANTHROPIC_AUTH_HEADER'],
  ])('rejects %s custom auth header conflicts at startup', (provider, create, envVar) => {
    for (const header of ['traceparent', 'TraceState', ' BAGGAGE ']) {
      expect(() => create({ [envVar]: header })).toThrow(`Invalid ${envVar} value: trace context headers are reserved`);
    }
  });
});

// ─── Anthropic ───

describe('createAnthropicAdapter — custom auth header', () => {
  const fakeReq = { url: '/v1/messages', method: 'POST', headers: {} };

  it('uses x-api-key by default', () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
  });

  it('uses custom header name from AWF_ANTHROPIC_AUTH_HEADER', () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_ANTHROPIC_AUTH_HEADER: 'api-key',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      'api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('custom header is used in validation probe', () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_ANTHROPIC_AUTH_HEADER: 'api-key',
    });
    const probe = adapter.getValidationProbe();
    expect(probe.opts.headers['api-key']).toBe('sk-ant-test');
    expect(probe.opts.headers['x-api-key']).toBeUndefined();
  });

  it('custom header is used in models fetch config', () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_ANTHROPIC_AUTH_HEADER: 'api-key',
    });
    const config = adapter.getModelsFetchConfig();
    expect(config.opts.headers['api-key']).toBe('sk-ant-test');
    expect(config.opts.headers['x-api-key']).toBeUndefined();
  });

  it('OIDC mode ignores custom header (always uses Authorization Bearer)', () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_ANTHROPIC_AUTH_HEADER: 'api-key',
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
      AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid-test',
      AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
    });

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'oidc-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      Authorization: 'Bearer oidc-token',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    });
    expect(headers['api-key']).toBeUndefined();

    provider.shutdown();
  });
});

// ─── OpenAI ───

describe('createOpenAIAdapter — custom auth header', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };

  it.each([
    [undefined, undefined, 'api-key', 'synthetic-static-key'],
    ['Basic', undefined, 'Authorization', 'Basic synthetic-static-key'],
    ['Basic', 'X-Workspace-Key', 'X-Workspace-Key', 'Basic synthetic-static-key'],
  ])('preserves Azure BYOK header semantics with scheme %p and explicit header %p', (scheme, header, expectedHeader, expectedValue) => {
    const adapter = createOpenAIAdapter({
      COPILOT_PROVIDER_TYPE: 'azure',
      COPILOT_PROVIDER_BASE_URL: 'https://workspace.example/ai-gateway/openai',
      COPILOT_PROVIDER_API_KEY: 'synthetic-static-key',
      AWF_OPENAI_AUTH_SCHEME: scheme,
      AWF_OPENAI_AUTH_HEADER: header,
    });
    expect(adapter.getAuthHeaders(fakeReq)).toEqual({ [expectedHeader]: expectedValue });
    expect(adapter.getModelsFetchConfig().opts.headers).toEqual({ [expectedHeader]: expectedValue });
  });

  it('does not invent a Databricks OpenAI target from the Azure BYOK fallback', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'databricks',
      AWF_AUTH_DATABRICKS_HOST: 'https://workspace.cloud.databricks.com',
      AWF_AUTH_OIDC_AUDIENCE: 'workspace-audience',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-actions-token',
      COPILOT_PROVIDER_TYPE: 'azure',
      COPILOT_PROVIDER_BASE_URL: 'https://workspace.cloud.databricks.com/ai-gateway/openai',
    });
    expect(adapter.getTargetHost()).toBe('api.openai.com');
    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.isEnabled()).toBe(false);
  });

  it('uses Authorization Bearer by default', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai-test',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      Authorization: 'Bearer sk-openai-test',
    });
  });

  it('uses custom header name from AWF_OPENAI_AUTH_HEADER with raw key', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai-test',
      AWF_OPENAI_AUTH_HEADER: 'api-key',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      'api-key': 'sk-openai-test',
    });
    expect(headers.Authorization).toBeUndefined();
  });

  it('custom header is used in validation probe', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai-test',
      AWF_OPENAI_AUTH_HEADER: 'api-key',
    });
    const probe = adapter.getValidationProbe();
    expect(probe.opts.headers['api-key']).toBe('sk-openai-test');
    expect(probe.opts.headers.Authorization).toBeUndefined();
  });

  it('custom header is used in models fetch config', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai-test',
      AWF_OPENAI_AUTH_HEADER: 'api-key',
    });
    const config = adapter.getModelsFetchConfig();
    expect(config.opts.headers['api-key']).toBe('sk-openai-test');
    expect(config.opts.headers.Authorization).toBeUndefined();
  });

  it('Azure OIDC mode uses custom header with token', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai-test',
      AWF_OPENAI_AUTH_HEADER: 'api-key',
      OPENAI_API_TARGET: 'my-resource.openai.azure.com',
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'test-tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'test-client',
    });

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'oidc-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      'api-key': 'oidc-token',
    });
    expect(headers.Authorization).toBeUndefined();

    provider.shutdown();
  });

  it('OpenAI WIF always uses Authorization Bearer, even with a custom static-key header', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai-test',
      AWF_OPENAI_AUTH_HEADER: 'api-key',
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'openai',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID: 'idp_test',
      AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID: 'sa_test',
    });
    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'openai-oidc-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    expect(adapter.getAuthHeaders(fakeReq)).toEqual({
      Authorization: 'Bearer ' + 'openai-oidc-token',
    });

    provider.shutdown();
  });

  it('reports incomplete native OpenAI WIF configuration with required settings', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'openai',
      AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID: 'idp_test',
      AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID: 'sa_test',
    });

    const response = adapter.getUnconfiguredResponse();
    expect(response.body.error.message).toContain('ACTIONS_ID_TOKEN_REQUEST_URL');
    expect(response.body.error.message).toContain('permissions: id-token: write');
    expect(response.body.error.message).toContain('AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID');
    expect(response.body.error.message).toContain('AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID');
  });

  it('fetches OpenAI models with bearer headers after the native WIF token is ready', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'openai',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID: 'idp_test',
      AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID: 'sa_test',
    });
    const provider = adapter.getOidcProvider();
    const wifToken = 'openai-wif-token';

    try {
      expect(adapter.getModelsFetchConfig()).toBeNull();

      provider._cachedToken = wifToken;
      provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

      expect(adapter.getModelsFetchConfig().opts.headers).toEqual({
        Authorization: 'Bearer ' + wifToken,
      });
    } finally {
      provider?.shutdown();
    }
  });

  it('OIDC mode (Azure) without custom header uses Authorization Bearer', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai-test',
      OPENAI_API_TARGET: 'my-resource.openai.azure.com',
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'test-tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'test-client',
    });

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'oidc-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      Authorization: 'Bearer oidc-token',
    });

    provider.shutdown();
  });
});
