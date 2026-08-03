const { createAnthropicAdapter } = require('./providers/anthropic');

describe('createAnthropicAdapter — OIDC getAuthHeaders', () => {
  const fakeReq = { url: '/v1/messages', method: 'POST', headers: {} };
  const oidcEnv = {
    AWF_AUTH_TYPE: 'github-oidc',
    AWF_AUTH_PROVIDER: 'anthropic',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
    AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
    AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid-test',
    AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
  };

  function createReadyOidcAdapter(env = {}) {
    const adapter = createAnthropicAdapter({ ...oidcEnv, ...env });
    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'sk-ant-oat01-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;
    return { adapter, provider };
  }

  it('injects Authorization header instead of x-api-key in Anthropic OIDC mode', () => {
    const { adapter, provider } = createReadyOidcAdapter();

    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers).toEqual({
      Authorization: ['Bearer', 'sk-ant-oat01-token'].join(' '),
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    });
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-beta']).not.toContain('oidc-federation-2026-04-01');

    provider.shutdown();
  });

  it('returns empty auth headers when Anthropic OIDC token is not yet available', () => {
    const adapter = createAnthropicAdapter(oidcEnv);

    expect(adapter.getAuthHeaders(fakeReq)).toEqual({});
    adapter.getOidcProvider().shutdown();
  });

  it('passes AWF_AUTH_ANTHROPIC_TOKEN_URL to Anthropic OIDC provider', () => {
    const adapter = createAnthropicAdapter({
      ...oidcEnv,
      AWF_AUTH_ANTHROPIC_TOKEN_URL: 'https://anthropic.internal.example/v1/oauth/token',
    });

    expect(adapter.getOidcProvider()._tokenEndpoint).toBe('https://anthropic.internal.example/v1/oauth/token');
    adapter.getOidcProvider().shutdown();
  });

  it('does not add OAuth or federation betas to static-key requests', () => {
    const adapter = createAnthropicAdapter({ ANTHROPIC_API_KEY: 'sk-ant-static' });

    const headers = adapter.getAuthHeaders(fakeReq);

    expect(headers['x-api-key']).toBe('sk-ant-static');
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('merges and deduplicates client, bearer, and auto-cache beta values', () => {
    const { adapter, provider } = createReadyOidcAdapter({
      AWF_ANTHROPIC_AUTO_CACHE: 'true',
    });
    const req = {
      ...fakeReq,
      headers: {
        'anthropic-beta': [
          'client-beta, oauth-2025-04-20',
          'extended-cache-ttl-2025-04-11,client-beta',
        ],
      },
    };

    const headers = adapter.getAuthHeaders(req);

    expect(headers['anthropic-beta']).toBe(
      'client-beta,oauth-2025-04-20,extended-cache-ttl-2025-04-11'
    );
    provider.shutdown();
  });

  it('uses only the OAuth beta for forwarded refresh-token exchanges', () => {
    const { adapter, provider } = createReadyOidcAdapter();
    const headers = adapter.getAuthHeaders({
      url: '/v1/oauth/token',
      method: 'POST',
      headers: {},
    });

    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['anthropic-beta']).not.toContain('oidc-federation-2026-04-01');
    provider.shutdown();
  });

  it('adds the OAuth beta to OIDC validation and models requests', () => {
    const { adapter, provider } = createReadyOidcAdapter();

    const validation = adapter.getValidationProbe();
    const models = adapter.getModelsFetchConfig();

    expect(validation.opts.headers).toEqual(expect.objectContaining({
      Authorization: ['Bearer', 'sk-ant-oat01-token'].join(' '),
      'anthropic-beta': 'oauth-2025-04-20',
    }));
    expect(models.opts.headers).toEqual(expect.objectContaining({
      Authorization: ['Bearer', 'sk-ant-oat01-token'].join(' '),
      'anthropic-beta': 'oauth-2025-04-20',
    }));
    expect(validation.opts.headers['anthropic-beta']).not.toContain('oidc-federation-2026-04-01');
    expect(models.opts.headers['anthropic-beta']).not.toContain('oidc-federation-2026-04-01');
    provider.shutdown();
  });
});
