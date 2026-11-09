'use strict';

jest.mock('./github-oidc', () => ({
  mintGitHubOidcToken: jest.fn(),
  httpPost: jest.fn(),
}));

const { mintGitHubOidcToken, httpPost } = require('./github-oidc');
const {
  OpenAIOidcTokenProvider,
  OPENAI_TOKEN_ENDPOINT,
  DEFAULT_OPENAI_OIDC_AUDIENCE,
} = require('./openai-oidc-token-provider');

const CONFIG = {
  requestUrl: 'https://actions.example/oidc',
  requestToken: 'actions-token',
  identityProviderId: 'idp_test',
  serviceAccountId: 'sa_test',
};

describe('OpenAIOidcTokenProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mintGitHubOidcToken.mockResolvedValue('github-jwt');
    httpPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ access_token: 'openai-access-token', expires_in: 3600 }),
    });
  });

  it('mints an audience-specific GitHub token, exchanges it, and caches the bearer token', async () => {
    const provider = new OpenAIOidcTokenProvider(CONFIG);

    await provider.initialize();

    expect(mintGitHubOidcToken).toHaveBeenCalledWith({
      requestUrl: CONFIG.requestUrl,
      requestToken: CONFIG.requestToken,
      audience: DEFAULT_OPENAI_OIDC_AUDIENCE,
    });
    expect(httpPost).toHaveBeenCalledWith(
      OPENAI_TOKEN_ENDPOINT,
      JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        subject_token: 'github-jwt',
        identity_provider_id: 'idp_test',
        service_account_id: 'sa_test',
      }),
      { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    );
    expect(provider.isReady()).toBe(true);
    expect(provider.getToken()).toBe('openai-access-token');

    provider.shutdown();
  });

  it('uses a configured audience and caps the cached lifetime at one hour', async () => {
    const provider = new OpenAIOidcTokenProvider({
      ...CONFIG,
      oidcAudience: 'https://custom.openai.example/v1',
    });
    httpPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ access_token: 'openai-access-token', expires_in: 7200 }),
    });

    await provider.initialize();

    expect(mintGitHubOidcToken).toHaveBeenCalledWith(expect.objectContaining({
      audience: 'https://custom.openai.example/v1',
    }));
    expect(provider._expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600);

    provider.shutdown();
  });

  it('rejects unsuccessful exchanges without including response bodies in errors', async () => {
    const provider = new OpenAIOidcTokenProvider(CONFIG);
    httpPost.mockResolvedValue({ statusCode: 401, body: 'response that may contain credentials' });

    await expect(provider._exchangeForOpenAIToken('github-jwt'))
      .rejects.toThrow('OpenAI OAuth token exchange failed: HTTP 401');

    provider.shutdown();
  });

  it.each([
    ['identityProviderId', { ...CONFIG, identityProviderId: '' }],
    ['serviceAccountId', { ...CONFIG, serviceAccountId: '' }],
  ])('requires %s', (_name, config) => {
    expect(() => new OpenAIOidcTokenProvider(config)).toThrow();
  });
});
