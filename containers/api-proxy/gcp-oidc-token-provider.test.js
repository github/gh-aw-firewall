'use strict';

const http = require('http');
const { GcpOidcTokenProvider } = require('./gcp-oidc-token-provider');

function createMockServer(handlers = {}) {
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

      // GCP STS token exchange
      if (url.pathname === '/v1/token' && req.method === 'POST') {
        const handler = handlers.stsToken || (() => ({
          statusCode: 200,
          body: JSON.stringify({
            access_token: 'mock-federated-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        }));
        const result = handler(body, req);
        res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
        res.end(result.body);
        return;
      }

      // GCP service account impersonation
      if (url.pathname.includes(':generateAccessToken') && req.method === 'POST') {
        const handler = handlers.impersonate || (() => ({
          statusCode: 200,
          body: JSON.stringify({
            accessToken: 'mock-sa-token',
            expireTime: new Date(Date.now() + 3600000).toISOString(),
          }),
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

describe('GcpOidcTokenProvider', () => {
  let mockServer;
  let serverPort;

  beforeAll((done) => {
    mockServer = createMockServer();
    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = mockServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    mockServer.close(done);
  });

  it('should exchange GitHub OIDC for GCP federated token (direct access)', async () => {
    const provider = new GcpOidcTokenProvider({
      requestUrl: `http://127.0.0.1:${serverPort}/token`,
      requestToken: 'mock-request-token',
      workloadIdentityProvider: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
    });

    // Override _exchangeForGcpToken to use mock server
    provider._exchangeForGcpToken = async (jwt) => {
      // Call mock STS endpoint directly via http
      const { httpPost } = require('./github-oidc');
      const body = JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: jwt,
      });
      const response = await httpPost(
        `http://127.0.0.1:${serverPort}/v1/token`,
        body,
        { 'Content-Type': 'application/json' }
      );
      const data = JSON.parse(response.body);
      return { access_token: data.access_token, expires_in: data.expires_in || 3600 };
    };

    await provider.initialize();

    expect(provider.isReady()).toBe(true);
    expect(provider.getToken()).toBe('mock-federated-token');

    provider.shutdown();
  });

  it('should exchange GitHub OIDC for GCP token with SA impersonation', async () => {
    const provider = new GcpOidcTokenProvider({
      requestUrl: `http://127.0.0.1:${serverPort}/token`,
      requestToken: 'mock-request-token',
      workloadIdentityProvider: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
      serviceAccount: 'my-sa@project.iam.gserviceaccount.com',
    });

    // Override both exchange methods to use mock server
    provider._exchangeForGcpToken = async () => ({
      access_token: 'mock-federated-token',
      expires_in: 3600,
    });
    provider._impersonateServiceAccount = async (federatedToken) => {
      expect(federatedToken).toBe('mock-federated-token');
      return {
        access_token: 'mock-sa-token',
        expires_in: 3600,
      };
    };

    await provider.initialize();

    expect(provider.isReady()).toBe(true);
    expect(provider.getToken()).toBe('mock-sa-token');

    provider.shutdown();
  });

  it('should return null when not initialized', () => {
    const provider = new GcpOidcTokenProvider({
      requestUrl: 'http://localhost:0/token',
      requestToken: 'test',
      workloadIdentityProvider: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
    });

    expect(provider.isReady()).toBe(false);
    expect(provider.getToken()).toBeNull();
    provider.shutdown();
  });

  it('should handle initialization failure gracefully', async () => {
    const failServer = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    await new Promise(resolve => failServer.listen(0, '127.0.0.1', resolve));
    const failPort = failServer.address().port;

    const provider = new GcpOidcTokenProvider({
      requestUrl: `http://127.0.0.1:${failPort}/token`,
      requestToken: 'bad-token',
      workloadIdentityProvider: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
      retryDelayMs: 10,
      maxInitRetries: 2,
    });

    await provider.initialize();

    expect(provider.isReady()).toBe(false);
    expect(provider.getToken()).toBeNull();

    provider.shutdown();
    await new Promise(resolve => failServer.close(resolve));
  });

  it('should use workloadIdentityProvider as default audience', () => {
    const wip = 'projects/123/locations/global/workloadIdentityPools/pool/providers/github';
    const provider = new GcpOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      workloadIdentityProvider: wip,
    });

    expect(provider._oidcAudience).toBe(wip);
    provider.shutdown();
  });

  it('should allow custom audience override', () => {
    const provider = new GcpOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      workloadIdentityProvider: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
      oidcAudience: 'custom-audience',
    });

    expect(provider._oidcAudience).toBe('custom-audience');
    provider.shutdown();
  });
});
