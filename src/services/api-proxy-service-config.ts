import {
  API_PROXY_CONTAINER_NAME,
} from '../constants';
import { assignImageSource } from '../image-tag';
import { WrapperConfig } from '../types';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { NetworkConfig, ImageBuildConfig } from './squid-service';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';
import { buildApiProxyBaseEnv } from './api-proxy-env-config';
import { buildApiProxyLifecycleConfig } from './api-proxy-lifecycle-config';

interface ApiProxyServiceConfigParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  apiProxyLogsPath: string;
  imageConfig: ImageBuildConfig;
}

export function buildApiProxyServiceConfig(params: ApiProxyServiceConfigParams): any {
  const { config, networkConfig, apiProxyLogsPath, imageConfig } = params;
  if (!networkConfig.proxyIp) {
    throw new Error('buildApiProxyServiceConfig: networkConfig.proxyIp is required');
  }
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;

  const proxyService: any = {
    container_name: API_PROXY_CONTAINER_NAME,
    user: `${getSafeHostUid()}:${getSafeHostGid()}`,
    ...buildApiProxyLifecycleConfig(networkConfig),
    volumes: applyHostPathPrefixToVolumes(
      [
        // Mount log directory for api-proxy logs
        `${apiProxyLogsPath}:/var/log/api-proxy:rw`,
      ],
      config.dockerHostPathPrefix,
    ),
    environment: buildApiProxyBaseEnv(config, networkConfig),
    // Security hardening and resource limits to prevent DoS attacks
    ...buildContainerSecurityHardening({ memLimit: '512m', pidsLimit: 100, cpuShares: 512 }),
    stop_grace_period: '2s',
  };

  // Use GHCR image or build locally
  assignImageSource(proxyService, {
    useGHCR, registry, imageName: 'api-proxy', parsedTag, projectRoot, containerDir: 'api-proxy',
  });

  return proxyService;
}
