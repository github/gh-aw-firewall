import { WrapperConfig, API_PROXY_PORTS } from '../../types';
import { buildProviderCredentialIsolationEnv } from './provider-credential-isolation';

interface VertexCredentialEnvParams {
  config: WrapperConfig;
  proxyIp: string;
}

export function buildVertexCredentialEnv(params: VertexCredentialEnvParams): Record<string, string> {
  const { config, proxyIp } = params;
  // Only configure Vertex proxy routing when a Google API key is provided.
  // GOOGLE_VERTEX_BASE_URL is the env var read by the Gemini CLI (google-gemini/gemini-cli)
  // when authType === USE_VERTEX. Setting it routes all Vertex AI traffic through
  // the api-proxy sidecar instead of calling aiplatform.googleapis.com directly.
  return buildProviderCredentialIsolationEnv({
    providerName: 'Google Vertex AI',
    proxyIp,
    port: API_PROXY_PORTS.VERTEX,
    enabled: !!config.googleApiKey,
    baseUrlVarNames: ['GOOGLE_VERTEX_BASE_URL'],
    target: config.vertexApiTarget,
    basePath: config.vertexApiBasePath,
    // Set placeholder key so Gemini CLI's Vertex auth check passes.
    // Real authentication happens via GOOGLE_VERTEX_BASE_URL pointing to api-proxy.
    placeholders: {
      GOOGLE_API_KEY: 'google-api-key-placeholder-for-credential-isolation',
    },
  });
}
