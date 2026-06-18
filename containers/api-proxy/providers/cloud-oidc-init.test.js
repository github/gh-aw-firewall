'use strict';

const { resolveCloudOidcProviders, createProviderOidcAuth } = require('./cloud-oidc-init');

describe('resolveCloudOidcProviders', () => {
  it('returns no providers when github-oidc is not configured', () => {
    const result = resolveCloudOidcProviders({});
    expect(result.authProvider).toBe('azure');
    expect(result.oidcProvider).toBeNull();
    expect(result.awsOidcProvider).toBeNull();
    expect(result.oidcConfigured).toBe(false);
  });

  it('supports skipping provider initialization when skipWhen=true', () => {
    const result = resolveCloudOidcProviders({
      AWF_AUTH_TYPE: 'github-oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
    }, { skipWhen: true });

    expect(result.oidcProvider).toBeNull();
    expect(result.awsOidcProvider).toBeNull();
    expect(result.oidcConfigured).toBe(false);
  });

  it('creates Azure provider by default when configured', () => {
    const result = resolveCloudOidcProviders({
      AWF_AUTH_TYPE: 'github-oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
    });

    expect(result.authProvider).toBe('azure');
    expect(result.oidcProvider).toBeTruthy();
    expect(result.awsOidcProvider).toBeNull();
    expect(result.oidcConfigured).toBe(true);

    result.oidcProvider.shutdown();
  });

  it('creates AWS provider when configured', () => {
    const result = resolveCloudOidcProviders({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'aws',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/my-role',
      AWF_AUTH_AWS_REGION: 'us-east-1',
    });

    expect(result.authProvider).toBe('aws');
    expect(result.oidcProvider).toBeNull();
    expect(result.awsOidcProvider).toBeTruthy();
    expect(result.oidcConfigured).toBe(true);

    result.awsOidcProvider.shutdown();
  });

  it('creates GCP provider when configured', () => {
    const result = resolveCloudOidcProviders({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'gcp',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/pool/providers/provider',
    });

    expect(result.authProvider).toBe('gcp');
    expect(result.oidcProvider).toBeTruthy();
    expect(result.awsOidcProvider).toBeNull();
    expect(result.oidcConfigured).toBe(true);

    result.oidcProvider.shutdown();
  });
});

describe('createProviderOidcAuth', () => {
  it('returns no providers and a disabled bundle when OIDC is not configured', () => {
    const auth = createProviderOidcAuth({});

    expect(auth.authProvider).toBe('azure');
    expect(auth.oidcProvider).toBeNull();
    expect(auth.awsOidcProvider).toBeNull();
    expect(auth.oidcConfigured).toBe(false);
    expect(auth.runtimeMethods.isEnabled()).toBe(false);
    expect(auth.validationSkip()).toBeNull();
    expect(auth.skipModelsFetch()).toBe(false);
  });

  it('isEnabled() returns true when staticAuthToken is set (no OIDC)', () => {
    const auth = createProviderOidcAuth({}, { staticAuthToken: 'my-api-key' });

    expect(auth.oidcConfigured).toBe(false);
    expect(auth.runtimeMethods.isEnabled()).toBe(true);
  });

  it('creates Azure OIDC provider and marks validationSkip/skipModelsFetch', () => {
    const auth = createProviderOidcAuth({
      AWF_AUTH_TYPE: 'github-oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
    });

    expect(auth.authProvider).toBe('azure');
    expect(auth.oidcProvider).toBeTruthy();
    expect(auth.awsOidcProvider).toBeNull();
    expect(auth.oidcConfigured).toBe(true);
    expect(auth.validationSkip()).toEqual({ skip: true, reason: 'OIDC auth; validation via token acquisition' });
    expect(auth.skipModelsFetch()).toBe(true);

    auth.oidcProvider.shutdown();
  });

  it('skipWhen=true suppresses OIDC initialisation', () => {
    const auth = createProviderOidcAuth({
      AWF_AUTH_TYPE: 'github-oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
      AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
    }, { skipWhen: true });

    expect(auth.oidcProvider).toBeNull();
    expect(auth.oidcConfigured).toBe(false);
  });

  it('resolveAuthHeaders returns OIDC headers when a token is available', () => {
    const auth = createProviderOidcAuth({}, {
      // Bypass resolveCloudOidcProviders by using a factory
      oidcProviderFactory: () => ({ isReady: () => true, getToken: () => 'oidc-token' }),
    });

    const headers = auth.resolveAuthHeaders(
      (token) => ({ Authorization: 'Bearer ' + token }),
      { 'x-api-key': 'static' },
    );

    expect(headers).toEqual({ Authorization: 'Bearer oidc-token' });
  });

  it('resolveAuthHeaders returns empty object when OIDC is configured but token not yet ready', () => {
    const auth = createProviderOidcAuth({}, {
      oidcProviderFactory: () => ({ isReady: () => false, getToken: () => '' }),
    });

    const headers = auth.resolveAuthHeaders(
      (token) => ({ Authorization: 'Bearer ' + token }),
      { 'x-api-key': 'static' },
    );

    expect(headers).toEqual({});
  });

  it('resolveAuthHeaders returns staticHeaders when OIDC is not configured', () => {
    const auth = createProviderOidcAuth({});

    const headers = auth.resolveAuthHeaders(
      (token) => ({ Authorization: 'Bearer ' + token }),
      { 'x-api-key': 'static-key' },
    );

    expect(headers).toEqual({ 'x-api-key': 'static-key' });
  });

  it('uses custom oidcProviderFactory when provided', () => {
    const mockProvider = { isReady: () => true, getToken: () => 'custom-token' };
    const factory = jest.fn().mockReturnValue(mockProvider);

    const auth = createProviderOidcAuth({ AWF_AUTH_PROVIDER: 'custom-provider' }, {
      oidcProviderFactory: factory,
    });

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ AWF_AUTH_PROVIDER: 'custom-provider' }));
    expect(auth.authProvider).toBe('custom-provider');
    expect(auth.oidcProvider).toBe(mockProvider);
    expect(auth.awsOidcProvider).toBeNull();
    expect(auth.oidcConfigured).toBe(true);
  });

  it('oidcProviderFactory returning null/undefined results in oidcConfigured=false', () => {
    const auth = createProviderOidcAuth({}, {
      oidcProviderFactory: () => null,
    });

    expect(auth.oidcProvider).toBeNull();
    expect(auth.oidcConfigured).toBe(false);
    expect(auth.validationSkip()).toBeNull();
  });
});
