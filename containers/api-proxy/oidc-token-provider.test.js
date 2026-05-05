'use strict';

const http = require('http');
const { OidcTokenProvider } = require('./oidc-token-provider');

// Helper to create a mock HTTP server that responds to token requests
function createMockOidcServer(handlers = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, `http://localhost`);

      // GitHub OIDC token endpoint
      if (url.pathname === '/token' && req.method === 'GET') {
        const handler = handlers.oidcToken || (() => ({
          statusCode: 200,
          body: JSON.stringify({ value: 'mock-github-oidc-jwt', count: 1 }),
        }));
        const result = handler(url, req);
        res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
        res.end(result.body);
        return;
      }

      // Azure token exchange endpoint
      if (url.pathname.includes('/oauth2/v2.0/token') && req.method === 'POST') {
        const handler = handlers.azureToken || (() => ({
          statusCode: 200,
          body: JSON.stringify({ access_token: 'mock-azure-ad-token', expires_in: 3600 }),
        }));
        const result = handler(body, req);
        res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
        res.end(result.body);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });
  });
  return server;
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
    // Override login host to use mock server
    provider._loginHost = `127.0.0.1:${serverPort}`;
    // Override _httpPost to use http (not https)
    provider._httpPost = function (url, body, headers) {
      // Rewrite https to http for mock
      const httpUrl = url.replace('https://', 'http://');
      return new Promise((resolve, reject) => {
        const parsedUrl = new URL(httpUrl);
        const req = http.request({
          method: 'POST',
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let responseBody = '';
          res.on('data', (chunk) => { responseBody += chunk; });
          res.on('end', () => resolve({ statusCode: res.statusCode, body: responseBody }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
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
    expect(adapter.getReflectionInfo().auth_type).toBe('github-oidc');

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
