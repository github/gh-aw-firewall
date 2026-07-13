import { WrapperConfig } from '../../types';
import { NetworkConfig } from '../squid-service';

interface ProxyEnvironmentParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  environment: Record<string, string>;
}

export function buildProxyEnvironment(params: ProxyEnvironmentParams): void {
  const { config, networkConfig, environment } = params;

  const noProxyEntries = [
    'localhost',
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    networkConfig.squidIp,
    networkConfig.agentIp,
  ];

  if (config.enableHostAccess) {
    const subnetBase = networkConfig.subnet.split('/')[0];
    const parts = subnetBase.split('.');
    const networkGatewayIp = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
    noProxyEntries.push('host.docker.internal', networkGatewayIp);
  }

  if (config.enableApiProxy && networkConfig.proxyIp) {
    // Include both IP and Docker service hostname — Node.js undici matches
    // NO_PROXY against the request hostname string, not the resolved IP.
    noProxyEntries.push(networkConfig.proxyIp, 'api-proxy');
  }

  noProxyEntries.push(...(config.topologyAttach || []));

  environment.NO_PROXY = [...new Set(noProxyEntries)].join(',');
  environment.no_proxy = environment.NO_PROXY;
}
