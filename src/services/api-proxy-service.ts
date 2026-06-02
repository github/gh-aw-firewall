import * as path from 'path';
import {
  API_PROXY_CONTAINER_NAME,
  SQUID_PORT,
} from '../constants';
import { stripScheme } from '../host-env';
import { readEnvFile } from '../github-env';
import { buildRuntimeImageRef } from '../image-tag';
import { logger } from '../logger';
import { WrapperConfig, API_PROXY_PORTS, API_PROXY_HEALTH_PORT } from '../types';
import { pickEnvVars } from '../env-utils';
import { COPILOT_PLACEHOLDER_TOKEN } from '../constants/placeholders';
import { NetworkConfig, ImageBuildConfig } from './squid-service';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';

interface ApiProxyBuildResult {
  /** The api-proxy service definition to add to Docker Compose services. */
  service: any;
  /**
   * Additional environment variables to merge into the agent container's environment.
   * These set placeholder API keys and base URLs so the agent routes traffic through
   * the sidecar instead of calling upstream APIs directly.
   */
  agentEnvAdditions: Record<string, string>;
}

interface ApiProxyServiceParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  apiProxyLogsPath: string;
  imageConfig: ImageBuildConfig;
}

/**
 * Builds provider API target/basePath environment variables for the api-proxy container.
 * Centralizes the repetitive per-provider target/basePath conditional env generation.
 */
function buildProviderTargetEnv(config: WrapperConfig): Record<string, string> {
  const copilotProviderType = getConfigEnvValue(config, 'COPILOT_PROVIDER_TYPE');
  const copilotProviderBaseUrl = getConfigEnvValue(config, 'COPILOT_PROVIDER_BASE_URL');
  const copilotProviderApiKey = getConfigEnvValue(config, 'COPILOT_PROVIDER_API_KEY');

  const env: Record<string, string> = {};

  const providers: Array<{ target?: string; basePath?: string; envTarget: string; envBasePath: string; stripTarget?: boolean }> = [
    { target: config.copilotApiTarget, basePath: config.copilotApiBasePath, envTarget: 'COPILOT_API_TARGET', envBasePath: 'COPILOT_API_BASE_PATH', stripTarget: true },
    { target: config.openaiApiTarget, basePath: config.openaiApiBasePath, envTarget: 'OPENAI_API_TARGET', envBasePath: 'OPENAI_API_BASE_PATH', stripTarget: true },
    { target: config.anthropicApiTarget, basePath: config.anthropicApiBasePath, envTarget: 'ANTHROPIC_API_TARGET', envBasePath: 'ANTHROPIC_API_BASE_PATH', stripTarget: true },
    { target: config.geminiApiTarget, basePath: config.geminiApiBasePath, envTarget: 'GEMINI_API_TARGET', envBasePath: 'GEMINI_API_BASE_PATH', stripTarget: true },
  ];

  for (const { target, basePath, envTarget, envBasePath, stripTarget } of providers) {
    if (target) env[envTarget] = stripTarget ? stripScheme(target) : target;
    if (basePath) env[envBasePath] = basePath;
  }

  // Copilot-specific provider passthrough
  if (copilotProviderType) env.COPILOT_PROVIDER_TYPE = copilotProviderType;
  if (copilotProviderBaseUrl) env.COPILOT_PROVIDER_BASE_URL = copilotProviderBaseUrl;
  if (copilotProviderApiKey) env.COPILOT_PROVIDER_API_KEY = copilotProviderApiKey;

  // Pre-startup model validation (non-sensitive config value)
  if (config.requestedModel) env.AWF_REQUESTED_MODEL = config.requestedModel;

  return env;
}

// Match GPT-5 family model IDs with optional provider prefixes (e.g. "openai/gpt-5",
// "copilot/o3-mini"). Prefix is intentionally broad because model providers/prefixes
// are runtime-configurable and not limited to a fixed allowlist.
const RESPONSES_WIRE_API_MODEL_PATTERN = /(^|[/:])(gpt-5|o3)([-_.]|$)/i;
function getConfigEnvValue(config: WrapperConfig, key: string): string | undefined {
  const envFileValue = config.envFile
    ? readEnvFile(config.envFile)[key]
    : undefined;
  const value =
    config.additionalEnv?.[key] ??
    envFileValue ??
    (config.envAll ? process.env[key] : undefined);
  const normalizedValue = value?.trim();
  return normalizedValue || undefined;
}

function requiresResponsesWireApi(copilotModel: string): boolean {
  return RESPONSES_WIRE_API_MODEL_PATTERN.test(copilotModel);
}

/**
 * Builds the API proxy sidecar service configuration and associated agent environment
 * mutations required for credential isolation.
 */
export function buildApiProxyService(params: ApiProxyServiceParams): ApiProxyBuildResult {
  const { config, networkConfig, apiProxyLogsPath, imageConfig } = params;
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;
  const normalizedAuthType = (process.env.AWF_AUTH_TYPE || '').trim().toLowerCase();
  const normalizedAuthProvider = (process.env.AWF_AUTH_PROVIDER || '').trim().toLowerCase();
  const shouldProxyAnthropic = Boolean(config.anthropicApiKey || (normalizedAuthType === 'github-oidc' && normalizedAuthProvider === 'anthropic'));

  if (!networkConfig.proxyIp) {
    throw new Error('buildApiProxyService: networkConfig.proxyIp is required');
  }

  const proxyService: any = {
    container_name: API_PROXY_CONTAINER_NAME,
    networks: {
      'awf-net': {
        ipv4_address: networkConfig.proxyIp,
      },
    },
    volumes: applyHostPathPrefixToVolumes(
      [
        // Mount log directory for api-proxy logs
        `${apiProxyLogsPath}:/var/log/api-proxy:rw`,
      ],
      config.dockerHostPathPrefix,
    ),
    environment: {
      // Pass API keys securely to sidecar (not visible to agent)
      ...(config.openaiApiKey && { OPENAI_API_KEY: config.openaiApiKey }),
      ...(config.anthropicApiKey && { ANTHROPIC_API_KEY: config.anthropicApiKey }),
      ...(config.copilotGithubToken && { COPILOT_GITHUB_TOKEN: config.copilotGithubToken }),
      ...(config.copilotApiKey && { COPILOT_API_KEY: config.copilotApiKey }),
      ...(config.geminiApiKey && { GEMINI_API_KEY: config.geminiApiKey }),
      // Configurable API targets (for GHES/GHEC / custom endpoints)
      // Strip any scheme prefix — server.js also normalizes defensively, but
      // stripping here prevents a scheme-prefixed hostname from reaching the
      // container at all (belt-and-suspenders for gh-aw#25137).
      ...buildProviderTargetEnv(config),
      // Forward GITHUB_SERVER_URL so api-proxy can auto-derive enterprise endpoints
      ...(process.env.GITHUB_SERVER_URL && { GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL }),
      // Forward GITHUB_API_URL so api-proxy can route /models to the correct GitHub REST API
      // target on GHES/GHEC (e.g. api.mycompany.ghe.com instead of api.github.com)
      ...(process.env.GITHUB_API_URL && { GITHUB_API_URL: process.env.GITHUB_API_URL }),
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
      NO_PROXY: `localhost,127.0.0.1,::1`,
      no_proxy: `localhost,127.0.0.1,::1`,
      // OpenTelemetry distributed tracing — forward endpoint, headers, service name, and
      // parent trace context so api-proxy spans are children of the workflow trace.
      // OTEL_EXPORTER_OTLP_ENDPOINT activates OTLP/HTTP export (via Squid); when absent
      // spans are written to /var/log/api-proxy/otel.jsonl as a local file fallback.
      ...pickEnvVars(
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
      ...(config.openaiApiAuthHeader && { AWF_OPENAI_AUTH_HEADER: config.openaiApiAuthHeader }),
      ...(config.anthropicApiAuthHeader && { AWF_ANTHROPIC_AUTH_HEADER: config.anthropicApiAuthHeader }),
      ...(config.anthropicTokenUrl && { AWF_AUTH_ANTHROPIC_TOKEN_URL: config.anthropicTokenUrl }),
      // NOTE: AWF_ANTHROPIC_TRANSFORM_FILE is intentionally NOT forwarded from the host.
      // The api-proxy container holds live API credentials; loading arbitrary host-side JS
      // files into it would create an arbitrary-code-execution risk.  If you need a custom
      // transform, bake your hook.js into a custom container image and set the env var
      // directly in that image's Dockerfile / entrypoint — do NOT forward from the host.
    },
    healthcheck: {
      test: ['CMD', 'curl', '-f', `http://localhost:${API_PROXY_HEALTH_PORT}/health`],
      interval: '2s',
      timeout: '3s',
      retries: 15,
      start_period: '30s',
    },
    // Security hardening and resource limits to prevent DoS attacks
    ...buildContainerSecurityHardening({ memLimit: '512m', pidsLimit: 100, cpuShares: 512 }),
    stop_grace_period: '2s',
  };

  // Use GHCR image or build locally
  if (useGHCR) {
    proxyService.image = buildRuntimeImageRef(registry, 'api-proxy', parsedTag);
  } else {
    proxyService.build = {
      context: path.join(projectRoot, 'containers/api-proxy'),
      dockerfile: 'Dockerfile',
    };
  }

  // Build the agent environment additions for credential isolation
  const agentEnvAdditions: Record<string, string> = {
    // AWF_API_PROXY_IP is used by setup-iptables.sh to allow agent→api-proxy traffic
    // Use IP address instead of hostname for BASE_URLs since Docker DNS may not resolve
    // container names in chroot mode
    AWF_API_PROXY_IP: networkConfig.proxyIp,
  };

  if (config.openaiApiKey) {
    agentEnvAdditions.OPENAI_BASE_URL = `http://${networkConfig.proxyIp}:${API_PROXY_PORTS.OPENAI}`;
    logger.debug(`OpenAI API will be proxied through sidecar at http://${networkConfig.proxyIp}:${API_PROXY_PORTS.OPENAI}`);
    if (config.openaiApiTarget) {
      logger.debug(`OpenAI API target overridden to: ${config.openaiApiTarget}`);
    }
    if (config.openaiApiBasePath) {
      logger.debug(`OpenAI API base path set to: ${config.openaiApiBasePath}`);
    }

    // Inject placeholder API keys for OpenAI/Codex credential isolation.
    // Codex v0.121+ introduced a CODEX_API_KEY-based WebSocket auth flow: when no
    // API key is found in the agent env, Codex bypasses OPENAI_BASE_URL and connects
    // directly to api.openai.com for OAuth, getting a 401. With a placeholder key
    // present, Codex routes API calls through OPENAI_BASE_URL (the api-proxy sidecar),
    // which replaces the Authorization header with the real key before forwarding.
    // The real keys are held securely in the sidecar; when requests are routed
    // through api-proxy, these placeholders are expected to be overwritten by the
    // api-proxy's injectHeaders before forwarding upstream.
    agentEnvAdditions.OPENAI_API_KEY = 'sk-placeholder-for-api-proxy';
    agentEnvAdditions.CODEX_API_KEY = 'sk-placeholder-for-api-proxy';
    logger.debug('OPENAI_API_KEY and CODEX_API_KEY set to placeholder values for credential isolation');
  }
  if (shouldProxyAnthropic) {
    agentEnvAdditions.ANTHROPIC_BASE_URL = `http://${networkConfig.proxyIp}:${API_PROXY_PORTS.ANTHROPIC}`;
    logger.debug(`Anthropic API will be proxied through sidecar at http://${networkConfig.proxyIp}:${API_PROXY_PORTS.ANTHROPIC}`);
    if (config.anthropicApiTarget) {
      logger.debug(`Anthropic API target overridden to: ${config.anthropicApiTarget}`);
    }
    if (config.anthropicApiBasePath) {
      logger.debug(`Anthropic API base path set to: ${config.anthropicApiBasePath}`);
    }

    // Set placeholder token for Claude Code CLI compatibility
    // Real authentication happens via ANTHROPIC_BASE_URL pointing to api-proxy
    // Use sk-ant- prefix so Claude Code's key-format validation passes
    agentEnvAdditions.ANTHROPIC_AUTH_TOKEN = 'sk-ant-placeholder-key-for-credential-isolation';
    logger.debug('ANTHROPIC_AUTH_TOKEN set to placeholder value for credential isolation');

    // Set API key helper for Claude Code CLI to use credential isolation
    // The helper script returns a placeholder key; real authentication happens via ANTHROPIC_BASE_URL
    agentEnvAdditions.CLAUDE_CODE_API_KEY_HELPER = '/usr/local/bin/get-claude-key.sh';
    logger.debug('Claude Code API key helper configured: /usr/local/bin/get-claude-key.sh');
  }
  if (config.copilotGithubToken || config.copilotApiKey) {
    agentEnvAdditions.COPILOT_API_URL = `http://${networkConfig.proxyIp}:${API_PROXY_PORTS.COPILOT}`;
    logger.debug(`GitHub Copilot API will be proxied through sidecar at http://${networkConfig.proxyIp}:${API_PROXY_PORTS.COPILOT}`);
    if (config.copilotApiTarget) {
      logger.debug(`Copilot API target overridden to: ${config.copilotApiTarget}`);
    }

    // Set placeholder token for GitHub Copilot CLI compatibility
    // Real authentication happens via COPILOT_API_URL pointing to api-proxy
    agentEnvAdditions.COPILOT_TOKEN = COPILOT_PLACEHOLDER_TOKEN;
    logger.debug('COPILOT_TOKEN set to placeholder value for credential isolation');

    // Note: COPILOT_GITHUB_TOKEN and COPILOT_API_KEY placeholders are set early (before --env-all)
    // to prevent override by host environment variable

    // Set the wire API based solely on the model, regardless of which auth path is active.
    // GPT-5-family models must use the /responses endpoint; setting this here ensures the
    // Copilot CLI uses the correct endpoint even when only copilotGithubToken is provided.
    const copilotModel = getConfigEnvValue(config, 'COPILOT_MODEL');
    if (copilotModel && requiresResponsesWireApi(copilotModel)) {
      agentEnvAdditions.COPILOT_PROVIDER_WIRE_API = 'responses';
      logger.debug(`COPILOT_PROVIDER_WIRE_API set to responses for model: ${copilotModel}`);
    }
  }
  if (config.copilotApiKey) {
    // Enable Copilot CLI offline + BYOK mode so it skips the GitHub OAuth handshake
    // and talks directly to the sidecar without needing GitHub authentication for inference.
    // Reference: https://github.blog/changelog/2026-04-07-copilot-cli-now-supports-byok-and-local-models/
    agentEnvAdditions.COPILOT_OFFLINE = 'true';
    logger.debug('COPILOT_OFFLINE set to true for offline+BYOK mode');

    // Point Copilot CLI's BYOK provider URL at the sidecar, which injects the real API key
    // and forwards the request through Squid. This is the new canonical BYOK env var.
    agentEnvAdditions.COPILOT_PROVIDER_BASE_URL = `http://${networkConfig.proxyIp}:${API_PROXY_PORTS.COPILOT}`;
    logger.debug(`COPILOT_PROVIDER_BASE_URL set to sidecar at http://${networkConfig.proxyIp}:${API_PROXY_PORTS.COPILOT}`);

    // COPILOT_PROVIDER_API_KEY placeholder: real key is held by the sidecar, never exposed to agent.
    // Set early placeholder (before this block) already handled above.
    logger.debug('COPILOT_PROVIDER_API_KEY placeholder set for credential isolation');
  }
  // Only configure Gemini proxy routing when a Gemini API key is provided.
  // Previously this was unconditional, which caused the Gemini CLI's ~/.gemini
  // directory and GEMINI_API_KEY placeholder to appear in non-Gemini runs (e.g.
  // Copilot-only runs), producing suspicious-looking log entries.
  if (config.geminiApiKey) {
    const geminiProxyUrl = `http://${networkConfig.proxyIp}:${API_PROXY_PORTS.GEMINI}`;
    // GOOGLE_GEMINI_BASE_URL is the env var read by the Gemini CLI (google-gemini/gemini-cli)
    // when authType === USE_GEMINI. Setting it routes all Gemini CLI traffic through
    // the api-proxy sidecar instead of calling generativelanguage.googleapis.com directly.
    agentEnvAdditions.GOOGLE_GEMINI_BASE_URL = geminiProxyUrl;
    // GEMINI_API_BASE_URL is kept for backward compatibility with older SDK versions
    // and other tools that may read it (e.g. @google/generative-ai npm package).
    agentEnvAdditions.GEMINI_API_BASE_URL = geminiProxyUrl;
    logger.debug(`Google Gemini API will be proxied through sidecar at ${geminiProxyUrl}`);
    if (config.geminiApiTarget) {
      logger.debug(`Gemini API target overridden to: ${config.geminiApiTarget}`);
    }
    if (config.geminiApiBasePath) {
      logger.debug(`Gemini API base path set to: ${config.geminiApiBasePath}`);
    }

    // Set placeholder key so Gemini CLI's startup auth check passes (exit code 41).
    // Real authentication happens via GOOGLE_GEMINI_BASE_URL / GEMINI_API_BASE_URL pointing to api-proxy.
    agentEnvAdditions.GEMINI_API_KEY = 'gemini-api-key-placeholder-for-credential-isolation';
    logger.debug('GEMINI_API_KEY set to placeholder value for credential isolation');
  }

  logger.info('API proxy sidecar enabled - API keys will be held securely in sidecar container');
  logger.info('API proxy will route through Squid to respect domain whitelisting');

  return { service: proxyService, agentEnvAdditions };
}
