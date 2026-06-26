/**
 * API proxy enablement, credentials, and auth customization options.
 */

export interface ApiProxyCredentialOptions {
  /**
   * Enable API proxy sidecar for holding authentication credentials
   *
   * When true, deploys a Node.js proxy sidecar container that:
   * - Holds OpenAI, Anthropic, GitHub Copilot, and Google Gemini API keys securely
   * - Automatically injects authentication headers
   * - Routes all traffic through Squid to respect domain whitelisting
   * - Proxies requests to LLM providers
   *
   * The sidecar exposes four endpoints accessible from the agent container:
   * - http://api-proxy:10000 - OpenAI API proxy (for Codex) {@link API_PROXY_PORTS.OPENAI}
   * - http://api-proxy:10001 - Anthropic API proxy (for Claude) {@link API_PROXY_PORTS.ANTHROPIC}
   * - http://api-proxy:10002 - GitHub Copilot API proxy {@link API_PROXY_PORTS.COPILOT}
   * - http://api-proxy:10003 - Google Gemini API proxy {@link API_PROXY_PORTS.GEMINI}
   *
   * When the corresponding API key is provided, the following environment
   * variables are set in the agent container:
   * - OPENAI_BASE_URL=http://api-proxy:10000 (set when OPENAI_API_KEY is provided)
   * - ANTHROPIC_BASE_URL=http://api-proxy:10001 (set when ANTHROPIC_API_KEY is provided, or when AWF_AUTH_TYPE=github-oidc and AWF_AUTH_PROVIDER=anthropic)
   * - COPILOT_API_URL=http://api-proxy:10002 (set when COPILOT_GITHUB_TOKEN is provided)
   * - CLAUDE_CODE_API_KEY_HELPER=/usr/local/bin/get-claude-key.sh (set when ANTHROPIC_API_KEY is provided, or when AWF_AUTH_TYPE=github-oidc and AWF_AUTH_PROVIDER=anthropic)
   *
   * API keys are passed via environment variables:
   * - OPENAI_API_KEY - Optional OpenAI API key for Codex
   * - ANTHROPIC_API_KEY - Optional Anthropic API key for Claude
   * - COPILOT_GITHUB_TOKEN - Optional GitHub token for Copilot
   * - COPILOT_PROVIDER_API_KEY - Optional upstream BYOK API key for Copilot-compatible providers
   * - GEMINI_API_KEY - Optional Google Gemini API key
   *
   * @default false
   * @example
   * ```bash
   * # Enable API proxy with keys from environment
   * export OPENAI_API_KEY="sk-..."
   * export ANTHROPIC_API_KEY="sk-ant-..."
   * export COPILOT_GITHUB_TOKEN="ghp_..."
   * awf --enable-api-proxy --allow-domains api.openai.com,api.anthropic.com,api.githubcopilot.com -- command
   * ```
   * @see API_PROXY_PORTS for port configuration
   */
  enableApiProxy?: boolean;

  /**
   * OpenAI API key for Codex (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to api.openai.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   *
   * @default undefined
   */
  openaiApiKey?: string;

  /**
   * Anthropic API key for Claude (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to api.anthropic.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   *
   * @default undefined
   */
  anthropicApiKey?: string;

  /**
   * GitHub token for Copilot (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this token is injected into the Node.js sidecar
   * container and used to authenticate requests to api.githubcopilot.com.
   *
   * The token is NOT exposed to the agent container - only the proxy URL is provided.
   * The agent receives a placeholder value that is protected by the one-shot-token library.
   *
   * @default undefined
   */
  copilotGithubToken?: string;

  /**
   * Upstream BYOK API key for Copilot-compatible providers (used by API proxy sidecar)
   *
   * When enableApiProxy is true and this key is provided, AWF routes Copilot CLI
   * through the sidecar in direct-BYOK mode (Azure Foundry, OpenRouter, etc.).
   * The real key is injected into the Node.js sidecar container and used to
   * authenticate requests to the user-supplied COPILOT_PROVIDER_BASE_URL.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   * The agent receives a placeholder value so Copilot CLI's startup auth check passes.
   *
   * Sourced from `process.env.COPILOT_PROVIDER_API_KEY` in build-config; matches the
   * pattern used by OPENAI_API_KEY, ANTHROPIC_API_KEY, COPILOT_GITHUB_TOKEN, and
   * GEMINI_API_KEY.
   *
   * @default undefined
   */
  copilotProviderApiKey?: string;

  /**
   * Google Gemini API key (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to generativelanguage.googleapis.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   * The agent receives a placeholder value so Gemini CLI's startup auth check passes.
   *
   * @default undefined
   */
  geminiApiKey?: string;

  /**
   * Custom auth header name for OpenAI API requests (used by API proxy sidecar)
   *
   * When set, the proxy uses this header name instead of the default
   * standard Authorization bearer-header format. The key is sent as the raw header
   * value without a "Bearer" prefix.
   *
   * Useful for internal AI gateways (e.g. Azure OpenAI) that require a
   * different header name such as `api-key`.
   *
   * Can be set via:
   * - CLI flag: `--openai-api-auth-header <name>`
   * - Environment variable: `AWF_OPENAI_AUTH_HEADER`
   *
   * @default undefined (uses a standard Authorization bearer header)
   * @example 'api-key'
   */
  openaiApiAuthHeader?: string;

  /**
   * Custom auth header name for Anthropic API requests (used by API proxy sidecar)
   *
   * When set, the proxy uses this header name instead of the default `x-api-key`.
   *
   * Useful for internal AI gateways that require a different header name.
   *
   * Can be set via:
   * - CLI flag: `--anthropic-api-auth-header <name>`
   * - Environment variable: `AWF_ANTHROPIC_AUTH_HEADER`
   *
   * @default 'x-api-key'
   * @example 'api-key'
   */
  anthropicApiAuthHeader?: string;

  /**
   * Anthropic OIDC token exchange endpoint override.
   *
   * When set, AWF passes this value to the API proxy as
   * `AWF_AUTH_ANTHROPIC_TOKEN_URL` for Anthropic WIF/OIDC exchange.
   *
   * Intended for non-sensitive endpoint customization and typically set via
   * config file (`apiProxy.auth.anthropicTokenUrl`).
   *
   * @default 'https://api.anthropic.com/v1/oauth/token'
   */
  anthropicTokenUrl?: string;

  /** Authentication type. Currently only `'github-oidc'` is supported. Maps to `AWF_AUTH_TYPE`. */
  authType?: string;

  /** Cloud provider for OIDC token exchange (`'azure'`, `'aws'`, `'gcp'`, `'anthropic'`). Maps to `AWF_AUTH_PROVIDER`. */
  authProvider?: string;

  /** Audience claim for the GitHub OIDC token. Maps to `AWF_AUTH_OIDC_AUDIENCE`. */
  authOidcAudience?: string;

  /** Azure AD tenant ID for federated credential exchange. Maps to `AWF_AUTH_AZURE_TENANT_ID`. */
  authAzureTenantId?: string;

  /** Azure AD application (client) ID for the federated credential. Maps to `AWF_AUTH_AZURE_CLIENT_ID`. */
  authAzureClientId?: string;

  /** Azure token scope. Maps to `AWF_AUTH_AZURE_SCOPE`. */
  authAzureScope?: string;

  /** Azure cloud environment (`'public'`, `'usgovernment'`, `'china'`). Maps to `AWF_AUTH_AZURE_CLOUD`. */
  authAzureCloud?: string;

  /** AWS IAM role ARN to assume via OIDC federation. Maps to `AWF_AUTH_AWS_ROLE_ARN`. */
  authAwsRoleArn?: string;

  /** AWS region for the Bedrock endpoint. Maps to `AWF_AUTH_AWS_REGION`. */
  authAwsRegion?: string;

  /** Session name for the AWS STS AssumeRoleWithWebIdentity call. Maps to `AWF_AUTH_AWS_ROLE_SESSION_NAME`. */
  authAwsRoleSessionName?: string;

  /** Full GCP Workload Identity Provider resource name. Maps to `AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER`. */
  authGcpWorkloadIdentityProvider?: string;

  /** GCP service account email to impersonate. Maps to `AWF_AUTH_GCP_SERVICE_ACCOUNT`. */
  authGcpServiceAccount?: string;

  /** OAuth2 scope for GCP token. Maps to `AWF_AUTH_GCP_SCOPE`. */
  authGcpScope?: string;

  /** Anthropic federation rule ID (e.g. `fdrl_...`). Maps to `AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID`. */
  authAnthropicFederationRuleId?: string;

  /** Anthropic organization UUID. Maps to `AWF_AUTH_ANTHROPIC_ORGANIZATION_ID`. */
  authAnthropicOrganizationId?: string;

  /** Anthropic service account ID (e.g. `svac_...`). Maps to `AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID`. */
  authAnthropicServiceAccountId?: string;

  /** Anthropic workspace ID. Maps to `AWF_AUTH_ANTHROPIC_WORKSPACE_ID`. */
  authAnthropicWorkspaceId?: string;
}
