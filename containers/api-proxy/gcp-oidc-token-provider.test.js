'use strict';

const { GcpOidcTokenProvider } = require('./gcp-oidc-token-provider');
const { createBaseMockServer } = require('./test-helpers/mock-oidc-server');
const { withMockServer, testInitializationFailure } = require('./test-helpers/oidc-test-helpers.test-utils');

function createMockServer(handlers = {}) {
  return createBaseMockServer((url, req, res, routeHandlers, body) => {
    if (url.pathname === '/v1/token' && req.method === 'POST') {
      const handler = routeHandlers.stsToken || (() => ({
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
      return true;
    }

    if (url.pathname.includes(':generateAccessToken') && req.method === 'POST') {
      const handler = routeHandlers.impersonate || (() => ({
        statusCode: 200,
        body: JSON.stringify({
          accessToken: 'mock-sa-token',
          expireTime: new Date(Date.now() + 3600000).toISOString(),
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

describe('GcpOidcTokenProvider', () => {
  const { getServerPort } = withMockServer(createMockServer);

  it('should exchange GitHub OIDC for GCP federated token (direct access)', async () => {
    const provider = new GcpOidcTokenProvider({
      requestUrl: `http://127.0.0.1:${getServerPort()}/token`,
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
        `http://127.0.0.1:${getServerPort()}/v1/token`,
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
      requestUrl: `http://127.0.0.1:${getServerPort()}/token`,
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
    await testInitializationFailure(GcpOidcTokenProvider, {
      workloadIdentityProvider: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
    });
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
