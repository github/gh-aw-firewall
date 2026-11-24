'use strict';

jest.mock('./github-oidc', () => ({
  mintGitHubOidcToken: jest.fn(),
  httpPost: jest.fn(),
}));
jest.mock('./logging', () => ({ logRequest: jest.fn() }));

const { mintGitHubOidcToken, httpPost } = require('./github-oidc');
const { logRequest } = require('./logging');
const { DatabricksOidcTokenProvider, MAX_TOKEN_LIFETIME_SECS } = require('./databricks-oidc-token-provider');

const config = {
  host: 'https://workspace.cloud.databricks.com',
  oidcAudience: 'workspace-federation-audience',
  requestUrl: 'https://actions.example/token',
  requestToken: 'synthetic-actions-credential',
  maxInitRetries: 1,
};
const token = 'synthetic-databricks-access-token';
const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const success = expiresIn => ({ statusCode: 200, body: JSON.stringify({ access_token: token, expires_in: expiresIn }) });

describe('DatabricksOidcTokenProvider', () => {
  let provider;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    jest.clearAllMocks();
    mintGitHubOidcToken.mockResolvedValue(jwt({ exp: Date.now() / 1000 + 600 }));
    httpPost.mockResolvedValue(success(3600));
    provider = new DatabricksOidcTokenProvider(config);
  });
  afterEach(() => {
    provider.shutdown();
    jest.useRealTimers();
  });

  it.each([undefined, 'client id+with/special&characters'])('exchanges URL-encoded RFC 8693 parameters with optional client_id=%p', async clientId => {
    provider.shutdown();
    provider = new DatabricksOidcTokenProvider({ ...config, clientId });
    const subject = jwt({ exp: Date.now() / 1000 + 600 });
    await provider.initialize();
    expect(mintGitHubOidcToken).toHaveBeenCalledWith({
      requestUrl: config.requestUrl,
      requestToken: config.requestToken,
      audience: config.oidcAudience,
    });
    const [url, body, headers] = httpPost.mock.calls[0];
    expect(url).toBe(`${config.host}/oidc/v1/token`);
    expect(headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
    const params = new URLSearchParams(body);
    expect(Object.fromEntries(params)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      scope: 'all-apis',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: subject,
      ...(clientId ? { client_id: clientId } : {}),
    });
    expect(provider.getToken()).toBe(token);
  });

  it.each([60, '60', ' 60 ', 0.5, '0.5', '.5', '6e1'])('normalizes positive lifetime %p without rounding expiry up', async expiresIn => {
    httpPost.mockResolvedValue(success(expiresIn));
    await provider.initialize();
    expect(provider._expiresAt).toBe(Date.now() / 1000 + Number(expiresIn));
    provider._scheduleRefresh = jest.fn();
    jest.setSystemTime(Date.now() + Number(expiresIn) * 1000);
    expect(provider.isReady()).toBe(false);
    expect(provider.getToken()).toBeNull();
  });

  it.each([undefined, null, 0, -1, '-1', '', ' ', 'nope', 'Infinity', true, [], {}, '0x10', '1e309'])(
    'fails closed for invalid lifetime %p', async expiresIn => {
      httpPost.mockResolvedValue(success(expiresIn));
      await provider.initialize();
      expect(provider.isReady()).toBe(false);
      expect(provider._cachedToken).toBeNull();
      expect(provider._initError.message).toContain('Databricks OIDC');
      expect(provider._initError.message).toContain('expires_in');
    },
  );

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite lifetime %p', async expiresIn => {
    httpPost.mockResolvedValue({ statusCode: 200, body: `{"access_token":"${token}","expires_in":${expiresIn}}` });
    await provider.initialize();
    expect(provider.isReady()).toBe(false);
  });

  it('caps cache lifetimes even when the JWT has no exp', async () => {
    mintGitHubOidcToken.mockResolvedValue(jwt({}));
    await provider.initialize();
    expect(provider._expiresAt).toBe(Date.now() / 1000 + MAX_TOKEN_LIFETIME_SECS);
  });

  it.each(['malformed', 'header.payload', 'header.payload.signature.extra', '.payload.signature', 'header.payload.'])('rejects malformed GitHub JWT segments %p without exchange or secret echoes', async malformed => {
    mintGitHubOidcToken.mockResolvedValue(malformed);
    await provider.initialize();
    expect(provider.isReady()).toBe(false);
    expect(httpPost).not.toHaveBeenCalled();
    expect(provider._initError.message).toBe('Databricks OIDC received an invalid GitHub JWT');
    expect(JSON.stringify(logRequest.mock.calls)).not.toContain(malformed);
  });

  it('bounds lifetime by GitHub JWT expiry', async () => {
    mintGitHubOidcToken.mockResolvedValue(jwt({ exp: Date.now() / 1000 + 40 }));
    await provider.initialize();
    expect(provider._expiresAt).toBe(Date.now() / 1000 + 40);
  });

  it.each([0, -1, '9999999999', null])('rejects invalid JWT exp %p before exchange', async exp => {
    mintGitHubOidcToken.mockResolvedValue(jwt({ exp }));
    await provider.initialize();
    expect(provider.isReady()).toBe(false);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('rejects an expired GitHub JWT before exchange', async () => {
    mintGitHubOidcToken.mockResolvedValue(jwt({ exp: Date.now() / 1000 - 1 }));
    await provider.initialize();
    expect(provider.isReady()).toBe(false);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('does not extend a lifetime by exchange latency', async () => {
    httpPost.mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 20_000);
      return success(60);
    });
    const started = Date.now() / 1000;
    await provider.initialize();
    expect(provider._expiresAt).toBe(started + 60);
  });

  it('rejects a lifetime that expires during transport', async () => {
    httpPost.mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 61_000);
      return success(60);
    });
    await provider.initialize();
    expect(provider.isReady()).toBe(false);
    expect(provider._initError.message).toContain('expired token lifetime');
  });

  it.each([60, 300])('refreshes at 75%% of %ps without an immediate timer loop', async lifetime => {
    httpPost.mockResolvedValue(success(lifetime));
    await provider.initialize();
    expect(httpPost).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(lifetime * 750 - 1);
    expect(httpPost).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(httpPost).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(httpPost).toHaveBeenCalledTimes(2);
  });

  it('never serves an expired token after a failed refresh', async () => {
    httpPost.mockResolvedValue(success(60));
    await provider.initialize();
    httpPost.mockRejectedValue(new Error('echo synthetic-secret'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(provider.isReady()).toBe(false);
    expect(provider.getToken()).toBeNull();
  });

  it('does not retry a failed refresh after fractional expiry within the same integer second', async () => {
    httpPost.mockResolvedValue(success(0.5));
    await provider.initialize();
    httpPost.mockImplementation(() => new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('synthetic-transport-failure')), 200);
    }));
    await jest.advanceTimersByTimeAsync(575);
    expect(provider.isReady()).toBe(false);
    expect(provider._refreshInFlight).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['github', 'transport', 'status', 'json', 'token', 'jwt'])(
    'redacts %s failures from thrown errors and initialization/refresh logs', async failure => {
      const secret = 'synthetic-secret-jwt-and-credential';
      if (failure === 'github') mintGitHubOidcToken.mockRejectedValue(new Error(secret));
      if (failure === 'transport') httpPost.mockRejectedValue(new Error(secret));
      if (failure === 'status') httpPost.mockResolvedValue({ statusCode: 401, body: secret });
      if (failure === 'json') httpPost.mockResolvedValue({ statusCode: 200, body: `{"${secret}` });
      if (failure === 'token') httpPost.mockResolvedValue({ statusCode: 200, body: JSON.stringify({ access_token: `${secret}\r\nbad`, expires_in: 60 }) });
      if (failure === 'jwt') mintGitHubOidcToken.mockResolvedValue(`header.${Buffer.from(secret).toString('base64url')}.signature`);
      await expect(provider._doRefresh()).rejects.toThrow('Databricks OIDC');
      await provider.initialize();
      provider._scheduleRefresh(0);
      await jest.advanceTimersByTimeAsync(0);
      expect(provider.isReady()).toBe(false);
      expect(provider._initError.message).not.toContain(secret);
      expect(provider._initError.stack).not.toContain(secret);
      expect(JSON.stringify(logRequest.mock.calls)).not.toContain(secret);
      expect(logRequest).toHaveBeenCalledWith('error', 'databricks_oidc_refresh_failed', expect.any(Object));
    },
  );

  it.each([
    '', 'workspace.cloud.databricks.com', 'http://workspace.cloud.databricks.com',
    ' https://workspace.cloud.databricks.com', 'https://workspace.cloud.databricks.com ',
    'https://' + 'user:synthetic-password@workspace.cloud.databricks.com',
    'https://workspace.cloud.databricks.com/path',
    'https://workspace.cloud.databricks.com/path/..',
    'https://workspace.cloud.databricks.com?secret',
    'https://workspace.cloud.databricks.com?',
    'https://workspace.cloud.databricks.com#secret',
    'https://workspace.cloud.databricks.com#',
    'https://workspace.cloud.databricks.com\\evil',
    'https://workspace.cloud.databricks.com:99999',
    'https://workspace.cloud.databricks.com:0', 'https://[::1]',
    'https://work space.cloud.databricks.com',
  ])('rejects unsafe/non-origin host %p without reflecting its value', host => {
    expect(() => new DatabricksOidcTokenProvider({ ...config, host })).toThrow('AWF_AUTH_DATABRICKS_HOST');
    try {
      new DatabricksOidcTokenProvider({ ...config, host });
    } catch (err) {
      expect(err.message).not.toContain('synthetic-password');
      expect(err.message).not.toContain('workspace.cloud.databricks.com');
    }
  });

  it('accepts an HTTPS origin with a port and root slash', () => {
    const candidate = new DatabricksOidcTokenProvider({ ...config, host: 'https://workspace.cloud.databricks.com:8443/' });
    expect(candidate._host).toBe('https://workspace.cloud.databricks.com:8443');
    candidate.shutdown();
  });

  it.each(['oidcAudience', 'requestUrl', 'requestToken'])('rejects missing %s with an explicit safe Databricks error', name => {
    expect(() => new DatabricksOidcTokenProvider({ ...config, [name]: ' ' })).toThrow('Databricks OIDC requires');
  });
});
