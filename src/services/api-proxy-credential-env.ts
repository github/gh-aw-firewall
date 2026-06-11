import { logger } from '../logger';
import { WrapperConfig, API_PROXY_PORTS } from '../types';
import { COPILOT_PLACEHOLDER_TOKEN } from '../constants/placeholders';
import { getConfigEnvValue, getLowerCaseProcessEnvValue } from '../env-utils';
import { NetworkConfig } from './squid-service';

interface ApiProxyCredentialEnvParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
}

// Match GPT-5 family model IDs with optional provider prefixes (e.g. "openai/gpt-5",
// "copilot/o3-mini"). Prefix is intentionally broad because model providers/prefixes
// are runtime-configurable and not limited to a fixed allowlist.
const RESPONSES_WIRE_API_MODEL_PATTERN = /(^|[/:])(gpt-5|o3)([-_.]|$)/i;

function requiresResponsesWireApi(copilotModel: string): boolean {
  return RESPONSES_WIRE_API_MODEL_PATTERN.test(copilotModel);
}

export function buildAgentCredentialEnv(params: ApiProxyCredentialEnvParams): Record<string, string> {
  const { config, networkConfig } = params;
  if (!networkConfig.proxyIp) {
    throw new Error('buildAgentCredentialEnv: networkConfig.proxyIp is required');
  }
  const normalizedAuthType = getLowerCaseProcessEnvValue('AWF_AUTH_TYPE') || '';
  const normalizedAuthProvider = getLowerCaseProcessEnvValue('AWF_AUTH_PROVIDER') || '';
  const shouldProxyAnthropic = Boolean(config.anthropicApiKey || (normalizedAuthType === 'github-oidc' && normalizedAuthProvider === 'anthropic'));

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

    // Set placeholder credentials for Claude Code CLI credential isolation.
    // Real authentication happens via ANTHROPIC_BASE_URL pointing to api-proxy.
    // Use sk-ant- prefix so Claude Code's key-format validation passes.
    //
    // ANTHROPIC_API_KEY must be set here (in agentEnvAdditions, applied last in
    // compose-generator) so it overrides any value that leaked into the environment
    // via config.additionalEnv (e.g. a --env ANTHROPIC_API_KEY=... workaround).
    // Without this, the real or placeholder key would reach the agent, causing it
    // to bypass ANTHROPIC_BASE_URL and go directly to api.anthropic.com (→ 401).
    agentEnvAdditions.ANTHROPIC_API_KEY = 'sk-ant-placeholder-key-for-credential-isolation';
    logger.debug('ANTHROPIC_API_KEY set to placeholder value for credential isolation');
    agentEnvAdditions.ANTHROPIC_AUTH_TOKEN = 'sk-ant-placeholder-key-for-credential-isolation';
    logger.debug('ANTHROPIC_AUTH_TOKEN set to placeholder value for credential isolation');

    // Set API key helper for Claude Code CLI to use credential isolation
    // The helper script returns a placeholder key; real authentication happens via ANTHROPIC_BASE_URL
    agentEnvAdditions.CLAUDE_CODE_API_KEY_HELPER = '/usr/local/bin/get-claude-key.sh';
    logger.debug('Claude Code API key helper configured: /usr/local/bin/get-claude-key.sh');
  }
  // Route Copilot CLI through the api-proxy sidecar in either of two BYOK modes:
  //
  //   (a) GitHub-token mode — user provides COPILOT_GITHUB_TOKEN. The sidecar holds
  //       the GitHub token and talks to api.githubcopilot.com (CAPI). Used by gh-aw
  //       and by direct `awf -- copilot ...` invocations.
  //
  //   (b) Direct-BYOK mode — user provides COPILOT_PROVIDER_API_KEY (typically with
  //       COPILOT_PROVIDER_BASE_URL) via --env / --env-file / --env-all to point
  //       Copilot CLI at an arbitrary upstream (Azure Foundry, OpenRouter, etc.).
  //       The sidecar still terminates locally; the user's real provider URL/key
  //       are forwarded to the sidecar (see api-proxy-service-config.ts) and the
  //       sidecar uses them as the upstream target while the agent only sees the
  //       loopback sidecar URL and a placeholder key.
  //
  // Both modes set the same agent-side env (offline + BYOK pointed at the sidecar)
  // so that COPILOT_PROVIDER_API_KEY / COPILOT_PROVIDER_BASE_URL never leak into
  // the agent.
  //
  // The trigger also fires when only COPILOT_PROVIDER_BASE_URL is supplied (without
  // a key). The sidecar does not currently support no-auth upstreams and will return
  // 503 in that case, but routing the request through the sidecar (rather than
  // letting the real BASE_URL leak into the agent) preserves the credential-isolation
  // invariant and surfaces a clear error instead of a silent bypass.
  // Reference: https://github.blog/changelog/2026-04-07-copilot-cli-now-supports-byok-and-local-models/
  const hasCopilotProviderApiKey = !!config.copilotProviderApiKey;
  const hasCopilotProviderBaseUrl = !!config.copilotProviderBaseUrl || !!getConfigEnvValue(config, 'COPILOT_PROVIDER_BASE_URL');
  if (config.copilotGithubToken || hasCopilotProviderApiKey || hasCopilotProviderBaseUrl) {
    agentEnvAdditions.COPILOT_API_URL = `http://${networkConfig.proxyIp}:${API_PROXY_PORTS.COPILOT}`;
    logger.debug(`GitHub Copilot API will be proxied through sidecar at http://${networkConfig.proxyIp}:${API_PROXY_PORTS.COPILOT}`);
    if (config.copilotApiTarget) {
      logger.debug(`Copilot API target overridden to: ${config.copilotApiTarget}`);
    }

    // Set placeholder token for GitHub Copilot CLI compatibility
    // Real authentication happens via COPILOT_API_URL pointing to api-proxy
    agentEnvAdditions.COPILOT_TOKEN = COPILOT_PLACEHOLDER_TOKEN;
    logger.debug('COPILOT_TOKEN set to placeholder value for credential isolation');

    // Credential-isolation placeholders for the BYOK auth variables. These MUST be
    // set here (in agentEnvAdditions, applied last in compose-generator) rather than
    // only in tool-specific-environment.ts, because `Object.assign(environment,
    // config.additionalEnv)` in github-actions-environment.ts otherwise overrides any
    // earlier placeholder with the user-supplied real value (e.g. when the user runs
    // `awf --env COPILOT_PROVIDER_API_KEY=...`). The real values are forwarded to the
    // sidecar (see api-proxy-service-config.ts); the agent only ever sees these
    // placeholders regardless of which env input path (--env / --env-file / --env-all)
    // the user used.
    if (config.copilotGithubToken) {
      agentEnvAdditions.COPILOT_GITHUB_TOKEN = COPILOT_PLACEHOLDER_TOKEN;
      logger.debug('COPILOT_GITHUB_TOKEN set to placeholder value for credential isolation');
    }
    // Only mask COPILOT_PROVIDER_API_KEY when the user actually supplied one. If
    // there is nothing to mask, omit it rather than injecting a placeholder that
    // would misleadingly tell Copilot CLI "a key is configured".
    if (hasCopilotProviderApiKey) {
      agentEnvAdditions.COPILOT_PROVIDER_API_KEY = COPILOT_PLACEHOLDER_TOKEN;
      logger.debug('COPILOT_PROVIDER_API_KEY set to placeholder value for credential isolation');
    }

    // Set the wire API based solely on the model, regardless of which auth path is active.
    // GPT-5-family models must use the /responses endpoint; setting this here ensures the
    // Copilot CLI uses the correct endpoint in both BYOK modes.
    const copilotModel = getConfigEnvValue(config, 'COPILOT_MODEL');
    if (copilotModel && requiresResponsesWireApi(copilotModel)) {
      agentEnvAdditions.COPILOT_PROVIDER_WIRE_API = 'responses';
      logger.debug(`COPILOT_PROVIDER_WIRE_API set to responses for model: ${copilotModel}`);
    }

    // Enable Copilot CLI offline + BYOK mode so it skips the GitHub OAuth handshake
    // and talks directly to the sidecar without needing GitHub authentication for inference.
    agentEnvAdditions.COPILOT_OFFLINE = 'true';
    logger.debug('COPILOT_OFFLINE set to true for offline+BYOK mode');

    // Point Copilot CLI's BYOK provider URL at the sidecar. The sidecar then forwards
    // either to api.githubcopilot.com (GitHub-token mode) or to the user-supplied
    // upstream COPILOT_PROVIDER_BASE_URL (direct-BYOK mode).
    agentEnvAdditions.COPILOT_PROVIDER_BASE_URL = `http://${networkConfig.proxyIp}:${API_PROXY_PORTS.COPILOT}`;
    logger.debug(`COPILOT_PROVIDER_BASE_URL set to sidecar at http://${networkConfig.proxyIp}:${API_PROXY_PORTS.COPILOT}`);
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

  return agentEnvAdditions;
}
