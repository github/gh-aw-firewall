import { logger } from '../../logger';

export interface ProviderCredentialIsolationOptions {
  /** Human-readable provider name used in debug log messages, e.g. "OpenAI" */
  providerName: string;
  proxyIp: string;
  port: number;
  /** When false the provider is not routed through the sidecar; the helper returns {} */
  enabled: boolean;
  /**
   * Names of the env vars that should be set to the sidecar proxy URL
   * (e.g. `['OPENAI_BASE_URL']` or `['COPILOT_API_URL', 'COPILOT_PROVIDER_BASE_URL']`).
   */
  baseUrlVarNames: string[];
  /** Optional target hostname override — logged only, not injected into env */
  target?: string;
  /** Optional base-path override — logged only, not injected into env */
  basePath?: string;
  /** Placeholder credential vars to inject into the agent env */
  placeholders: Record<string, string>;
  /** Any additional provider-specific env vars to merge after placeholders */
  extraEnv?: Record<string, string>;
}

/**
 * Shared scaffold for all per-provider credential-isolation env builders.
 *
 * Handles the security-critical flow common to every provider:
 *   1. Enabled guard — returns {} when the provider should not be proxied.
 *   2. Proxy URL construction — `http://<proxyIp>:<port>`.
 *   3. Base-URL env vars — each name in `baseUrlVarNames` is set to the proxy URL.
 *   4. Debug logging — proxy URL, optional target override, optional base-path override.
 *   5. Placeholder merge — injects credential placeholder vars so real keys stay in the sidecar.
 *   6. Extra-env merge — any additional provider-specific vars (e.g. `COPILOT_OFFLINE`).
 *
 * Provider files keep only their enable-condition logic and any conditional post-processing
 * (e.g. Copilot's BYOK placeholders, Wire API env var).
 */
export function buildProviderCredentialIsolationEnv(opts: ProviderCredentialIsolationOptions): Record<string, string> {
  if (!opts.enabled) {
    return {};
  }

  const proxyUrl = `http://${opts.proxyIp}:${opts.port}`;
  const result: Record<string, string> = {};

  for (const envVar of opts.baseUrlVarNames) {
    result[envVar] = proxyUrl;
  }

  logger.debug(`${opts.providerName} API will be proxied through sidecar at ${proxyUrl}`);
  if (opts.target) {
    logger.debug(`${opts.providerName} API target overridden to: ${opts.target}`);
  }
  if (opts.basePath) {
    logger.debug(`${opts.providerName} API base path set to: ${opts.basePath}`);
  }

  Object.assign(result, opts.placeholders);
  if (opts.extraEnv) {
    Object.assign(result, opts.extraEnv);
  }

  return result;
}
