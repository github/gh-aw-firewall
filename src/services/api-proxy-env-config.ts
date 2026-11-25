import { SQUID_PORT } from '../constants';
import { isIP } from 'net';
import { WrapperConfig } from '../types';
import { getConfigEnvValue, getLowerCaseProcessEnvValue, pickEnvVars } from '../env-utils';
import { OPENAI_ENV, ANTHROPIC_ENV, GEMINI_ENV, COPILOT_ENV, VERTEX_ENV, FOUNDRY_ENV, OIDC_AUTH_ENV_VARS, OIDC_AUTH_ENV_MAPPING } from '../api-proxy-env-constants';
import { NetworkConfig } from './squid-service';
import { buildNoProxyEnv } from './no-proxy-utils';
import { normalizeClaudeHostedWebPolicy } from '../claude-hosted-web-policy';
import { normalizeCodexHostedWebPolicy } from '../codex-hosted-web-policy';
import { resolveCopilotBrokerRuntime } from '../copilot-token-broker';
import { resolveDatabricksOidcHost, validateApiAuthScheme } from '../api-proxy-config-validation';
import { readEnvFile } from '../github-env';
import { buildProviderTargetEnv, resolveOpenAiEndpointOverride } from './api-proxy-target-env';

export { buildProviderTargetEnv } from './api-proxy-target-env';

const DEFAULT_API_PROXY_SHUTDOWN_TIMEOUT_MS = 8000;
export const API_PROXY_UPSTREAM_CA_CERT_CONTAINER_PATH = '/usr/local/share/ca-certificates/awf-upstream-ca.crt';
export const MODEL_ROUTING_NOT_STAGED_MESSAGE = 'Model routing was configured but the routing conversation was not staged';

/** Uses the same effective routing values passed to the trusted sidecar. */
export function resolveApiProxyUpstreams(config: WrapperConfig): Array<{ hostname: string; port: number; proxyOnly?: boolean }> {
  const env = buildProviderTargetEnv(config);
  const upstreams: Array<{ hostname: string; port: number; proxyOnly?: boolean }> = [];
  for (const key of [COPILOT_ENV.API_TARGET, OPENAI_ENV.TARGET, ANTHROPIC_ENV.TARGET, GEMINI_ENV.TARGET, VERTEX_ENV.TARGET, FOUNDRY_ENV.TARGET]) {
    const target = env[key];
    if (!target) continue;
    let parsed: URL;
    try {
      parsed = new URL(target.includes('://') ? target : `https://${target}`);
    } catch {
      throw new Error('Invalid API proxy upstream target');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Invalid API proxy upstream target');
    }
    // Raw-IP targets never receive a custom-port exception.
    if (isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) continue;
    const port = Number(parsed.port || (parsed.protocol === 'http:' ? 80 : 443));
    const proxyOnly = (key === OPENAI_ENV.TARGET && !!config.openaiTrustedService) ||
      (key === ANTHROPIC_ENV.TARGET && !!config.anthropicTrustedService);
    const existing = upstreams.find(endpoint => endpoint.hostname === parsed.hostname && endpoint.port === port);
    if (existing) {
      if (proxyOnly) existing.proxyOnly = true;
    } else {
      upstreams.push({ hostname: parsed.hostname, port, ...(proxyOnly ? { proxyOnly: true } : {}) });
    }
  }
  return upstreams;
}

export function resolveApiProxyShutdownTimeoutMs(config: WrapperConfig): number {
  const rawValue = getConfigEnvValue(config, 'AWF_API_PROXY_SHUTDOWN_TIMEOUT_MS')
    ?? process.env.AWF_API_PROXY_SHUTDOWN_TIMEOUT_MS;
  const parsedValue = Number.parseInt(rawValue || '', 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_API_PROXY_SHUTDOWN_TIMEOUT_MS;
  }
  return parsedValue;
}

/**
 * Builds API credential environment variables for the api-proxy sidecar.
 * These keys are passed securely to the sidecar and are NOT visible to the agent container.
 */
function buildCredentialEnv(config: WrapperConfig): Record<string, string> {
  const foundryApiKey = getConfigEnvValue(config, FOUNDRY_ENV.KEY) ?? process.env[FOUNDRY_ENV.KEY]?.trim();
  return {
    ...(config.openaiApiKey && { [OPENAI_ENV.KEY]: config.openaiApiKey }),
    ...(config.anthropicApiKey && { [ANTHROPIC_ENV.KEY]: config.anthropicApiKey }),
    ...(config.copilotGithubToken && { [COPILOT_ENV.GITHUB_TOKEN]: config.copilotGithubToken }),
    ...(config.geminiApiKey && { [GEMINI_ENV.KEY]: config.geminiApiKey }),
    ...(config.googleApiKey && { [VERTEX_ENV.KEY]: config.googleApiKey }),
    ...(foundryApiKey && { [FOUNDRY_ENV.KEY]: foundryApiKey }),
  };
}

/**
 * Builds provider routing environment variables: API targets, GitHub enterprise URLs,
 * platform type, and integration identity.
 */
function buildProviderRoutingEnv(config: WrapperConfig): Record<string, string> {
  const openAiEndpointOverride = resolveOpenAiEndpointOverride(config);

  return {
    // Configurable API targets (for GHES/GHEC / custom endpoints).
    // An explicit https:// scheme (or no scheme) is stripped to an authority,
    // matching prior behavior; an explicit http:// scheme is preserved so the
    // sidecar dials the target in cleartext. Non-default ports are preserved.
    // server.js's
    // normalizeApiTarget() re-validates and normalizes this defensively
    // (gh-aw#25137), so any other scheme or malformed value is rejected there.
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
    ...(openAiEndpointOverride && { OPENAI_ENDPOINT_OVERRIDE: openAiEndpointOverride }),
    // Forward the GitHub Actions run identity so the sidecar can derive a stable
    // per-run `X-Interaction-Id` for Copilot API requests. CAPI keys its prompt
    // cache off that header, so it must be identical across every request of a
    // run and differ between runs/attempts.
    ...(process.env.GITHUB_RUN_ID?.trim() && { GITHUB_RUN_ID: process.env.GITHUB_RUN_ID.trim() }),
    ...(process.env.GITHUB_RUN_ATTEMPT?.trim() && { GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT.trim() }),
    ...(process.env.GITHUB_REPOSITORY?.trim() && { GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY.trim() }),
    ...(process.env.GITHUB_WORKFLOW_REF?.trim() && { GITHUB_WORKFLOW_REF: process.env.GITHUB_WORKFLOW_REF.trim() }),
    ...(getConfigEnvValue(config, 'GITHUB_COPILOT_INTEGRATION_ID') && {
      GITHUB_COPILOT_INTEGRATION_ID: getConfigEnvValue(config, 'GITHUB_COPILOT_INTEGRATION_ID')!,
    }),
    // Note: AWF_VERSION is intentionally NOT forwarded here. It is baked into the api-proxy
    // container image at release build time (via --build-arg AWF_VERSION=...), so the
    // token-usage.jsonl _schema field reflects the api-proxy image version rather than
    // the CLI version. This ensures correct versioning when --image-tag pins the proxy
    // to a different release.
    AWF_API_PROXY_SHUTDOWN_TIMEOUT_MS: String(resolveApiProxyShutdownTimeoutMs(config)),
  };
}

/**
 * Builds Squid proxy routing environment variables (HTTP_PROXY, HTTPS_PROXY, NO_PROXY).
 * Routes all api-proxy outbound traffic through Squid to enforce domain whitelisting.
 */
function buildProxyRoutingEnv(networkConfig: NetworkConfig): Record<string, string> {
  return {
    // Route through Squid to respect domain whitelisting
    HTTP_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    HTTPS_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    https_proxy: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    // Prevent curl health check from routing localhost through Squid
    ...buildNoProxyEnv(),
  };
}

/**
 * Builds OpenTelemetry distributed tracing environment variables.
 * Forwards OTLP endpoint, headers, service name, and parent trace context so
 * api-proxy spans are children of the workflow trace.
 */
function buildOtelEnv(): Record<string, string> {
  const workloadIdentityConfigured = Boolean(process.env.GH_AW_OTLP_WORKLOAD_IDENTITY?.trim());
  return {
    // GH_AW_OTLP_ENDPOINTS (JSON array) enables fan-out to multiple collectors.
    // OTEL_EXPORTER_OTLP_ENDPOINT is kept for backward compat (single-endpoint fallback).
    // When neither is set, spans are written to /var/log/api-proxy/otel.jsonl.
    ...pickEnvVars(
      'GH_AW_OTLP_ENDPOINTS',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'GITHUB_AW_OTEL_TRACE_ID',
      'GITHUB_AW_OTEL_PARENT_SPAN_ID',
      'GH_AW_OTLP_WORKLOAD_IDENTITY',
    ),
    ...(workloadIdentityConfigured && pickEnvVars(
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    )),
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || 'awf-api-proxy',
  };
}

/**
 * Builds rate limiting and token guard environment variables.
 * Controls request rates, AI-credit budgets, run limits, and agent timeout.
 */
function buildRateLimitEnv(config: WrapperConfig): Record<string, string> {
  return {
    ...pickEnvVars('AWF_AI_CREDITS_HARD_CAP'),
    // Rate limiting configuration
    ...(config.rateLimitConfig && {
      AWF_RATE_LIMIT_ENABLED: String(config.rateLimitConfig.enabled),
      AWF_RATE_LIMIT_RPM: String(config.rateLimitConfig.rpm),
      AWF_RATE_LIMIT_RPH: String(config.rateLimitConfig.rph),
      AWF_RATE_LIMIT_BYTES_PM: String(config.rateLimitConfig.bytesPm),
    }),
    ...(config.maxAiCredits !== undefined && config.maxAiCredits !== -1 && config.maxAiCredits !== 0 && {
      AWF_MAX_AI_CREDITS: String(config.maxAiCredits),
    }),
    ...(config.defaultAiCreditsPricing && {
      AWF_DEFAULT_AI_CREDITS_PRICING: JSON.stringify(config.defaultAiCreditsPricing),
    }),
    ...(config.apiProxyProviders && {
      AWF_API_PROXY_PROVIDERS: JSON.stringify(config.apiProxyProviders),
    }),
    ...(config.modelPricingCatalog && {
      AWF_MODEL_PRICING_CATALOG: JSON.stringify(config.modelPricingCatalog),
    }),
    ...(config.modelCatalogue && {
      AWF_MODEL_CATALOGUE: JSON.stringify(config.modelCatalogue),
    }),
    ...(config.modelMultipliers && {
      AWF_MODEL_MULTIPLIERS: JSON.stringify(config.modelMultipliers),
      AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS: JSON.stringify(config.modelMultipliers),
    }),
    ...(config.defaultModelMultiplier !== undefined && {
      AWF_DEFAULT_MODEL_MULTIPLIER: String(config.defaultModelMultiplier),
      AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER: String(config.defaultModelMultiplier),
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
      AWF_AGENT_RUNTIME_START_FILE: '/var/log/api-proxy/agent-runtime/started-at-ms',
    }),
  };
}

/**
 * Builds model policy environment variables: aliases, allowed/disallowed models,
 * Anthropic prompt-cache optimizations, token steering, and diagnostic logging.
 */
function buildModelPolicyEnv(config: WrapperConfig): Record<string, string> {
  // Normalization throws on an invalid policy, which aborts the run before any
  // container starts rather than surfacing on the first Anthropic request.
  const claudeHostedWebPolicy = normalizeClaudeHostedWebPolicy(config.claudeHostedWeb);
  const codexHostedWebPolicy = normalizeCodexHostedWebPolicy(config.codexHostedWeb);

  return {
    // Model alias configuration
    ...(config.modelAliases && {
      AWF_MODEL_ALIASES: JSON.stringify({ models: config.modelAliases }),
    }),
    ...(config.modelFallback && {
      AWF_MODEL_FALLBACK: JSON.stringify(config.modelFallback),
    }),
    ...(config.fallbackModels && config.fallbackModels.length > 0 && {
      AWF_FALLBACK_MODELS: JSON.stringify(config.fallbackModels),
    }),
    // Model policy (allowed/disallowed)
    ...(config.allowedModels !== undefined && {
      AWF_ALLOWED_MODELS: JSON.stringify(config.allowedModels),
    }),
    ...(config.disallowedModels && config.disallowedModels.length > 0 && {
      AWF_DISALLOWED_MODELS: JSON.stringify(config.disallowedModels),
    }),
    // Claude hosted web search/fetch policy (validated on the host; the sidecar
    // re-parses it at startup and fails closed if it is not a valid policy).
    ...(claudeHostedWebPolicy && {
      AWF_CLAUDE_HOSTED_WEB_POLICY: JSON.stringify(claudeHostedWebPolicy),
    }),
    ...(codexHostedWebPolicy && {
      AWF_CODEX_HOSTED_WEB_POLICY: JSON.stringify(codexHostedWebPolicy),
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
  };
}

function buildModelRoutingEnv(config: WrapperConfig): Record<string, string> {
  if (config.experimentalModelRouting !== true || !config.modelRouting) return {};
  if (!config.modelRoutingBootstrap) {
    throw new Error(MODEL_ROUTING_NOT_STAGED_MESSAGE);
  }
  // The proxy reads private staged copies, never the host paths the configuration names.
  const { adaptiveSummaryFile, ...routing } = config.modelRouting;
  const stagedSummary = config.modelRoutingBootstrap.containerAdaptiveInputFile;
  if (adaptiveSummaryFile !== undefined && stagedSummary === undefined) {
    throw new Error(MODEL_ROUTING_NOT_STAGED_MESSAGE);
  }
  return {
    AWF_ROUTING_CONFIG: JSON.stringify({
      ...routing,
      task: {
        conversationFile: config.modelRoutingBootstrap.containerInputFile,
      },
      ...(adaptiveSummaryFile === undefined ? {} : { adaptiveSummaryFile: stagedSummary }),
    }),
  };
}

/**
 * Builds OIDC authentication environment variables: Azure/AWS/GCP/Anthropic OIDC provider vars,
 * GitHub Actions OIDC runtime tokens, and custom auth headers for internal AI gateways.
 */
function buildOidcEnv(config: WrapperConfig): Record<string, string> {
  const normalizedAuthType = (config.authType?.toLowerCase().trim())
    || (getConfigEnvValue(config, 'AWF_AUTH_TYPE')?.toLowerCase())
    || getLowerCaseProcessEnvValue('AWF_AUTH_TYPE')
    || '';
  resolveDatabricksOidcHost(config);
  const authSettings: Record<string, string> = {};
  for (const [provider, constants] of [['openai', OPENAI_ENV], ['anthropic', ANTHROPIC_ENV]] as const) {
    for (const [suffix, envVar] of [['AuthHeader', constants.AUTH_HEADER], ['AuthScheme', constants.AUTH_SCHEME]] as const) {
      const value = config[`${provider}Api${suffix}`]
        ?? config.additionalEnv?.[envVar]
        ?? (config.envFile ? readEnvFile(config.envFile)[envVar] : undefined)
        ?? process.env[envVar];
      if (suffix === 'AuthScheme') validateApiAuthScheme(value);
      if (value !== undefined) authSettings[envVar] = value;
    }
  }

  return {
    // OIDC authentication (Azure, AWS, GCP, Anthropic)
    ...pickEnvVars(...OIDC_AUTH_ENV_VARS, 'AWF_AUTH_ANTHROPIC_TOKEN_URL'),
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
    // OIDC auth values supplied via --env/--env-file (or --env-all) must reach the
    // sidecar too: agent-side routing helpers (e.g. isGcpOidcConfigured) resolve
    // these same values, so forwarding keeps routing and credentials consistent.
    ...Object.fromEntries(
      [...OIDC_AUTH_ENV_VARS, 'AWF_AUTH_ANTHROPIC_TOKEN_URL']
        .map((envVar) => [envVar, getConfigEnvValue(config, envVar)])
        .filter(([, value]) => !!value)
    ),
    // Custom auth header names for internal AI gateways
    ...authSettings,
    ...(config.anthropicTokenUrl && { AWF_AUTH_ANTHROPIC_TOKEN_URL: config.anthropicTokenUrl }),
    // OIDC auth config-file values override host env vars (config-file > env fallback precedence)
    ...Object.fromEntries(
      OIDC_AUTH_ENV_MAPPING
        .filter(({ configKey }) => {
          const value = (config as unknown as Record<string, unknown>)[configKey];
          return configKey === 'authDatabricksHost' || configKey === 'authDatabricksClientId'
            ? value !== undefined
            : !!value;
        })
        .map(({ configKey, envVar }) => [envVar, (config as unknown as Record<string, unknown>)[configKey] as string])
    ),
    // NOTE: AWF_ANTHROPIC_TRANSFORM_FILE is intentionally NOT forwarded from the host.
    // The api-proxy container holds live API credentials; loading arbitrary host-side JS
    // files into it would create an arbitrary-code-execution risk.  If you need a custom
    // transform, bake your hook.js into a custom container image and set the env var
    // directly in that image's Dockerfile / entrypoint — do NOT forward from the host.
  };
}

export function buildApiProxyBaseEnv(config: WrapperConfig, networkConfig: NetworkConfig): Record<string, string> {
  return {
    ...(config.apiProxyCaCert && { NODE_EXTRA_CA_CERTS: API_PROXY_UPSTREAM_CA_CERT_CONTAINER_PATH }),
    ...buildCredentialEnv(config),
    ...buildProviderRoutingEnv(config),
    ...buildProxyRoutingEnv(networkConfig),
    ...buildOtelEnv(),
    ...buildRateLimitEnv(config),
    ...buildModelPolicyEnv(config),
    ...buildModelRoutingEnv(config),
    ...buildOidcEnv(config),
    ...resolveCopilotBrokerRuntime(config)?.environment,
  };
}

// ts-prune-ignore-next
/** @internal Exported for unit testing only */
export const testHelpers = {
  buildCredentialEnv,
  buildProviderRoutingEnv,
  buildProxyRoutingEnv,
  buildOtelEnv,
  buildRateLimitEnv,
  buildModelPolicyEnv,
  buildModelRoutingEnv,
  buildOidcEnv,
  resolveApiProxyShutdownTimeoutMs,
};
