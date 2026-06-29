/**
 * Environment variable name constants for the API proxy provider adapters.
 *
 * This is the single source of truth for env var names on the TypeScript host side.
 * The CommonJS equivalent lives in containers/api-proxy/provider-env-constants.js.
 *
 * Both files must be kept in sync when adding or renaming env vars.
 */

/** Environment variable names for the OpenAI provider adapter. */
export const OPENAI_ENV = {
  KEY: 'OPENAI_API_KEY',
  TARGET: 'OPENAI_API_TARGET',
  BASE_PATH: 'OPENAI_API_BASE_PATH',
  AUTH_HEADER: 'AWF_OPENAI_AUTH_HEADER',
} as const;

/** Environment variable names for the Anthropic provider adapter. */
export const ANTHROPIC_ENV = {
  KEY: 'ANTHROPIC_API_KEY',
  TARGET: 'ANTHROPIC_API_TARGET',
  BASE_PATH: 'ANTHROPIC_API_BASE_PATH',
  AUTH_HEADER: 'AWF_ANTHROPIC_AUTH_HEADER',
} as const;

/** Environment variable names for the Gemini provider adapter. */
export const GEMINI_ENV = {
  KEY: 'GEMINI_API_KEY',
  TARGET: 'GEMINI_API_TARGET',
  BASE_PATH: 'GEMINI_API_BASE_PATH',
} as const;

/** Environment variable names for the Copilot provider adapter. */
export const COPILOT_ENV = {
  GITHUB_TOKEN: 'COPILOT_GITHUB_TOKEN',
  PROVIDER_API_KEY: 'COPILOT_PROVIDER_API_KEY',
  PROVIDER_TYPE: 'COPILOT_PROVIDER_TYPE',
  PROVIDER_BASE_URL: 'COPILOT_PROVIDER_BASE_URL',
  API_TARGET: 'COPILOT_API_TARGET',
  API_BASE_PATH: 'COPILOT_API_BASE_PATH',
} as const;

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
