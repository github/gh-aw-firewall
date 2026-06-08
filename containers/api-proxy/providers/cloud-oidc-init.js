'use strict';

const { OidcTokenProvider } = require('../oidc-token-provider');

/**
 * Resolve cloud OIDC providers (Azure/AWS/GCP) from environment variables.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ skipWhen?: boolean }} [options]
 * @returns {{ authProvider: string, oidcProvider: any, awsOidcProvider: any, oidcConfigured: boolean }}
 */
function resolveCloudOidcProviders(env, options = {}) {
  const { skipWhen = false } = options;
  const authType = (env.AWF_AUTH_TYPE || '').trim().toLowerCase();
  const authProvider = (env.AWF_AUTH_PROVIDER || 'azure').trim().toLowerCase();
  let oidcProvider = null;
  let awsOidcProvider = null;

  if (authType === 'github-oidc' && !skipWhen) {
    const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    if (requestUrl && requestToken) {
      if (authProvider === 'aws') {
        const roleArn = env.AWF_AUTH_AWS_ROLE_ARN;
        const region = env.AWF_AUTH_AWS_REGION;
        if (roleArn && region) {
          const { AwsOidcTokenProvider } = require('../aws-oidc-token-provider');
          awsOidcProvider = new AwsOidcTokenProvider({
            requestUrl,
            requestToken,
            roleArn,
            region,
            roleSessionName: env.AWF_AUTH_AWS_ROLE_SESSION_NAME,
            oidcAudience: env.AWF_AUTH_OIDC_AUDIENCE,
          });
        }
      } else if (authProvider === 'gcp') {
        const workloadIdentityProvider = env.AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER;
        if (workloadIdentityProvider) {
          const { GcpOidcTokenProvider } = require('../gcp-oidc-token-provider');
          oidcProvider = new GcpOidcTokenProvider({
            requestUrl,
            requestToken,
            workloadIdentityProvider,
            serviceAccount: env.AWF_AUTH_GCP_SERVICE_ACCOUNT,
            oidcAudience: env.AWF_AUTH_OIDC_AUDIENCE,
            scope: env.AWF_AUTH_GCP_SCOPE,
          });
        }
      } else {
        // Azure (default)
        const tenantId = env.AWF_AUTH_AZURE_TENANT_ID;
        const clientId = env.AWF_AUTH_AZURE_CLIENT_ID;
        if (tenantId && clientId) {
          oidcProvider = new OidcTokenProvider({
            requestUrl,
            requestToken,
            tenantId,
            clientId,
            oidcAudience: env.AWF_AUTH_OIDC_AUDIENCE || 'api://AzureADTokenExchange',
            azureScope: env.AWF_AUTH_AZURE_SCOPE || 'https://cognitiveservices.azure.com/.default',
            azureCloud: env.AWF_AUTH_AZURE_CLOUD,
          });
        }
      }
    }
  }

  return {
    authProvider,
    oidcProvider,
    awsOidcProvider,
    oidcConfigured: !!(oidcProvider || awsOidcProvider),
  };
}

module.exports = {
  resolveCloudOidcProviders,
};
