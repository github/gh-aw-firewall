'use strict';

const http = require('http');
const { httpPost } = require('./github-oidc');
const { AnthropicOidcTokenProvider } = require('./anthropic-oidc-token-provider');
const { createBaseMockServer } = require('./test-helpers/mock-oidc-server');
const { withMockServer, testInitializationFailure } = require('./test-helpers/oidc-test-helpers.test-utils');

function createMockServer(handlers = {}) {
  return createBaseMockServer((url, req, res, routeHandlers, body) => {
    if (url.pathname === '/v1/oauth/token' && req.method === 'POST') {
      const handler = routeHandlers.oauthToken || (() => ({
        statusCode: 200,
        body: JSON.stringify({
          access_token: 'sk-ant-oat01-mock-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      }));
      const result = handler(body, req);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(result.body);
      return true;
    }

    return false;
  }, handlers);
}

/** Minimal valid config for tests that don't exercise the exchange step */
const BASE_CONFIG = {
  requestUrl: 'http://localhost:0/token',
  requestToken: 'test',
  federationRuleId: 'fdrl_test',
  organizationId: 'org-uuid-test',
  serviceAccountId: 'svac_test',
};

describe('AnthropicOidcTokenProvider', () => {
  const { getServerPort } = withMockServer(createMockServer);

  it('should exchange GitHub OIDC for an Anthropic workload identity token', async () => {
    const provider = new AnthropicOidcTokenProvider({
      requestUrl: `http://127.0.0.1:${getServerPort()}/token`,
      requestToken: 'mock-request-token',
      federationRuleId: 'fdrl_abc123',
      organizationId: 'org-uuid-abc',
      serviceAccountId: 'svac_abc123',
    });

    provider._exchangeForAnthropicToken = async (jwt) => {
      const response = await httpPost(
        `http://127.0.0.1:${getServerPort()}/v1/oauth/token`,
        JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
          federation_rule_id: 'fdrl_abc123',
          organization_id: 'org-uuid-abc',
          service_account_id: 'svac_abc123',
        }),
        {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }
      );
      const data = JSON.parse(response.body);
      return { access_token: data.access_token, expires_in: data.expires_in || 3600 };
    };

    await provider.initialize();

    expect(provider.isReady()).toBe(true);
    expect(provider.getToken()).toBe('sk-ant-oat01-mock-token');

    provider.shutdown();
  });

  it('should include required WIF fields in the exchange request body', async () => {
    const provider = new AnthropicOidcTokenProvider({
      requestUrl: 'http://127.0.0.1/token',
      requestToken: 'mock-token',
      federationRuleId: 'fdrl_myrule',
      organizationId: 'org-00000000-0000-0000-0000-000000000001',
      serviceAccountId: 'svac_myaccount',
      workspaceId: 'wrkspc_myworkspace',
    });

    // Spy on the instance _httpPost to capture what the real _exchangeForAnthropicToken sends
    const mockHttpPost = jest.spyOn(provider, '_httpPost').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ access_token: 'sk-ant-oat01-wif-token', expires_in: 3600 }),
    });

    try {
      await provider._exchangeForAnthropicToken('fake-github-jwt');

      expect(mockHttpPost).toHaveBeenCalledTimes(1);
      const [url, rawBody] = mockHttpPost.mock.calls[0];
      const sent = JSON.parse(rawBody);
      expect(url).toBe('https://api.anthropic.com/v1/oauth/token');
      expect(sent.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      expect(sent.assertion).toBe('fake-github-jwt');
      expect(sent.federation_rule_id).toBe('fdrl_myrule');
      expect(sent.organization_id).toBe('org-00000000-0000-0000-0000-000000000001');
      expect(sent.service_account_id).toBe('svac_myaccount');
      expect(sent.workspace_id).toBe('wrkspc_myworkspace');
    } finally {
      provider.shutdown();
    }
  });

  it('should use custom token endpoint when configured', async () => {
    const provider = new AnthropicOidcTokenProvider({
      ...BASE_CONFIG,
      tokenEndpoint: 'https://anthropic.internal.example/v1/oauth/token',
    });

    const mockHttpPost = jest.spyOn(provider, '_httpPost').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ access_token: 'sk-ant-oat01-custom', expires_in: 3600 }),
    });

    await provider._exchangeForAnthropicToken('fake-jwt');

    const [url] = mockHttpPost.mock.calls[0];
    expect(url).toBe('https://anthropic.internal.example/v1/oauth/token');

    provider.shutdown();
  });

  it('should fall back to default token endpoint when configured endpoint is whitespace', async () => {
    const provider = new AnthropicOidcTokenProvider({
      ...BASE_CONFIG,
      tokenEndpoint: '   ',
    });

    const mockHttpPost = jest.spyOn(provider, '_httpPost').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ access_token: 'sk-ant-oat01-default', expires_in: 3600 }),
    });

    await provider._exchangeForAnthropicToken('fake-jwt');

    const [url] = mockHttpPost.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/oauth/token');

    provider.shutdown();
  });

  it('should omit workspace_id from the exchange request when not provided', async () => {
    const provider = new AnthropicOidcTokenProvider({
      requestUrl: 'http://127.0.0.1/token',
      requestToken: 'test',
      federationRuleId: 'fdrl_norule',
      organizationId: 'org-uuid',
      serviceAccountId: 'svac_nows',
    });

    // Verify the real exchange body does not contain workspace_id
    const mockHttpPost = jest.spyOn(provider, '_httpPost').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ access_token: 'sk-ant-oat01-mock', expires_in: 3600 }),
    });

    await provider._exchangeForAnthropicToken('fake-jwt');

    const [, rawBody] = mockHttpPost.mock.calls[0];
    const sent = JSON.parse(rawBody);
    expect(sent.workspace_id).toBeUndefined();

    provider.shutdown();
  });

  it('should include workspace_id in exchange body only when provided', async () => {
    const withWs = new AnthropicOidcTokenProvider({
      ...BASE_CONFIG,
      workspaceId: 'wrkspc_abc',
    });
    const withoutWs = new AnthropicOidcTokenProvider(BASE_CONFIG);
    const withEmptyWs = new AnthropicOidcTokenProvider({
      ...BASE_CONFIG,
      workspaceId: '  ',
    });

    expect(withWs._workspaceId).toBe('wrkspc_abc');
    expect(withoutWs._workspaceId).toBeUndefined();
    // empty / whitespace-only workspaceId must be normalized to undefined
    expect(withEmptyWs._workspaceId).toBeUndefined();

    withWs.shutdown();
    withoutWs.shutdown();
    withEmptyWs.shutdown();
  });

  it('should throw when required WIF fields are missing', () => {
    expect(() => new AnthropicOidcTokenProvider({ ...BASE_CONFIG, federationRuleId: '' }))
      .toThrow(/federationRuleId/);
    expect(() => new AnthropicOidcTokenProvider({ ...BASE_CONFIG, organizationId: '' }))
      .toThrow(/organizationId/);
    expect(() => new AnthropicOidcTokenProvider({ ...BASE_CONFIG, serviceAccountId: '' }))
      .toThrow(/serviceAccountId/);
  });

  it('should request GitHub OIDC token with the Anthropic audience by default', async () => {
    const oidcServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      expect(url.searchParams.get('audience')).toBe('https://api.anthropic.com');
      expect(req.headers.authorization).toBe(['Bearer', 'custom-request-token'].join(' '));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: 'jwt-from-github' }));
    });

    let provider;
    try {
      await new Promise(resolve => oidcServer.listen(0, '127.0.0.1', resolve));
      const oidcPort = oidcServer.address().port;

      provider = new AnthropicOidcTokenProvider({
        requestUrl: `http://127.0.0.1:${oidcPort}/token`,
        requestToken: 'custom-request-token',
        federationRuleId: 'fdrl_test',
        organizationId: 'org-uuid-test',
        serviceAccountId: 'svac_test',
      });

      provider._exchangeForAnthropicToken = jest.fn().mockResolvedValue({
        access_token: 'sk-ant-oat01-mock-token',
        expires_in: 3600,
      });
      provider._scheduleRefresh = jest.fn();

      await provider._refreshToken();

      expect(provider._exchangeForAnthropicToken).toHaveBeenCalledWith('jwt-from-github');
      expect(provider.getToken()).toBe('sk-ant-oat01-mock-token');
    } finally {
      provider?.shutdown();
      await new Promise(resolve => oidcServer.close(resolve));
    }
  });

  it('should return null when not initialized', () => {
    const provider = new AnthropicOidcTokenProvider(BASE_CONFIG);

    expect(provider.isReady()).toBe(false);
    expect(provider.getToken()).toBeNull();
    provider.shutdown();
  });

  it('should handle initialization failure gracefully', async () => {
    await testInitializationFailure(AnthropicOidcTokenProvider, {
      federationRuleId: 'fdrl_test',
      organizationId: 'org-uuid-test',
      serviceAccountId: 'svac_test',
    });
  });

  it('should use https://api.anthropic.com as default audience', () => {
    const provider = new AnthropicOidcTokenProvider(BASE_CONFIG);

    expect(provider._oidcAudience).toBe('https://api.anthropic.com');
    provider.shutdown();
  });
});
