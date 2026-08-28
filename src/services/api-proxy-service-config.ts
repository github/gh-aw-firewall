import * as fs from 'fs';
import * as path from 'path';
import {
  API_PROXY_CONTAINER_NAME,
} from '../constants';
import { assignImageSource } from '../image-tag';
import { WrapperConfig } from '../types';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { NetworkConfig, ImageBuildConfig } from './squid-service';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';
import {
  API_PROXY_UPSTREAM_CA_CERT_CONTAINER_PATH,
  buildApiProxyBaseEnv,
  resolveApiProxyShutdownTimeoutMs,
} from './api-proxy-env-config';
import { buildApiProxyLifecycleConfig } from './api-proxy-lifecycle-config';

interface ApiProxyServiceConfigParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  apiProxyLogsPath: string;
  imageConfig: ImageBuildConfig;
}

function resolveApiProxyCaCertPath(source: string): string {
  if (!source.trim()) {
    throw new Error('apiProxy.caCert must be a non-empty path');
  }

  const resolvedPath = path.resolve(process.cwd(), source);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    throw new Error(`apiProxy.caCert file does not exist: ${resolvedPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`apiProxy.caCert must refer to a file: ${resolvedPath}`);
  }
  return resolvedPath;
}

export function buildApiProxyServiceConfig(params: ApiProxyServiceConfigParams): any {
  const { config, networkConfig, apiProxyLogsPath, imageConfig } = params;
  if (!networkConfig.proxyIp) {
    throw new Error('buildApiProxyServiceConfig: networkConfig.proxyIp is required');
  }
  const { useGHCR, registry, parsedTag, projectRoot, resolveImage } = imageConfig;
  const shutdownTimeoutMs = resolveApiProxyShutdownTimeoutMs(config);
  const stopGracePeriodSeconds = Math.ceil((shutdownTimeoutMs + 2000) / 1000);
  const apiProxyCaCertPath = config.apiProxyCaCert === undefined
    ? undefined
    : resolveApiProxyCaCertPath(config.apiProxyCaCert);

  const proxyService: any = {
    container_name: API_PROXY_CONTAINER_NAME,
    user: `${getSafeHostUid()}:${getSafeHostGid()}`,
    ...buildApiProxyLifecycleConfig(networkConfig),
    volumes: applyHostPathPrefixToVolumes(
      [
        // Mount log directory for api-proxy logs
        `${apiProxyLogsPath}:/var/log/api-proxy:rw`,
        ...(apiProxyCaCertPath ? [`${apiProxyCaCertPath}:${API_PROXY_UPSTREAM_CA_CERT_CONTAINER_PATH}:ro`] : []),
      ],
      config.dockerHostPathPrefix,
    ),
    environment: buildApiProxyBaseEnv(config, networkConfig),
    // Security hardening and resource limits to prevent DoS attacks
    ...buildContainerSecurityHardening({ memLimit: '512m', pidsLimit: 100, cpuShares: 512 }),
    stop_grace_period: `${stopGracePeriodSeconds}s`,
  };

  // Use GHCR image or build locally
  assignImageSource(proxyService, {
    useGHCR, registry, imageName: 'api-proxy', parsedTag, projectRoot, containerDir: 'api-proxy',
  });
  if (useGHCR && resolveImage) proxyService.image = resolveImage('api-proxy');

  return proxyService;
}
