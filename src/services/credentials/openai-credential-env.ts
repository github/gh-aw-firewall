import { WrapperConfig, API_PROXY_PORTS } from '../../types';
import { buildProviderCredentialIsolationEnv } from './provider-credential-isolation';

interface OpenAiCredentialEnvParams {
  config: WrapperConfig;
  proxyIp: string;
}

export function buildOpenAiCredentialEnv(params: OpenAiCredentialEnvParams): Record<string, string> {
  const { config, proxyIp } = params;
  // Inject placeholder API keys for OpenAI/Codex credential isolation.
  // Codex v0.121+ introduced a CODEX_API_KEY-based WebSocket auth flow: when no
  // API key is found in the agent env, Codex bypasses OPENAI_BASE_URL and connects
  // directly to api.openai.com for OAuth, getting a 401. With a placeholder key
  // present, Codex routes API calls through OPENAI_BASE_URL (the api-proxy sidecar),
  // which replaces the Authorization header with the real key before forwarding.
  // The real keys are held securely in the sidecar; when requests are routed
  // through api-proxy, these placeholders are expected to be overwritten by the
  // api-proxy's injectHeaders before forwarding upstream.
  return buildProviderCredentialIsolationEnv({
    providerName: 'OpenAI',
    proxyIp,
    port: API_PROXY_PORTS.OPENAI,
    enabled: !!config.openaiApiKey,
    baseUrlVarNames: ['OPENAI_BASE_URL'],
    target: config.openaiApiTarget,
    basePath: config.openaiApiBasePath,
    placeholders: {
      OPENAI_API_KEY: 'sk-placeholder-for-api-proxy',
      CODEX_API_KEY: 'sk-placeholder-for-api-proxy',
    },
  });
}
