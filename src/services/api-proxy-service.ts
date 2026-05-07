import * as path from 'path';
import {
  API_PROXY_CONTAINER_NAME,
  SQUID_PORT,
  stripScheme,
} from '../host-env';
import { buildRuntimeImageRef } from '../image-tag';
import { logger } from '../logger';
import { WrapperConfig, API_PROXY_PORTS, API_PROXY_HEALTH_PORT } from '../types';
import { NetworkConfig, ImageBuildConfig } from './squid-service';

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
 * Builds the API proxy sidecar service configuration and associated agent environment
 * mutations required for credential isolation.
 */
export function buildApiProxyService(params: ApiProxyServiceParams): ApiProxyBuildResult {
  const { config, networkConfig, apiProxyLogsPath, imageConfig } = params;
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;
  const normalizedAuthType = (process.env.AWF_AUTH_TYPE || '').trim().toLowerCase();

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
    volumes: [
      // Mount log directory for api-proxy logs
      `${apiProxyLogsPath}:/var/log/api-proxy:rw`,
    ],
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
      ...(config.copilotApiTarget && { COPILOT_API_TARGET: stripScheme(config.copilotApiTarget) }),
      ...(config.copilotApiBasePath && { COPILOT_API_BASE_PATH: config.copilotApiBasePath }),
      ...(config.openaiApiTarget && { OPENAI_API_TARGET: stripScheme(config.openaiApiTarget) }),
      ...(config.openaiApiBasePath && { OPENAI_API_BASE_PATH: config.openaiApiBasePath }),
      ...(config.anthropicApiTarget && { ANTHROPIC_API_TARGET: stripScheme(config.anthropicApiTarget) }),
      ...(config.anthropicApiBasePath && { ANTHROPIC_API_BASE_PATH: config.anthropicApiBasePath }),
      ...(config.geminiApiTarget && { GEMINI_API_TARGET: stripScheme(config.geminiApiTarget) }),
      ...(config.geminiApiBasePath && { GEMINI_API_BASE_PATH: config.geminiApiBasePath }),
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
      // Rate limiting configuration
      ...(config.rateLimitConfig && {
        AWF_RATE_LIMIT_ENABLED: String(config.rateLimitConfig.enabled),
        AWF_RATE_LIMIT_RPM: String(config.rateLimitConfig.rpm),
        AWF_RATE_LIMIT_RPH: String(config.rateLimitConfig.rph),
        AWF_RATE_LIMIT_BYTES_PM: String(config.rateLimitConfig.bytesPm),
      }),
      // Model alias configuration
      ...(config.modelAliases && {
        AWF_MODEL_ALIASES: JSON.stringify({ models: config.modelAliases }),
      }),
      // Anthropic prompt-cache optimizations
      ...(config.anthropicAutoCache && {
        AWF_ANTHROPIC_AUTO_CACHE: '1',
        ...(config.anthropicCacheTailTtl && { AWF_ANTHROPIC_CACHE_TAIL_TTL: config.anthropicCacheTailTtl }),
      }),
      // Enable OpenCode listener only when explicitly requested
      ...(config.enableOpenCode && { AWF_ENABLE_OPENCODE: 'true' }),
      // OIDC authentication for Azure OpenAI (Entra-only deployments)
      ...(process.env.AWF_AUTH_TYPE && { AWF_AUTH_TYPE: process.env.AWF_AUTH_TYPE }),
      ...(process.env.AWF_AUTH_AZURE_TENANT_ID && { AWF_AUTH_AZURE_TENANT_ID: process.env.AWF_AUTH_AZURE_TENANT_ID }),
      ...(process.env.AWF_AUTH_AZURE_CLIENT_ID && { AWF_AUTH_AZURE_CLIENT_ID: process.env.AWF_AUTH_AZURE_CLIENT_ID }),
      ...(process.env.AWF_AUTH_OIDC_AUDIENCE && { AWF_AUTH_OIDC_AUDIENCE: process.env.AWF_AUTH_OIDC_AUDIENCE }),
      ...(process.env.AWF_AUTH_AZURE_SCOPE && { AWF_AUTH_AZURE_SCOPE: process.env.AWF_AUTH_AZURE_SCOPE }),
      ...(process.env.AWF_AUTH_AZURE_CLOUD && { AWF_AUTH_AZURE_CLOUD: process.env.AWF_AUTH_AZURE_CLOUD }),
      // GitHub Actions OIDC runtime tokens (needed by OIDC token provider in api-proxy)
      ...(normalizedAuthType === 'github-oidc' && process.env.ACTIONS_ID_TOKEN_REQUEST_URL && {
        ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
      }),
      ...(normalizedAuthType === 'github-oidc' && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && {
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      }),
      // Anthropic request optimisations (all opt-in via env vars on the host)
      ...(process.env.AWF_ANTHROPIC_AUTO_CACHE && { AWF_ANTHROPIC_AUTO_CACHE: process.env.AWF_ANTHROPIC_AUTO_CACHE }),
      ...(process.env.AWF_ANTHROPIC_CACHE_TAIL_TTL && { AWF_ANTHROPIC_CACHE_TAIL_TTL: process.env.AWF_ANTHROPIC_CACHE_TAIL_TTL }),
      ...(process.env.AWF_ANTHROPIC_DROP_TOOLS && { AWF_ANTHROPIC_DROP_TOOLS: process.env.AWF_ANTHROPIC_DROP_TOOLS }),
      ...(process.env.AWF_ANTHROPIC_STRIP_ANSI && { AWF_ANTHROPIC_STRIP_ANSI: process.env.AWF_ANTHROPIC_STRIP_ANSI }),
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
    // Security hardening: Drop all capabilities
    cap_drop: ['ALL'],
    security_opt: [
      'no-new-privileges:true',
    ],
    // Resource limits to prevent DoS attacks
    mem_limit: '512m',
    memswap_limit: '512m',
    pids_limit: 100,
    cpu_shares: 512,
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
  if (config.anthropicApiKey) {
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
    agentEnvAdditions.COPILOT_TOKEN = 'placeholder-token-for-credential-isolation';
    logger.debug('COPILOT_TOKEN set to placeholder value for credential isolation');

    // Note: COPILOT_GITHUB_TOKEN and COPILOT_API_KEY placeholders are set early (before --env-all)
    // to prevent override by host environment variable
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
