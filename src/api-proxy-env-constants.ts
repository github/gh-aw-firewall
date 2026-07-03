/**
 * Environment variable name constants for the API proxy provider adapters.
 *
 * Single source of truth: containers/api-proxy/provider-env-constants.json
 * The CommonJS sidecar loads the same JSON via containers/api-proxy/provider-env-constants.js.
 */
import providerEnvConstants from '../containers/api-proxy/provider-env-constants.json';

/** Environment variable names for the OpenAI provider adapter. */
export const OPENAI_ENV = providerEnvConstants.OPENAI_ENV;
/** Environment variable names for the Anthropic provider adapter. */
export const ANTHROPIC_ENV = providerEnvConstants.ANTHROPIC_ENV;
/** Environment variable names for the Gemini provider adapter. */
export const GEMINI_ENV = providerEnvConstants.GEMINI_ENV;
/** Environment variable names for the Copilot provider adapter. */
export const COPILOT_ENV = providerEnvConstants.COPILOT_ENV;

/**
 * OIDC authentication env var mappings.
 * Each entry maps a WrapperConfig field name to its corresponding environment variable.
 * Used by both build-config.ts (env → config) and api-proxy-env-config.ts (config → env).
 */
const OIDC_AUTH_ENV_MAPPING = [
  { configKey: 'authType', envVar: 'AWF_AUTH_TYPE' },
  { configKey: 'authProvider', envVar: 'AWF_AUTH_PROVIDER' },
  { configKey: 'authOidcAudience', envVar: 'AWF_AUTH_OIDC_AUDIENCE' },
  // Azure
  { configKey: 'authAzureTenantId', envVar: 'AWF_AUTH_AZURE_TENANT_ID' },
  { configKey: 'authAzureClientId', envVar: 'AWF_AUTH_AZURE_CLIENT_ID' },
  { configKey: 'authAzureScope', envVar: 'AWF_AUTH_AZURE_SCOPE' },
  { configKey: 'authAzureCloud', envVar: 'AWF_AUTH_AZURE_CLOUD' },
  // AWS
  { configKey: 'authAwsRoleArn', envVar: 'AWF_AUTH_AWS_ROLE_ARN' },
  { configKey: 'authAwsRegion', envVar: 'AWF_AUTH_AWS_REGION' },
  { configKey: 'authAwsRoleSessionName', envVar: 'AWF_AUTH_AWS_ROLE_SESSION_NAME' },
  // GCP
  { configKey: 'authGcpWorkloadIdentityProvider', envVar: 'AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER' },
  { configKey: 'authGcpServiceAccount', envVar: 'AWF_AUTH_GCP_SERVICE_ACCOUNT' },
  { configKey: 'authGcpScope', envVar: 'AWF_AUTH_GCP_SCOPE' },
  // Anthropic
  { configKey: 'authAnthropicFederationRuleId', envVar: 'AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID' },
  { configKey: 'authAnthropicOrganizationId', envVar: 'AWF_AUTH_ANTHROPIC_ORGANIZATION_ID' },
  { configKey: 'authAnthropicServiceAccountId', envVar: 'AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID' },
  { configKey: 'authAnthropicWorkspaceId', envVar: 'AWF_AUTH_ANTHROPIC_WORKSPACE_ID' },
] as const satisfies ReadonlyArray<{
  configKey: Extract<keyof import('./types').WrapperConfig, string>;
  envVar: `AWF_AUTH_${string}`;
}>;
export { OIDC_AUTH_ENV_MAPPING };

/** Env var names for OIDC auth — use with pickEnvVars() to forward host env to sidecar */
export const OIDC_AUTH_ENV_VARS = OIDC_AUTH_ENV_MAPPING.map(m => m.envVar);
