// Tests for oidc-adapter-utils.js (auth/OIDC helper module)
const {
  isValidHeaderName,
  validateAuthHeaderEnv,
  createOidcRuntimeAdapterMethods,
  resolveOidcAuthHeaders,
  resolveAuthHeadersWithFallback,
  buildOidcUnavailableScaffold,
} = require('./oidc-adapter-utils');

describe('isValidHeaderName', () => {
  it('accepts legal HTTP header names', () => {
    expect(isValidHeaderName('x-api-key')).toBe(true);
  });

  it('rejects invalid HTTP header names', () => {
    expect(isValidHeaderName('bad header')).toBe(false);
  });
});

describe('validateAuthHeaderEnv', () => {
  it('returns the trimmed header value', () => {
    expect(validateAuthHeaderEnv('AWF_OPENAI_AUTH_HEADER', ' api-key ')).toBe('api-key');
  });

  it('falls back to the default header when env is empty', () => {
    expect(validateAuthHeaderEnv('AWF_ANTHROPIC_AUTH_HEADER', '', 'x-api-key')).toBe('x-api-key');
  });

  it('throws on invalid header names', () => {
    expect(() => validateAuthHeaderEnv('AWF_OPENAI_AUTH_HEADER', 'bad header'))
      .toThrow('Invalid AWF_OPENAI_AUTH_HEADER value: expected a valid HTTP header name');
  });
});

describe('createOidcRuntimeAdapterMethods', () => {
  it('is enabled when static auth is configured', () => {
    const methods = createOidcRuntimeAdapterMethods({
      staticAuthToken: 'token',
      oidcProvider: null,
      awsOidcProvider: null,
    });

    expect(methods.isEnabled()).toBe(true);
  });

  it('is enabled when either OIDC provider is ready', () => {
    const methods = createOidcRuntimeAdapterMethods({
      staticAuthToken: undefined,
      oidcProvider: { isReady: () => true },
      awsOidcProvider: { isReady: () => false },
    });

    expect(methods.isEnabled()).toBe(true);
    expect(methods.getOidcProvider()).toEqual({ isReady: expect.any(Function) });
    expect(methods.getAwsOidcProvider()).toEqual({ isReady: expect.any(Function) });
  });

  it('is disabled while selected OIDC auth is pending even when a static key exists', () => {
    const methods = createOidcRuntimeAdapterMethods({
      staticAuthToken: 'static-token',
      oidcProvider: { isReady: () => false },
      awsOidcProvider: null,
    });

    expect(methods.isEnabled()).toBe(false);
  });
});

describe('resolveOidcAuthHeaders', () => {
  it('returns built headers for bearer-compatible OIDC tokens', () => {
    const headers = resolveOidcAuthHeaders({
      oidcProvider: { getToken: () => 'oidc-token' },
      awsOidcProvider: null,
      buildOidcHeaders: (token) => ({ Authorization: ['Bearer', token].join(' ') }),
    });

    expect(headers).toEqual({ Authorization: ['Bearer', 'oidc-token'].join(' ') });
  });

  it('returns an empty object when OIDC token is not available yet', () => {
    const headers = resolveOidcAuthHeaders({
      oidcProvider: { getToken: () => '' },
      awsOidcProvider: null,
      buildOidcHeaders: () => ({ Authorization: 'ignored-token' }),
    });

    expect(headers).toEqual({});
  });

  it('returns an empty object for AWS OIDC request-signing flow', () => {
    const headers = resolveOidcAuthHeaders({
      oidcProvider: null,
      awsOidcProvider: { isReady: () => true },
      buildOidcHeaders: () => ({ Authorization: 'ignored-token' }),
    });

    expect(headers).toEqual({});
  });

  it('returns null when OIDC is not configured', () => {
    const headers = resolveOidcAuthHeaders({
      oidcProvider: null,
      awsOidcProvider: null,
      buildOidcHeaders: () => ({ Authorization: 'ignored-token' }),
    });

    expect(headers).toBeNull();
  });

  it('bearer OIDC takes precedence when both providers are configured', () => {
    const headers = resolveOidcAuthHeaders({
      oidcProvider: { getToken: () => 'bearer-oidc-token' },
      awsOidcProvider: { isReady: () => true },
      buildOidcHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
    });

    expect(headers).toEqual({ Authorization: 'Bearer bearer-oidc-token' });
  });
});

describe('resolveAuthHeadersWithFallback', () => {
  it('returns OIDC headers when token is available', () => {
    const headers = resolveAuthHeadersWithFallback({
      oidcProvider: { getToken: () => 'oidc-token' },
      awsOidcProvider: null,
      buildOidcHeaders: (token) => ({ Authorization: ['oidc', token].join(':') }),
      staticHeaders: { 'x-api-key': 'static-token' },
    });

    expect(headers).toEqual({ Authorization: 'oidc:oidc-token' });
  });

  it('returns an empty object when OIDC is configured but token is unavailable', () => {
    const headers = resolveAuthHeadersWithFallback({
      oidcProvider: { getToken: () => '' },
      awsOidcProvider: null,
      buildOidcHeaders: () => ({ Authorization: 'ignored-token' }),
      staticHeaders: { 'x-api-key': 'static-token' },
    });

    expect(headers).toEqual({});
  });

  it('falls back to static headers when OIDC is not configured', () => {
    const headers = resolveAuthHeadersWithFallback({
      oidcProvider: null,
      awsOidcProvider: null,
      buildOidcHeaders: () => ({ Authorization: 'ignored-token' }),
      staticHeaders: { 'x-api-key': 'static-token' },
    });

    expect(headers).toEqual({ 'x-api-key': 'static-token' });
  });
});

describe('buildOidcUnavailableScaffold', () => {
  it('returns null from both callbacks when OIDC was not requested', () => {
    const scaffold = buildOidcUnavailableScaffold({
      requested: false,
      configured: false,
      unavailableMessage: 'unavailable; retry shortly',
    });

    expect(scaffold.unconfiguredResponseWhen()).toBeNull();
    expect(scaffold.unavailableWhen()).toBeNull();
  });

  it('reports a retryable provider_not_configured response and unavailable health state when configured but no token yet', () => {
    const scaffold = buildOidcUnavailableScaffold({
      requested: true,
      configured: true,
      unavailableMessage: 'OIDC token unavailable; retry shortly',
      unconfiguredMessage: 'OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN.',
    });

    expect(scaffold.unconfiguredResponseWhen()).toEqual({
      kind: 'provider_not_configured',
      message: 'OIDC token unavailable; retry shortly',
      retryable: true,
    });
    expect(scaffold.unavailableWhen()).toEqual({
      message: 'OIDC token unavailable; retry shortly',
      status: 'unavailable',
    });
  });

  it('reports a non-retryable response and the unconfigured message when OIDC was requested but never initialised', () => {
    const scaffold = buildOidcUnavailableScaffold({
      requested: true,
      configured: false,
      unavailableMessage: 'OIDC token unavailable; retry shortly',
      unconfiguredMessage: 'OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN.',
    });

    expect(scaffold.unconfiguredResponseWhen()).toEqual({
      kind: 'provider_not_configured',
      message: 'OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN.',
      retryable: false,
    });
    expect(scaffold.unavailableWhen()).toEqual({
      message: 'OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN.',
      status: 'unavailable',
    });
  });

  it('falls back to unavailableMessage when unconfiguredMessage is omitted', () => {
    const scaffold = buildOidcUnavailableScaffold({
      requested: true,
      configured: false,
      unavailableMessage: 'OIDC token unavailable; retry shortly',
    });

    expect(scaffold.unconfiguredResponseWhen()).toEqual({
      kind: 'provider_not_configured',
      message: 'OIDC token unavailable; retry shortly',
      retryable: false,
    });
  });
});
