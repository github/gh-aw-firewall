'use strict';

const http = require('http');
const { httpPost } = require('./github-oidc');
const { OidcTokenProvider } = require('./oidc-token-provider');
const { createBaseMockServer } = require('./test-helpers/mock-oidc-server');

// Helper to create a mock OIDC server with Azure token exchange support
function createMockOidcServer(handlers = {}) {
  return createBaseMockServer((url, req, res, routeHandlers, body) => {
    if (url.pathname.includes('/oauth2/v2.0/token') && req.method === 'POST') {
      const handler = routeHandlers.azureToken || (() => ({
        statusCode: 200,
        body: JSON.stringify({ access_token: 'mock-azure-ad-token', expires_in: 3600 }),
      }));
      const result = handler(body, req);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(result.body);
      return true;
    }

    return false;
  }, handlers);
}

describe('OidcTokenProvider', () => {
  let mockServer;
  let serverPort;

  beforeAll((done) => {
    mockServer = createMockOidcServer();
    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = mockServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    mockServer.close(done);
  });

  it('should mint GitHub OIDC token and exchange for Azure AD token', async () => {
    const provider = new OidcTokenProvider({
      requestUrl: `http://127.0.0.1:${serverPort}/token`,
      requestToken: 'mock-request-token',
      tenantId: 'test-tenant-id',
      clientId: 'test-client-id',
      oidcAudience: 'api://AzureADTokenExchange',
      azureScope: 'https://cognitiveservices.azure.com/.default',
    });
    // Override _exchangeForAzureToken to use mock server over http
    provider._exchangeForAzureToken = async (oidcJwt) => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: provider._clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: oidcJwt,
        scope: provider._azureScope,
      }).toString();
      const response = await httpPost(
        `http://127.0.0.1:${serverPort}/test-tenant-id/oauth2/v2.0/token`,
        body,
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );
      const data = JSON.parse(response.body);
      return { access_token: data.access_token, expires_in: data.expires_in || 3600 };
    };

    await provider.initialize();

    expect(provider.isReady()).toBe(true);
    const token = provider.getToken();
    expect(token).toBe('mock-azure-ad-token');

    provider.shutdown();
  });

  it('should return null when not initialized', () => {
    const provider = new OidcTokenProvider({
      requestUrl: 'http://localhost:0/token',
      requestToken: 'test',
      tenantId: 'test',
      clientId: 'test',
    });

    expect(provider.isReady()).toBe(false);
    expect(provider.getToken()).toBeNull();
    provider.shutdown();
  });

  it('should request GitHub OIDC token with configured audience and auth header', async () => {
    const oidcServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      expect(url.searchParams.get('audience')).toBe('api://custom-audience');
      expect(req.headers.authorization).toBe('Bearer custom-request-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: 'jwt-from-github' }));
    });

    let provider;
    try {
      await new Promise(resolve => oidcServer.listen(0, '127.0.0.1', resolve));
      const oidcPort = oidcServer.address().port;

      provider = new OidcTokenProvider({
        requestUrl: `http://127.0.0.1:${oidcPort}/token`,
        requestToken: 'custom-request-token',
        tenantId: 'test',
        clientId: 'test',
        oidcAudience: 'api://custom-audience',
      });

      const token = await provider._mintGitHubOidcToken();
      expect(token).toBe('jwt-from-github');
    } finally {
      provider?.shutdown();
      await new Promise(resolve => oidcServer.close(resolve));
    }
  });

  it('should preserve Azure context in token exchange timeout errors', async () => {
    const provider = new OidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      tenantId: 'test',
      clientId: 'test',
    });

    provider._httpPost = jest.fn().mockRejectedValue(new Error('Token exchange timeout'));

    await expect(provider._exchangeForAzureToken('oidc-jwt'))
      .rejects
      .toThrow('Azure token exchange timeout');

    provider.shutdown();
  });

  it('should resolve correct login host for sovereign clouds', () => {
    const providerPublic = new OidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      tenantId: 'test',
      clientId: 'test',
    });
    expect(providerPublic._loginHost).toBe('login.microsoftonline.com');

    const providerGov = new OidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      tenantId: 'test',
      clientId: 'test',
      azureCloud: 'usgovernment',
    });
    expect(providerGov._loginHost).toBe('login.microsoftonline.us');

    const providerChina = new OidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      tenantId: 'test',
      clientId: 'test',
      azureCloud: 'china',
    });
    expect(providerChina._loginHost).toBe('login.chinacloudapi.cn');

    providerPublic.shutdown();
    providerGov.shutdown();
    providerChina.shutdown();
  });

  it('should handle GitHub OIDC token failure gracefully', async () => {
    const failServer = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    await new Promise(resolve => failServer.listen(0, '127.0.0.1', resolve));
    const failPort = failServer.address().port;

    const provider = new OidcTokenProvider({
      requestUrl: `http://127.0.0.1:${failPort}/token`,
      requestToken: 'bad-token',
      tenantId: 'test',
      clientId: 'test',
      retryDelayMs: 10, // Fast retries for testing
      maxInitRetries: 2,
    });

    await provider.initialize(); // Should not throw, just log

    expect(provider.isReady()).toBe(false);
    expect(provider.getToken()).toBeNull();

    provider.shutdown();
    await new Promise(resolve => failServer.close(resolve));
  });

  it('should schedule refresh at 75% or 5 minutes-before-expiry, whichever is earlier', async () => {
    const provider = new OidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      tenantId: 'test',
      clientId: 'test',
    });

    provider._mintGitHubOidcToken = jest.fn().mockResolvedValue('oidc-jwt');
    provider._exchangeForAzureToken = jest.fn().mockResolvedValue({
      access_token: 'azure-token',
      expires_in: 600,
    });
    provider._scheduleRefresh = jest.fn();

    await provider._refreshToken();

    expect(provider._scheduleRefresh).toHaveBeenCalledWith(300000);
    provider.shutdown();
  });

  it('should schedule immediate refresh when token lifetime is below minimum margin', async () => {
    const provider = new OidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      tenantId: 'test',
      clientId: 'test',
    });

    provider._mintGitHubOidcToken = jest.fn().mockResolvedValue('oidc-jwt');
    provider._exchangeForAzureToken = jest.fn().mockResolvedValue({
      access_token: 'azure-token',
      expires_in: 240,
    });
    provider._scheduleRefresh = jest.fn();

    await provider._refreshToken();

    expect(provider._scheduleRefresh).toHaveBeenCalledWith(0);
    provider.shutdown();
  });

  it('should not trigger refresh after shutdown', async () => {
    const provider = new OidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      tenantId: 'test',
      clientId: 'test',
    });

    provider._refreshToken = jest.fn().mockResolvedValue();
    provider.shutdown();

    expect(provider.getToken()).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(provider._refreshToken).not.toHaveBeenCalled();
    expect(provider._refreshTimer).toBeNull();
  });
});

describe('OpenAI adapter with OIDC', () => {
  const { createOpenAIAdapter } = require('./providers/openai');

  it('should report disabled until OIDC token is initialized', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'test-tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'test-client',
      OPENAI_API_TARGET: 'my-resource.openai.azure.com',
    });

    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.getOidcProvider()).not.toBeNull();
    expect(adapter.getValidationProbe()).toEqual({ skip: true, reason: 'OIDC auth; validation via token acquisition' });
    expect(adapter.getModelsFetchConfig()).toBeNull();
    expect(adapter.getReflectionInfo().auth_type).toBe('github-oidc/azure');

    adapter.getOidcProvider().shutdown();
  });

  it('should not create OIDC provider when auth type is not github-oidc', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-test',
    });

    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.getReflectionInfo().auth_type).toBe('static-key');
  });

  it('should configure OpenAI adapter from Copilot Azure BYOK env vars', () => {
    const adapter = createOpenAIAdapter({
      COPILOT_PROVIDER_TYPE: 'azure',
      COPILOT_PROVIDER_BASE_URL: 'https://my-resource.openai.azure.com/openai/deployments/gpt-5',
      COPILOT_PROVIDER_API_KEY: 'azure-byok-key',
    });

    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.getTargetHost()).toBe('my-resource.openai.azure.com');
    expect(adapter.getBasePath()).toBe('/openai/deployments/gpt-5');
    expect(adapter.getAuthHeaders()).toEqual({ 'api-key': 'azure-byok-key' });
    expect(adapter.getReflectionInfo().auth_type).toBe('static-key');
  });

  it('should prefer explicit OPENAI_* config over Copilot Azure BYOK env vars', () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-openai',
      OPENAI_API_TARGET: 'gateway.example.com',
      OPENAI_API_BASE_PATH: '/v2',
      COPILOT_PROVIDER_TYPE: 'azure',
      COPILOT_PROVIDER_BASE_URL: 'https://my-resource.openai.azure.com/openai/deployments/gpt-5',
      COPILOT_PROVIDER_API_KEY: 'azure-byok-key',
    });

    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.getTargetHost()).toBe('gateway.example.com');
    expect(adapter.getBasePath()).toBe('/v2');
    // Explicit OPENAI_API_KEY still uses api-key header because COPILOT_PROVIDER_TYPE=azure
    expect(adapter.getAuthHeaders()).toEqual({ 'api-key': 'sk-openai' });
  });

  it('should allow AWF_OPENAI_AUTH_HEADER to override Azure api-key default', () => {
    const adapter = createOpenAIAdapter({
      COPILOT_PROVIDER_TYPE: 'azure',
      COPILOT_PROVIDER_BASE_URL: 'https://my-resource.openai.azure.com/openai/deployments/gpt-5',
      COPILOT_PROVIDER_API_KEY: 'azure-byok-key',
      AWF_OPENAI_AUTH_HEADER: 'X-Custom-Auth',
    });

    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.getAuthHeaders()).toEqual({ 'X-Custom-Auth': 'azure-byok-key' });
  });

  it('should not default to api-key header in OIDC mode when COPILOT_PROVIDER_TYPE=azure', () => {
    const adapter = createOpenAIAdapter({
      COPILOT_PROVIDER_TYPE: 'azure',
      AWF_AUTH_TYPE: 'github-oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'test-tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'test-client',
    });

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'azure-ad-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    const headers = adapter.getAuthHeaders({});
    expect(headers).toEqual({ Authorization: 'Bearer azure-ad-token' });
    expect(headers['api-key']).toBeUndefined();

    provider.shutdown();
  });

  it('should not create OIDC provider when required vars are missing', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      // Missing ACTIONS_ID_TOKEN_REQUEST_URL, etc.
    });

    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.getOidcProvider()).toBeNull();
  });

  it('should return empty auth headers when OIDC token is not yet acquired', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'test-tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'test-client',
    });

    // Before initialization, token should be unavailable
    const headers = adapter.getAuthHeaders({});
    expect(headers).toEqual({});

    adapter.getOidcProvider().shutdown();
  });

  it('should inject only Authorization header in OIDC mode', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'test-tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'test-client',
    });

    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'azure-ad-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

    const headers = adapter.getAuthHeaders({});
    expect(headers).toEqual({ Authorization: 'Bearer azure-ad-token' });
    expect(headers['api-key']).toBeUndefined();

    adapter.getOidcProvider().shutdown();
  });
});
