'use strict';

const http = require('http');
const { httpPost } = require('./github-oidc');
const { AnthropicOidcTokenProvider } = require('./anthropic-oidc-token-provider');
const { createBaseMockServer } = require('./test-helpers/mock-oidc-server');

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

describe('AnthropicOidcTokenProvider', () => {
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

  it('should exchange GitHub OIDC for an Anthropic workload identity token', async () => {
    const provider = new AnthropicOidcTokenProvider({
      requestUrl: `http://127.0.0.1:${serverPort}/token`,
      requestToken: 'mock-request-token',
    });

    provider._exchangeForAnthropicToken = async (jwt) => {
      const response = await httpPost(
        `http://127.0.0.1:${serverPort}/v1/oauth/token`,
        JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
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
    const provider = new AnthropicOidcTokenProvider({
      requestUrl: 'http://localhost:0/token',
      requestToken: 'test',
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

    const provider = new AnthropicOidcTokenProvider({
      requestUrl: `http://127.0.0.1:${failPort}/token`,
      requestToken: 'bad-token',
      retryDelayMs: 10,
      maxInitRetries: 2,
    });

    await provider.initialize();

    expect(provider.isReady()).toBe(false);
    expect(provider.getToken()).toBeNull();

    provider.shutdown();
    await new Promise(resolve => failServer.close(resolve));
  });

  it('should use https://api.anthropic.com as default audience', () => {
    const provider = new AnthropicOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
    });

    expect(provider._oidcAudience).toBe('https://api.anthropic.com');
    provider.shutdown();
  });
});
