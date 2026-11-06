import { WrapperConfig, API_PROXY_PORTS } from '../../types';
import { buildProviderCredentialIsolationEnv } from './provider-credential-isolation';

interface OpenAiCredentialEnvParams {
  config: WrapperConfig;
  proxyIp: string;
}

export function buildOpenAiCredentialEnv(params: OpenAiCredentialEnvParams): Record<string, string> {
  const { config, proxyIp } = params;
  // Inject placeholder API keys for OpenAI/Codex credential isolation.
  // Placeholders satisfy client-side key checks, including Codex WebSocket auth.
  // They do not select a provider or guarantee routing: the pinned Codex regression
  // explicitly selects a Responses provider using this sidecar's OPENAI_BASE_URL.
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
