import { logger } from '../../logger';
import { WrapperConfig, API_PROXY_PORTS } from '../../types';

interface OpenAiCredentialEnvParams {
  config: WrapperConfig;
  proxyIp: string;
}

export function buildOpenAiCredentialEnv(params: OpenAiCredentialEnvParams): Record<string, string> {
  const { config, proxyIp } = params;
  if (!config.openaiApiKey) {
    return {};
  }

  const openAiProxyUrl = `http://${proxyIp}:${API_PROXY_PORTS.OPENAI}`;
  const agentEnvAdditions: Record<string, string> = {
    OPENAI_BASE_URL: openAiProxyUrl,
  };

  logger.debug(`OpenAI API will be proxied through sidecar at ${openAiProxyUrl}`);
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

  return agentEnvAdditions;
}
