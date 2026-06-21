const { createCopilotAdapter } = require('./providers/copilot');

const bearerByokKey = ['Bearer', 'sk-byok-key'].join(' ');
const bearerStandardToken = ['Bearer', 'ghu_standard_token_123'].join(' ');
const bearerGhecToken = ['Bearer', 'ghu_ghec_token_123'].join(' ');
const bearerCustomToken = ['Bearer', 'ghu_standard_token_123'].join(' ');
const bearerGithubComOverrideToken = ['Bearer', 'ghu_token_123'].join(' ');

describe('createCopilotAdapter — GHE enterprise auth format', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };
  const fakeModelsReq = { url: '/models', method: 'GET', headers: {} };

  it('uses "token" prefix for GHES target (api.enterprise.githubcopilot.com)', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_enterprise_token_123',
      GITHUB_SERVER_URL: 'https://ghes.example.com',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('token ghu_enterprise_token_123');
  });

  it('uses "token" prefix for /models on GHES target', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_enterprise_token_123',
      GITHUB_SERVER_URL: 'https://ghes.example.com',
    });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe('token ghu_enterprise_token_123');
  });

  it('uses "Bearer" prefix for BYOK key even on GHES target', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_enterprise_token_123',
      COPILOT_PROVIDER_API_KEY: 'sk-byok-key',
      GITHUB_SERVER_URL: 'https://ghes.example.com',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerByokKey);
  });

  it('uses "token" prefix for /models on GHES even when BYOK key is configured', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_enterprise_token_123',
      COPILOT_PROVIDER_API_KEY: 'sk-byok-key',
      GITHUB_SERVER_URL: 'https://ghes.example.com',
    });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe('token ghu_enterprise_token_123');
  });

  it('uses "Bearer" prefix for standard api.githubcopilot.com target', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_standard_token_123',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerStandardToken);
  });

  it('uses "Bearer" prefix for GHEC tenant (*.ghe.com)', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_ghec_token_123',
      GITHUB_SERVER_URL: 'https://mycompany.ghe.com',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerGhecToken);
  });

  it('strips "token " prefix from COPILOT_GITHUB_TOKEN before re-prefixing for GHES', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'token ghu_enterprise_token_123',
      GITHUB_SERVER_URL: 'https://ghes.example.com',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('token ghu_enterprise_token_123');
    expect(headers['Authorization']).not.toContain('token token');
  });

  it('uses "token" prefix when COPILOT_API_TARGET overrides target but GITHUB_SERVER_URL indicates GHES', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_enterprise_token_123',
      COPILOT_API_TARGET: 'custom-copilot-proxy.internal.example.com',
      GITHUB_SERVER_URL: 'https://ghes.example.com',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('token ghu_enterprise_token_123');
  });

  it('uses "token" prefix for /models when COPILOT_API_TARGET overrides target on GHES', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_enterprise_token_123',
      COPILOT_API_TARGET: 'custom-copilot-proxy.internal.example.com',
      GITHUB_SERVER_URL: 'https://ghes.example.com',
    });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe('token ghu_enterprise_token_123');
  });

  it('uses "Bearer" when COPILOT_API_TARGET is custom but GITHUB_SERVER_URL is github.com', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_standard_token_123',
      COPILOT_API_TARGET: 'custom-proxy.example.com',
      GITHUB_SERVER_URL: 'https://github.com',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerCustomToken);
  });

  it('uses "token" prefix when AWF_PLATFORM_TYPE=ghes is set explicitly', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_enterprise_token_123',
      COPILOT_API_TARGET: 'custom-proxy.example.com',
      AWF_PLATFORM_TYPE: 'ghes',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('token ghu_enterprise_token_123');
  });

  it('uses "Bearer" when AWF_PLATFORM_TYPE=github.com overrides GHES-looking GITHUB_SERVER_URL', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_token_123',
      AWF_PLATFORM_TYPE: 'github.com',
      GITHUB_SERVER_URL: 'https://ghes.mycompany.com',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(bearerGithubComOverrideToken);
  });
});

describe('createCopilotAdapter — Azure OIDC (Entra) getAuthHeaders', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };

  it('exposes an Azure OIDC provider when AWF_AUTH_TYPE=github-oidc + AWF_AUTH_PROVIDER=azure', () => {
    const adapter = createCopilotAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
      COPILOT_PROVIDER_BASE_URL: 'https://aoai.example.com/openai',
    });

    const provider = adapter.getOidcProvider();
    expect(provider).toBeTruthy();
    expect(adapter.getAwsOidcProvider()).toBeNull();
    provider.shutdown();
  });

  it('injects Bearer-prefixed OIDC token in getAuthHeaders when OIDC token is available', () => {
    const adapter = createCopilotAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
      COPILOT_PROVIDER_BASE_URL: 'https://aoai.example.com/openai',
    });

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'aad-access-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe(['Bearer', 'aad-access-token'].join(' '));
    expect(headers['Copilot-Integration-Id']).toBe('agentic-workflows');

    provider.shutdown();
  });

  it('returns empty headers when Azure OIDC token has not yet been acquired', () => {
    const adapter = createCopilotAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
      COPILOT_PROVIDER_BASE_URL: 'https://aoai.example.com/openai',
    });

    expect(adapter.getAuthHeaders(fakeReq)).toEqual({});
    adapter.getOidcProvider().shutdown();
  });

  it('isEnabled returns false until OIDC provider is ready', () => {
    const adapter = createCopilotAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
      COPILOT_PROVIDER_BASE_URL: 'https://aoai.example.com/openai',
    });
    expect(adapter.isEnabled()).toBe(false);

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'aad-access-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;
    expect(adapter.isEnabled()).toBe(true);

    provider.shutdown();
  });

  it('unconfigured-response surfaces the OIDC-specific error message before token is ready', () => {
    const adapter = createCopilotAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
      COPILOT_PROVIDER_BASE_URL: 'https://aoai.example.com/openai',
    });
    const resp = adapter.getUnconfiguredResponse();
    const body = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body;
    expect(body.error.message).toMatch(/OIDC token \(azure\) unavailable/);

    adapter.getOidcProvider().shutdown();
  });

  it('does not construct an OIDC provider when AWF_AUTH_TYPE is unset', () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
    });
    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.getAwsOidcProvider()).toBeNull();
  });

  it('static COPILOT_PROVIDER_API_KEY takes precedence over OIDC', () => {
    const adapter = createCopilotAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
      COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc123',
    });
    expect(adapter.getOidcProvider()).toBeNull();
    const headers = adapter.getAuthHeaders({ url: '/v1/chat/completions', method: 'POST', headers: {} });
    expect(headers['Authorization']).toBe(['Bearer', 'sk-or-v1-abc123'].join(' '));
  });
});
