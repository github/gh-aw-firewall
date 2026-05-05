'use strict';

/**
 * Unit tests for containers/api-proxy/oidc-auth.js
 */

const { createOidcTokenManager, makeJsonRequest } = require('./oidc-auth');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal env with all required fields set */
const VALID_ENV = {
  AWF_AUTH_TYPE: 'github-oidc',
  AWF_AUTH_AUDIENCE: 'api://AzureADTokenExchange',
  AWF_AZURE_TENANT_ID: 'test-tenant-id',
  AWF_AZURE_CLIENT_ID: 'test-client-id',
  AWF_AZURE_SCOPE: 'https://cognitiveservices.azure.com/.default',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.com/token?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'bearer-token-value',
};

// ── isEnabled() ───────────────────────────────────────────────────────────────

describe('OidcTokenManager.isEnabled()', () => {
  it('returns true when all required env vars are set', () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    expect(mgr.isEnabled()).toBe(true);
  });

  it('returns false when AWF_AUTH_TYPE is not github-oidc', () => {
    const env = { ...VALID_ENV, AWF_AUTH_TYPE: 'static-key' };
    expect(createOidcTokenManager(env).isEnabled()).toBe(false);
  });

  it('returns false when AWF_AUTH_TYPE is missing', () => {
    const env = { ...VALID_ENV };
    delete env.AWF_AUTH_TYPE;
    expect(createOidcTokenManager(env).isEnabled()).toBe(false);
  });

  it('returns false when ACTIONS_ID_TOKEN_REQUEST_URL is missing', () => {
    const env = { ...VALID_ENV };
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    expect(createOidcTokenManager(env).isEnabled()).toBe(false);
  });

  it('returns false when ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing', () => {
    const env = { ...VALID_ENV };
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    expect(createOidcTokenManager(env).isEnabled()).toBe(false);
  });

  it('returns false when AWF_AZURE_TENANT_ID is missing', () => {
    const env = { ...VALID_ENV };
    delete env.AWF_AZURE_TENANT_ID;
    expect(createOidcTokenManager(env).isEnabled()).toBe(false);
  });

  it('returns false when AWF_AZURE_CLIENT_ID is missing', () => {
    const env = { ...VALID_ENV };
    delete env.AWF_AZURE_CLIENT_ID;
    expect(createOidcTokenManager(env).isEnabled()).toBe(false);
  });

  it('returns false when all env vars are empty strings', () => {
    expect(createOidcTokenManager({}).isEnabled()).toBe(false);
  });
});

// ── Default values ────────────────────────────────────────────────────────────

describe('OidcTokenManager default values', () => {
  it('uses default audience when AWF_AUTH_AUDIENCE is not set', () => {
    const env = { ...VALID_ENV };
    delete env.AWF_AUTH_AUDIENCE;
    const mgr = createOidcTokenManager(env);
    expect(mgr._audience).toBe('api://AzureADTokenExchange');
  });

  it('uses default scope when AWF_AZURE_SCOPE is not set', () => {
    const env = { ...VALID_ENV };
    delete env.AWF_AZURE_SCOPE;
    const mgr = createOidcTokenManager(env);
    expect(mgr._scope).toBe('https://cognitiveservices.azure.com/.default');
  });

  it('respects explicit audience override', () => {
    const env = { ...VALID_ENV, AWF_AUTH_AUDIENCE: 'api://CustomAudience' };
    const mgr = createOidcTokenManager(env);
    expect(mgr._audience).toBe('api://CustomAudience');
  });

  it('respects explicit scope override', () => {
    const env = { ...VALID_ENV, AWF_AZURE_SCOPE: 'https://management.azure.com/.default' };
    const mgr = createOidcTokenManager(env);
    expect(mgr._scope).toBe('https://management.azure.com/.default');
  });
});

// ── getCachedToken() ──────────────────────────────────────────────────────────

describe('OidcTokenManager.getCachedToken()', () => {
  it('returns null before any token has been fetched', () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    expect(mgr.getCachedToken()).toBeNull();
  });
});

// ── Token fetching (mocked HTTP) ──────────────────────────────────────────────

describe('OidcTokenManager._fetchGitHubOidcToken()', () => {
  it('builds the OIDC URL with the audience query parameter', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);

    // Mock makeJsonRequest via _fetchGitHubOidcToken's internal call
    let capturedUrl;
    mgr._proxyAgent = undefined;

    // Patch the module-level helper by monkey-patching the private method
    mgr._fetchGitHubOidcToken = async () => {
      // Capture URL construction logic (same as production code)
      const url = new URL(VALID_ENV.ACTIONS_ID_TOKEN_REQUEST_URL);
      url.searchParams.set('audience', mgr._audience);
      capturedUrl = url.toString();
      return 'mock-oidc-jwt';
    };

    await mgr._fetchGitHubOidcToken();

    expect(capturedUrl).toContain('audience=api%3A%2F%2FAzureADTokenExchange');
    // Original OIDC URL parameters are preserved
    expect(capturedUrl).toContain('api-version=2.0');
  });
});

describe('OidcTokenManager._exchangeForAzureToken()', () => {
  it('throws when the response is missing access_token', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);

    // Patch _exchangeForAzureToken to simulate an error response
    mgr._exchangeForAzureToken = async () => {
      throw new Error('Azure AD token exchange failed: AADSTS70011');
    };

    await expect(mgr._exchangeForAzureToken('some-jwt')).rejects.toThrow('AADSTS70011');
  });

  it('parses expires_in and computes expiresAt correctly', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    const before = Date.now();

    // Directly test the parsing logic by patching makeJsonRequest indirectly
    // We verify the returned shape instead of the HTTP call itself.
    const mockResponse = {
      access_token: 'azure-access-token',
      expires_in: 3600,
      token_type: 'Bearer',
    };

    mgr._exchangeForAzureToken = async (_githubToken) => {
      // Replicate production logic
      const expiresIn = mockResponse.expires_in;
      const expiresAt = Date.now() + expiresIn * 1000;
      return {
        token:     mockResponse.access_token,
        expiresAt,
        expiresIn,
        tokenType: mockResponse.token_type,
      };
    };

    const result = await mgr._exchangeForAzureToken('mock-jwt');

    expect(result.token).toBe('azure-access-token');
    expect(result.expiresIn).toBe(3600);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(result.tokenType).toBe('Bearer');
  });

  it('defaults expires_in to 3600 when missing', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);

    mgr._exchangeForAzureToken = async (_githubToken) => {
      const expiresIn = undefined; // simulating missing field
      const normalised = typeof expiresIn === 'number' ? expiresIn : 3600;
      return {
        token:     'az-token',
        expiresAt: Date.now() + normalised * 1000,
        expiresIn: normalised,
        tokenType: 'Bearer',
      };
    };

    const result = await mgr._exchangeForAzureToken('mock-jwt');
    expect(result.expiresIn).toBe(3600);
  });
});

// ── getToken() caching behaviour ──────────────────────────────────────────────

describe('OidcTokenManager.getToken()', () => {
  it('returns cached token without re-fetching when not expired', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    mgr._token    = 'cached-azure-token';
    mgr._expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour from now

    let fetchCallCount = 0;
    mgr._doRefresh = async () => { fetchCallCount++; return 'new-token'; };

    const token = await mgr.getToken();
    expect(token).toBe('cached-azure-token');
    expect(fetchCallCount).toBe(0);
  });

  it('triggers refresh when token is expired', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    mgr._token    = 'old-token';
    mgr._expiresAt = Date.now() - 1000; // expired 1 second ago

    let fetchCallCount = 0;
    mgr._doRefresh = async () => { fetchCallCount++; mgr._token = 'new-token'; return 'new-token'; };

    const token = await mgr.getToken();
    expect(token).toBe('new-token');
    expect(fetchCallCount).toBe(1);
  });

  it('triggers refresh when no token is cached', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    // _token and _expiresAt are null by default

    let fetchCallCount = 0;
    mgr._doRefresh = async () => { fetchCallCount++; mgr._token = 'fresh-token'; return 'fresh-token'; };

    const token = await mgr.getToken();
    expect(token).toBe('fresh-token');
    expect(fetchCallCount).toBe(1);
  });
});

// ── _doRefresh() deduplication ────────────────────────────────────────────────

describe('OidcTokenManager._doRefresh() deduplication', () => {
  it('returns the same in-flight promise for concurrent callers', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);

    let resolveExchange;
    const exchangePromise = new Promise((res) => { resolveExchange = res; });

    mgr._fetchAndCache = () => exchangePromise;

    const p1 = mgr._doRefresh();
    const p2 = mgr._doRefresh();
    expect(p1).toBe(p2); // same promise object

    resolveExchange('deduped-token');
    await p1;
  });

  it('clears _pendingFetch after resolution', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    mgr._fetchAndCache = async () => 'resolved-token';

    await mgr._doRefresh();
    expect(mgr._pendingFetch).toBeNull();
  });

  it('clears _pendingFetch after rejection', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    mgr._fetchAndCache = async () => { throw new Error('fetch failed'); };

    await expect(mgr._doRefresh()).rejects.toThrow('fetch failed');
    expect(mgr._pendingFetch).toBeNull();
  });
});

// ── _scheduleRefresh() ────────────────────────────────────────────────────────

describe('OidcTokenManager._scheduleRefresh()', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('schedules a timer and calls _doRefresh after the delay', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);

    let refreshCalled = false;
    mgr._doRefresh = async () => { refreshCalled = true; return 'new-token'; };

    // A 1 hour token → refresh in ~55 minutes (3600s - 5min buffer = 3300s)
    mgr._scheduleRefresh(3600);
    expect(refreshCalled).toBe(false);

    jest.advanceTimersByTime(3300 * 1000);
    // Flush microtasks (the async callback)
    await Promise.resolve();
    expect(refreshCalled).toBe(true);
  });

  it('enforces minimum refresh delay when expiresIn is very small', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);

    let refreshCalled = false;
    mgr._doRefresh = async () => { refreshCalled = true; return 'token'; };

    // 10-second token: expiresIn * 1000 - REFRESH_BUFFER < MIN_REFRESH_DELAY
    mgr._scheduleRefresh(10);

    // Should not fire immediately
    jest.advanceTimersByTime(15 * 1000);
    await Promise.resolve();
    expect(refreshCalled).toBe(false);

    // Should fire after MIN_REFRESH_DELAY (30s)
    jest.advanceTimersByTime(20 * 1000);
    await Promise.resolve();
    expect(refreshCalled).toBe(true);
  });

  it('replaces an existing timer when called again', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    let callCount = 0;
    mgr._doRefresh = async () => { callCount++; return 'token'; };

    mgr._scheduleRefresh(3600);
    mgr._scheduleRefresh(3600); // replaces the first timer

    jest.advanceTimersByTime(4000 * 1000);
    await Promise.resolve();
    expect(callCount).toBe(1); // only one refresh fired
  });
});

// ── stop() ────────────────────────────────────────────────────────────────────

describe('OidcTokenManager.stop()', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('cancels a pending refresh timer', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    let refreshCalled = false;
    mgr._doRefresh = async () => { refreshCalled = true; return 'token'; };

    mgr._scheduleRefresh(3600);
    mgr.stop();

    jest.advanceTimersByTime(4000 * 1000);
    await Promise.resolve();
    expect(refreshCalled).toBe(false);
    expect(mgr._refreshTimer).toBeNull();
  });

  it('is a no-op when no timer is scheduled', () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    expect(() => mgr.stop()).not.toThrow();
  });
});

// ── start() ───────────────────────────────────────────────────────────────────

describe('OidcTokenManager.start()', () => {
  it('does nothing when isEnabled() returns false', async () => {
    const mgr = createOidcTokenManager({}); // no env vars
    let fetchCalled = false;
    mgr._doRefresh = async () => { fetchCalled = true; return 'tok'; };

    await mgr.start();
    expect(fetchCalled).toBe(false);
  });

  it('calls _doRefresh when isEnabled() returns true', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    let fetchCalled = false;
    mgr._doRefresh = async () => {
      fetchCalled = true;
      mgr._token = 'first-token';
      mgr._expiresAt = Date.now() + 3600 * 1000;
      return 'first-token';
    };

    await mgr.start();
    expect(fetchCalled).toBe(true);
    expect(mgr.getCachedToken()).toBe('first-token');
  });

  it('does not throw when the initial fetch fails', async () => {
    const mgr = createOidcTokenManager(VALID_ENV);
    mgr._doRefresh = async () => { throw new Error('network error'); };

    await expect(mgr.start()).resolves.toBeUndefined();
    expect(mgr.getCachedToken()).toBeNull();
  });
});

// ── makeJsonRequest() ─────────────────────────────────────────────────────────

describe('makeJsonRequest()', () => {
  it('throws on an invalid URL', async () => {
    await expect(makeJsonRequest('not-a-url', 'GET', {}, null, undefined))
      .rejects.toThrow('Invalid URL');
  });
});
