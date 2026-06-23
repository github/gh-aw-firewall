import { logger } from '../../logger';
import { WrapperConfig, API_PROXY_PORTS } from '../../types';

interface GeminiCredentialEnvParams {
  config: WrapperConfig;
  proxyIp: string;
}

export function buildGeminiCredentialEnv(params: GeminiCredentialEnvParams): Record<string, string> {
  const { config, proxyIp } = params;
  // Only configure Gemini proxy routing when a Gemini API key is provided.
  // Previously this was unconditional, which caused the Gemini CLI's ~/.gemini
  // directory and GEMINI_API_KEY placeholder to appear in non-Gemini runs (e.g.
  // Copilot-only runs), producing suspicious-looking log entries.
  if (!config.geminiApiKey) {
    return {};
  }

  const geminiProxyUrl = `http://${proxyIp}:${API_PROXY_PORTS.GEMINI}`;
  const agentEnvAdditions: Record<string, string> = {
    // GOOGLE_GEMINI_BASE_URL is the env var read by the Gemini CLI (google-gemini/gemini-cli)
    // when authType === USE_GEMINI. Setting it routes all Gemini CLI traffic through
    // the api-proxy sidecar instead of calling generativelanguage.googleapis.com directly.
    GOOGLE_GEMINI_BASE_URL: geminiProxyUrl,
    // GEMINI_API_BASE_URL is kept for backward compatibility with older SDK versions
    // and other tools that may read it (e.g. @google/generative-ai npm package).
    GEMINI_API_BASE_URL: geminiProxyUrl,
  };

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

  return agentEnvAdditions;
}
