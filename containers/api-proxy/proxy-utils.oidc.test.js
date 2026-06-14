const {
  createOidcRuntimeAdapterMethods,
  resolveOidcAuthHeaders,
} = require('./proxy-utils');

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
