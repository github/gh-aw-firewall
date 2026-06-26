import { SQUID_PORT } from '../constants';
import { stripScheme } from '../host-env';
import { WrapperConfig } from '../types';
import { getConfigEnvValue, getLowerCaseProcessEnvValue, pickEnvVars } from '../env-utils';
import { OPENAI_ENV, ANTHROPIC_ENV, GEMINI_ENV, COPILOT_ENV } from '../api-proxy-env-constants';
import { NetworkConfig } from './squid-service';

/**
 * Builds provider API target/basePath environment variables for the api-proxy container.
 * Centralizes the repetitive per-provider target/basePath conditional env generation.
 */
export function buildProviderTargetEnv(config: WrapperConfig): Record<string, string> {
  const copilotProviderType = config.copilotProviderType || getConfigEnvValue(config, COPILOT_ENV.PROVIDER_TYPE);
  const copilotProviderBaseUrl = config.copilotProviderBaseUrl || getConfigEnvValue(config, COPILOT_ENV.PROVIDER_BASE_URL);
  const copilotProviderApiKey = config.copilotProviderApiKey;

  const env: Record<string, string> = {};

  const providers: Array<{ target?: string; basePath?: string; envTarget: string; envBasePath: string; stripTarget?: boolean }> = [
    { target: config.copilotApiTarget, basePath: config.copilotApiBasePath, envTarget: COPILOT_ENV.API_TARGET, envBasePath: COPILOT_ENV.API_BASE_PATH, stripTarget: true },
    { target: config.openaiApiTarget, basePath: config.openaiApiBasePath, envTarget: OPENAI_ENV.TARGET, envBasePath: OPENAI_ENV.BASE_PATH, stripTarget: true },
    { target: config.anthropicApiTarget, basePath: config.anthropicApiBasePath, envTarget: ANTHROPIC_ENV.TARGET, envBasePath: ANTHROPIC_ENV.BASE_PATH, stripTarget: true },
    { target: config.geminiApiTarget, basePath: config.geminiApiBasePath, envTarget: GEMINI_ENV.TARGET, envBasePath: GEMINI_ENV.BASE_PATH, stripTarget: true },
  ];

  for (const { target, basePath, envTarget, envBasePath, stripTarget } of providers) {
    if (target) env[envTarget] = stripTarget ? stripScheme(target) : target;
    if (basePath) env[envBasePath] = basePath;
  }

  // Copilot-specific provider passthrough
  if (copilotProviderType) env[COPILOT_ENV.PROVIDER_TYPE] = copilotProviderType;
  if (copilotProviderBaseUrl) env[COPILOT_ENV.PROVIDER_BASE_URL] = copilotProviderBaseUrl;
  if (copilotProviderApiKey) env[COPILOT_ENV.PROVIDER_API_KEY] = copilotProviderApiKey;

  // Pre-startup model validation (non-sensitive config value).
  // Prefer explicit requestedModel, but fall back to COPILOT_MODEL when present so
  // api-proxy can validate user-facing model aliases (apiProxy.models) at startup.
  const requestedModel = (config.requestedModel || getConfigEnvValue(config, 'COPILOT_MODEL') || '').trim();
  if (requestedModel) env.AWF_REQUESTED_MODEL = requestedModel;
  if (config.copilotByokExtraHeaders !== undefined) {
    env.AWF_BYOK_EXTRA_HEADERS = JSON.stringify(config.copilotByokExtraHeaders);
  }
  if (config.copilotByokExtraBodyFields !== undefined) {
    env.AWF_BYOK_EXTRA_BODY_FIELDS = JSON.stringify(config.copilotByokExtraBodyFields);
  }
  const providerSessionId = resolveProviderSessionId(config);
  if (providerSessionId) {
    env.AWF_PROVIDER_SESSION_ID = providerSessionId;
  }

  return env;
}

export function resolveProviderSessionId(config: WrapperConfig): string | undefined {
  // Auto-derivation from GITHUB_RUN_ID was removed because the Copilot
  // `session_id`/`x-session-id` convention causes strict OpenAI-compatible
  // BYOK targets (e.g. Azure OpenAI) to reject every request with HTTP 400.
  // Callers must opt in explicitly via the awf config (`apiProxy.targets.
  // copilot.sessionId`) or by setting AWF_PROVIDER_SESSION_ID in env.
  const value = config.copilotByokSessionId
    ?? getConfigEnvValue(config, 'AWF_PROVIDER_SESSION_ID')
    ?? process.env.AWF_PROVIDER_SESSION_ID;
  const normalizedValue = value?.trim();
  return normalizedValue || undefined;
}

export function buildApiProxyBaseEnv(config: WrapperConfig, networkConfig: NetworkConfig): Record<string, string> {
  const normalizedAuthType = (config.authType?.toLowerCase().trim()) || getLowerCaseProcessEnvValue('AWF_AUTH_TYPE') || '';

  return {
    // Pass API keys securely to sidecar (not visible to agent)
    ...(config.openaiApiKey && { [OPENAI_ENV.KEY]: config.openaiApiKey }),
    ...(config.anthropicApiKey && { [ANTHROPIC_ENV.KEY]: config.anthropicApiKey }),
    ...(config.copilotGithubToken && { [COPILOT_ENV.GITHUB_TOKEN]: config.copilotGithubToken }),
    ...(config.geminiApiKey && { [GEMINI_ENV.KEY]: config.geminiApiKey }),
    // Configurable API targets (for GHES/GHEC / custom endpoints)
    // Strip any scheme prefix — server.js also normalizes defensively, but
    // stripping here prevents a scheme-prefixed hostname from reaching the
    // container at all (belt-and-suspenders for gh-aw#25137).
    ...buildProviderTargetEnv(config),
    // Forward GITHUB_SERVER_URL so api-proxy can auto-derive enterprise endpoints
    ...(process.env.GITHUB_SERVER_URL && { GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL }),
    // Forward explicit platform type so api-proxy can apply correct auth behavior
    ...(config.platformType && { AWF_PLATFORM_TYPE: config.platformType }),
    // Forward GITHUB_API_URL so api-proxy can route /models to the correct GitHub REST API
    // target on GHES/GHEC (e.g. api.mycompany.ghe.com instead of api.github.com)
    ...(process.env.GITHUB_API_URL && { GITHUB_API_URL: process.env.GITHUB_API_URL }),
    // Forward COPILOT_INTEGRATION_ID if explicitly set (via --env, --env-file, or host env with --env-all)
    // so callers can identify themselves to the Copilot API with their own integration ID
    // instead of being attributed to AWF's default 'agentic-workflows'.
    // Whitespace-only values are treated as unset to avoid accidentally
    // shipping a meaningless integration ID.
    ...(getConfigEnvValue(config, 'COPILOT_INTEGRATION_ID')?.trim() && {
      COPILOT_INTEGRATION_ID: getConfigEnvValue(config, 'COPILOT_INTEGRATION_ID')!.trim(),
    }),
    // Do not forward GITHUB_COPILOT_INTEGRATION_ID — api-proxy defaults to
    // 'agentic-workflows' which is the correct integration ID for AWF.
    // Note: AWF_VERSION is intentionally NOT forwarded here. It is baked into the api-proxy
    // container image at release build time (via --build-arg AWF_VERSION=...), so the
    // token-usage.jsonl _schema field reflects the api-proxy image version rather than
    // the CLI version. This ensures correct versioning when --image-tag pins the proxy
    // to a different release.
    // Route through Squid to respect domain whitelisting
    HTTP_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    HTTPS_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    https_proxy: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    // Prevent curl health check from routing localhost through Squid
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    // OpenTelemetry distributed tracing — forward endpoint, headers, service name, and
    // parent trace context so api-proxy spans are children of the workflow trace.
    // GH_AW_OTLP_ENDPOINTS (JSON array) enables fan-out to multiple collectors.
    // OTEL_EXPORTER_OTLP_ENDPOINT is kept for backward compat (single-endpoint fallback).
    // When neither is set, spans are written to /var/log/api-proxy/otel.jsonl.
    ...pickEnvVars(
      'GH_AW_OTLP_ENDPOINTS',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'GITHUB_AW_OTEL_TRACE_ID',
      'GITHUB_AW_OTEL_PARENT_SPAN_ID',
    ),
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || 'awf-api-proxy',
    // Rate limiting configuration
    ...(config.rateLimitConfig && {
      AWF_RATE_LIMIT_ENABLED: String(config.rateLimitConfig.enabled),
      AWF_RATE_LIMIT_RPM: String(config.rateLimitConfig.rpm),
      AWF_RATE_LIMIT_RPH: String(config.rateLimitConfig.rph),
      AWF_RATE_LIMIT_BYTES_PM: String(config.rateLimitConfig.bytesPm),
    }),
    ...(config.maxEffectiveTokens !== undefined && {
      AWF_MAX_EFFECTIVE_TOKENS: String(config.maxEffectiveTokens),
    }),
    ...(config.maxAiCredits !== undefined && {
      AWF_MAX_AI_CREDITS: String(config.maxAiCredits),
    }),
    ...(config.defaultAiCreditsPricing && {
      AWF_DEFAULT_AI_CREDITS_PRICING: JSON.stringify(config.defaultAiCreditsPricing),
    }),
    ...(config.effectiveTokenModelMultipliers && {
      AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS: JSON.stringify(config.effectiveTokenModelMultipliers),
    }),
    ...(config.effectiveTokenDefaultModelMultiplier !== undefined && {
      AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER: String(config.effectiveTokenDefaultModelMultiplier),
    }),
    ...(config.maxModelMultiplierCap !== undefined && {
      AWF_MAX_MODEL_MULTIPLIER: String(config.maxModelMultiplierCap),
    }),
    ...(config.maxRuns !== undefined && {
      AWF_MAX_RUNS: String(config.maxRuns),
    }),
    ...(config.maxPermissionDenied !== undefined && {
      AWF_MAX_PERMISSION_DENIED: String(config.maxPermissionDenied),
    }),
    ...(config.maxCacheMisses !== undefined && {
      AWF_MAX_CACHE_MISSES: String(config.maxCacheMisses),
    }),
    ...(config.agentTimeout !== undefined && {
      AWF_AGENT_TIMEOUT_MINUTES: String(config.agentTimeout),
    }),
    // Model alias configuration
    ...(config.modelAliases && {
      AWF_MODEL_ALIASES: JSON.stringify({ models: config.modelAliases }),
    }),
    ...(config.modelFallback && {
      AWF_MODEL_FALLBACK: JSON.stringify(config.modelFallback),
    }),
    // Model policy (allowed/disallowed)
    ...(config.allowedModels && config.allowedModels.length > 0 && {
      AWF_ALLOWED_MODELS: JSON.stringify(config.allowedModels),
    }),
    ...(config.disallowedModels && config.disallowedModels.length > 0 && {
      AWF_DISALLOWED_MODELS: JSON.stringify(config.disallowedModels),
    }),
    // Anthropic prompt-cache optimizations
    ...(config.anthropicAutoCache && {
      AWF_ANTHROPIC_AUTO_CACHE: '1',
      ...(config.anthropicCacheTailTtl && { AWF_ANTHROPIC_CACHE_TAIL_TTL: config.anthropicCacheTailTtl }),
    }),
    // Enable token steering when explicitly requested
    ...(config.enableTokenSteering && { AWF_ENABLE_TOKEN_STEERING: 'true' }),
    // Token and model-alias diagnostic logging
    ...(config.debugTokens && { AWF_DEBUG_TOKENS: '1' }),
    ...(config.tokenLogDir && { AWF_TOKEN_LOG_DIR: config.tokenLogDir }),
    // Blocked-request diagnostics
    ...(config.captureBlockedRequests !== undefined &&
      config.captureBlockedRequests !== false && {
        AWF_CAPTURE_BLOCKED_LLM_REQUESTS: String(config.captureBlockedRequests),
      }),
    ...(config.maxCapturedBytes !== undefined && {
      AWF_MAX_BLOCKED_CAPTURE_BYTES: String(config.maxCapturedBytes),
    }),
    // OIDC authentication (Azure, AWS, GCP, Anthropic)
    ...pickEnvVars(
      'AWF_AUTH_TYPE',
      'AWF_AUTH_PROVIDER',
      'AWF_AUTH_OIDC_AUDIENCE',
      // Azure
      'AWF_AUTH_AZURE_TENANT_ID',
      'AWF_AUTH_AZURE_CLIENT_ID',
      'AWF_AUTH_AZURE_SCOPE',
      'AWF_AUTH_AZURE_CLOUD',
      // AWS
      'AWF_AUTH_AWS_ROLE_ARN',
      'AWF_AUTH_AWS_REGION',
      'AWF_AUTH_AWS_ROLE_SESSION_NAME',
      // GCP
      'AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER',
      'AWF_AUTH_GCP_SERVICE_ACCOUNT',
      'AWF_AUTH_GCP_SCOPE',
      // Anthropic
      'AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID',
      'AWF_AUTH_ANTHROPIC_ORGANIZATION_ID',
      'AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID',
      'AWF_AUTH_ANTHROPIC_WORKSPACE_ID',
      'AWF_AUTH_ANTHROPIC_TOKEN_URL',
    ),
    // GitHub Actions OIDC runtime tokens (needed by OIDC token provider in api-proxy)
    ...(normalizedAuthType === 'github-oidc' && pickEnvVars(
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    )),
    // Anthropic request optimisations (all opt-in via env vars on the host)
    ...pickEnvVars(
      'AWF_ANTHROPIC_AUTO_CACHE',
      'AWF_ANTHROPIC_CACHE_TAIL_TTL',
      'AWF_ANTHROPIC_DROP_TOOLS',
      'AWF_ANTHROPIC_STRIP_ANSI',
    ),
    // Custom auth header names for internal AI gateways
    ...(config.openaiApiAuthHeader && { [OPENAI_ENV.AUTH_HEADER]: config.openaiApiAuthHeader }),
    ...(config.anthropicApiAuthHeader && { [ANTHROPIC_ENV.AUTH_HEADER]: config.anthropicApiAuthHeader }),
    ...(config.anthropicTokenUrl && { AWF_AUTH_ANTHROPIC_TOKEN_URL: config.anthropicTokenUrl }),
    // OIDC auth config-file values override host env vars (config-file > env fallback precedence)
    ...(config.authType && { AWF_AUTH_TYPE: config.authType }),
    ...(config.authProvider && { AWF_AUTH_PROVIDER: config.authProvider }),
    ...(config.authOidcAudience && { AWF_AUTH_OIDC_AUDIENCE: config.authOidcAudience }),
    ...(config.authAzureTenantId && { AWF_AUTH_AZURE_TENANT_ID: config.authAzureTenantId }),
    ...(config.authAzureClientId && { AWF_AUTH_AZURE_CLIENT_ID: config.authAzureClientId }),
    ...(config.authAzureScope && { AWF_AUTH_AZURE_SCOPE: config.authAzureScope }),
    ...(config.authAzureCloud && { AWF_AUTH_AZURE_CLOUD: config.authAzureCloud }),
    ...(config.authAwsRoleArn && { AWF_AUTH_AWS_ROLE_ARN: config.authAwsRoleArn }),
    ...(config.authAwsRegion && { AWF_AUTH_AWS_REGION: config.authAwsRegion }),
    ...(config.authAwsRoleSessionName && { AWF_AUTH_AWS_ROLE_SESSION_NAME: config.authAwsRoleSessionName }),
    ...(config.authGcpWorkloadIdentityProvider && { AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER: config.authGcpWorkloadIdentityProvider }),
    ...(config.authGcpServiceAccount && { AWF_AUTH_GCP_SERVICE_ACCOUNT: config.authGcpServiceAccount }),
    ...(config.authGcpScope && { AWF_AUTH_GCP_SCOPE: config.authGcpScope }),
    ...(config.authAnthropicFederationRuleId && { AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: config.authAnthropicFederationRuleId }),
    ...(config.authAnthropicOrganizationId && { AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: config.authAnthropicOrganizationId }),
    ...(config.authAnthropicServiceAccountId && { AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: config.authAnthropicServiceAccountId }),
    ...(config.authAnthropicWorkspaceId && { AWF_AUTH_ANTHROPIC_WORKSPACE_ID: config.authAnthropicWorkspaceId }),
    // NOTE: AWF_ANTHROPIC_TRANSFORM_FILE is intentionally NOT forwarded from the host.
    // The api-proxy container holds live API credentials; loading arbitrary host-side JS
    // files into it would create an arbitrary-code-execution risk.  If you need a custom
    // transform, bake your hook.js into a custom container image and set the env var
    // directly in that image's Dockerfile / entrypoint — do NOT forward from the host.
  };
}
