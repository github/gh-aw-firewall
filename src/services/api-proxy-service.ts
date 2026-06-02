import { logger } from '../logger';
import { WrapperConfig } from '../types';
import { NetworkConfig, ImageBuildConfig } from './squid-service';
import { buildApiProxyServiceConfig } from './api-proxy-service-config';
import { buildAgentCredentialEnv } from './api-proxy-credential-env';

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
  const { networkConfig } = params;

  if (!networkConfig.proxyIp) {
    throw new Error('buildApiProxyService: networkConfig.proxyIp is required');
  }

  const service = buildApiProxyServiceConfig(params);
  const agentEnvAdditions = buildAgentCredentialEnv(params);

  logger.info('API proxy sidecar enabled - API keys will be held securely in sidecar container');
  logger.info('API proxy will route through Squid to respect domain whitelisting');

  return { service, agentEnvAdditions };
}
