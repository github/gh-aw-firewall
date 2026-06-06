'use strict';

const { resolveCloudOidcProviders } = require('./cloud-oidc-init');

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
});
