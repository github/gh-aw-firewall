/**
 * Tests for custom API auth header support (AWF_OPENAI_AUTH_HEADER, AWF_ANTHROPIC_AUTH_HEADER).
 *
 * These env vars allow internal AI gateways (e.g. Azure OpenAI) to use custom
 * auth header names instead of the provider defaults.
 */

const { createAnthropicAdapter } = require('./providers/anthropic');
const { createOpenAIAdapter } = require('./providers/openai');

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
    });

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'oidc-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      Authorization: 'Bearer oidc-token',
      'anthropic-version': '2023-06-01',
    });
    expect(headers['api-key']).toBeUndefined();

    provider.shutdown();
  });
});

// ─── OpenAI ───

describe('createOpenAIAdapter — custom auth header', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };

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

  it('OIDC mode (Azure) uses custom header with token', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai-test',
      AWF_OPENAI_AUTH_HEADER: 'api-key',
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'openai',
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

  it('OIDC mode (Azure) without custom header uses Authorization Bearer', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai-test',
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'openai',
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
