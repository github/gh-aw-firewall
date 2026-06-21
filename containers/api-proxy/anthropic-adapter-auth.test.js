const { createAnthropicAdapter } = require('./providers/anthropic');

describe('createAnthropicAdapter — OIDC getAuthHeaders', () => {
  const fakeReq = { url: '/v1/messages', method: 'POST', headers: {} };

  it('injects Authorization header instead of x-api-key in Anthropic OIDC mode', () => {
    const adapter = createAnthropicAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
      AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid-test',
      AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
    });

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'sk-ant-oat01-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      Authorization: ['Bearer', 'sk-ant-oat01-token'].join(' '),
      'anthropic-version': '2023-06-01',
    });
    expect(headers['x-api-key']).toBeUndefined();

    provider.shutdown();
  });

  it('returns empty auth headers when Anthropic OIDC token is not yet available', () => {
    const adapter = createAnthropicAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
      AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid-test',
      AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
    });

    expect(adapter.getAuthHeaders(fakeReq)).toEqual({});
    adapter.getOidcProvider().shutdown();
  });

  it('passes AWF_AUTH_ANTHROPIC_TOKEN_URL to Anthropic OIDC provider', () => {
    const adapter = createAnthropicAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
      AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid-test',
      AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
      AWF_AUTH_ANTHROPIC_TOKEN_URL: 'https://anthropic.internal.example/v1/oauth/token',
    });

    expect(adapter.getOidcProvider()._tokenEndpoint).toBe('https://anthropic.internal.example/v1/oauth/token');
    adapter.getOidcProvider().shutdown();
  });
});
