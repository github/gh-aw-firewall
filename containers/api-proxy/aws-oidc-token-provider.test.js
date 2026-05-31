'use strict';

const http = require('http');
const { AwsOidcTokenProvider } = require('./aws-oidc-token-provider');
const { createBaseMockServer } = require('./test-helpers/mock-oidc-server');
const { withMockServer } = require('./test-helpers/oidc-test-helpers.test-utils');

function createMockServer(handlers = {}) {
  return createBaseMockServer((url, req, res, routeHandlers) => {
    if (url.pathname === '/' && url.searchParams.get('Action') === 'AssumeRoleWithWebIdentity') {
      const handler = routeHandlers.stsAssume || (() => ({
        statusCode: 200,
        body: JSON.stringify({
          AssumeRoleWithWebIdentityResponse: {
            AssumeRoleWithWebIdentityResult: {
              Credentials: {
                AccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
                SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
                SessionToken: 'FwoGZXIvYXdzEBYaDN...',
                Expiration: new Date(Date.now() + 3600000).toISOString(),
              },
              AssumedRoleUser: {
                AssumedRoleId: 'AROA3XFRBF23:awf-oidc-session',
                Arn: 'arn:aws:sts::123456789012:assumed-role/role/awf-oidc-session',
              },
            },
          },
        }),
      }));
      const result = handler(url, req);
      res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      res.end(result.body);
      return true;
    }

    return false;
  }, handlers);
}

describe('AwsOidcTokenProvider', () => {
  const { getServerPort } = withMockServer(createMockServer);

  it('should exchange GitHub OIDC for AWS temporary credentials', async () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: `http://127.0.0.1:${getServerPort()}/token`,
      requestToken: 'mock-request-token',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      region: 'us-east-1',
    });

    // Override STS host to use mock server
    provider._resolveStsHost = () => `127.0.0.1:${getServerPort()}`;
    // Override to use http instead of https
    const { httpGet } = require('./github-oidc');
    provider._assumeRoleWithWebIdentity = async (oidcJwt) => {
      const params = new URLSearchParams({
        Action: 'AssumeRoleWithWebIdentity',
        Version: '2011-06-15',
        RoleArn: provider._roleArn,
        RoleSessionName: provider._roleSessionName,
        WebIdentityToken: oidcJwt,
      });
      const url = `http://127.0.0.1:${getServerPort()}/?${params.toString()}`;
      const response = await httpGet(url, { 'Accept': 'application/json' });
      const data = JSON.parse(response.body);
      const result = data.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult;
      const creds = result.Credentials;
      const expiration = new Date(creds.Expiration);
      const expiresIn = Math.floor((expiration.getTime() - Date.now()) / 1000);
      return {
        credentials: {
          accessKeyId: creds.AccessKeyId,
          secretAccessKey: creds.SecretAccessKey,
          sessionToken: creds.SessionToken,
        },
        expires_in: expiresIn > 0 ? expiresIn : 3600,
      };
    };

    await provider.initialize();

    expect(provider.isReady()).toBe(true);
    const creds = provider.getCredentials();
    expect(creds).not.toBeNull();
    expect(creds.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(creds.secretAccessKey).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(creds.sessionToken).toBeTruthy();

    provider.shutdown();
  });

  it('should return null when not initialized', () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: 'http://localhost:0/token',
      requestToken: 'test',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      region: 'us-east-1',
    });

    expect(provider.isReady()).toBe(false);
    expect(provider.getCredentials()).toBeNull();
    provider.shutdown();
  });

  it('should resolve correct STS host for standard regions', () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      region: 'us-east-1',
    });
    expect(provider._resolveStsHost()).toBe('sts.us-east-1.amazonaws.com');
    provider.shutdown();
  });

  it('should resolve correct STS host for China regions', () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      roleArn: 'arn:aws-cn:iam::123456789012:role/my-role',
      region: 'cn-north-1',
    });
    expect(provider._resolveStsHost()).toBe('sts.cn-north-1.amazonaws.com.cn');
    provider.shutdown();
  });

  it('should resolve correct STS host for GovCloud regions', () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      roleArn: 'arn:aws-us-gov:iam::123456789012:role/my-role',
      region: 'us-gov-west-1',
    });
    expect(provider._resolveStsHost()).toBe('sts.us-gov-west-1.amazonaws.com');
    provider.shutdown();
  });

  it('should use sts.amazonaws.com as default audience', () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      region: 'us-east-1',
    });
    expect(provider._oidcAudience).toBe('sts.amazonaws.com');
    provider.shutdown();
  });

  it('should use default role session name', () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      region: 'us-east-1',
    });
    expect(provider._roleSessionName).toBe('awf-oidc-session');
    provider.shutdown();
  });

  it('should allow custom role session name', () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      region: 'us-east-1',
      roleSessionName: 'custom-session',
    });
    expect(provider._roleSessionName).toBe('custom-session');
    provider.shutdown();
  });

  it('should expose region via getRegion()', () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      region: 'eu-west-1',
    });
    expect(provider.getRegion()).toBe('eu-west-1');
    provider.shutdown();
  });

  it('should handle initialization failure gracefully', async () => {
    const failServer = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });

    await new Promise(resolve => failServer.listen(0, '127.0.0.1', resolve));
    const failPort = failServer.address().port;

    const provider = new AwsOidcTokenProvider({
      requestUrl: `http://127.0.0.1:${failPort}/token`,
      requestToken: 'bad-token',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      region: 'us-east-1',
      retryDelayMs: 10,
      maxInitRetries: 2,
    });

    await provider.initialize();

    expect(provider.isReady()).toBe(false);
    expect(provider.getCredentials()).toBeNull();

    provider.shutdown();
    await new Promise(resolve => failServer.close(resolve));
  });

  it('should not schedule refresh after shutdown during in-flight refresh', async () => {
    const provider = new AwsOidcTokenProvider({
      requestUrl: 'http://localhost/token',
      requestToken: 'test',
      roleArn: 'arn:aws:iam::123456789012:role/my-role',
      region: 'us-east-1',
    });

    let releaseRefresh;
    provider._refreshCredentials = jest.fn(async () => {
      await new Promise(resolve => { releaseRefresh = resolve; });
      provider._scheduleRefresh(1000);
    });

    const initPromise = provider.initialize();
    await new Promise(resolve => setImmediate(resolve));

    provider.shutdown();
    releaseRefresh();
    await initPromise;

    expect(provider._refreshTimer).toBeNull();
  });
});

describe('OpenAI adapter with AWS OIDC', () => {
  const { createOpenAIAdapter } = require('./providers/openai');

  it('should create AWS OIDC provider when provider is aws', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'aws',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/my-role',
      AWF_AUTH_AWS_REGION: 'us-east-1',
    });

    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.getAwsOidcProvider()).not.toBeNull();
    expect(adapter.getReflectionInfo().auth_type).toBe('github-oidc/aws');

    adapter.getAwsOidcProvider().shutdown();
  });

  it('should not create AWS provider when required vars are missing', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'aws',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      // Missing AWF_AUTH_AWS_ROLE_ARN and AWF_AUTH_AWS_REGION
    });

    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.getAwsOidcProvider()).toBeNull();
  });
});

describe('OpenAI adapter with GCP OIDC', () => {
  const { createOpenAIAdapter } = require('./providers/openai');

  it('should create GCP OIDC provider when provider is gcp', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'gcp',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
    });

    expect(adapter.getOidcProvider()).not.toBeNull();
    expect(adapter.getAwsOidcProvider()).toBeNull();
    expect(adapter.getReflectionInfo().auth_type).toBe('github-oidc/gcp');

    adapter.getOidcProvider().shutdown();
  });

  it('should not create GCP provider when workload identity provider is missing', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'gcp',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      // Missing AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER
    });

    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.getAwsOidcProvider()).toBeNull();
  });
});
