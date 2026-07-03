import { WrapperConfig, API_PROXY_PORTS } from '../../types';
import { buildProviderCredentialIsolationEnv } from './provider-credential-isolation';

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
  return buildProviderCredentialIsolationEnv({
    providerName: 'Google Gemini',
    proxyIp,
    port: API_PROXY_PORTS.GEMINI,
    enabled: !!config.geminiApiKey,
    // GOOGLE_GEMINI_BASE_URL is the env var read by the Gemini CLI (google-gemini/gemini-cli)
    // when authType === USE_GEMINI. Setting it routes all Gemini CLI traffic through
    // the api-proxy sidecar instead of calling generativelanguage.googleapis.com directly.
    // GEMINI_API_BASE_URL is kept for backward compatibility with older SDK versions
    // and other tools that may read it (e.g. @google/generative-ai npm package).
    baseUrlVarNames: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_BASE_URL'],
    target: config.geminiApiTarget,
    basePath: config.geminiApiBasePath,
    // Set placeholder key so Gemini CLI's startup auth check passes (exit code 41).
    // Real authentication happens via GOOGLE_GEMINI_BASE_URL / GEMINI_API_BASE_URL pointing to api-proxy.
    placeholders: {
      GEMINI_API_KEY: 'gemini-api-key-placeholder-for-credential-isolation',
    },
  });
}
