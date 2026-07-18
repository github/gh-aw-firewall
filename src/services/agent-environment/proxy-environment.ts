import { WrapperConfig } from '../../types';
import { NetworkConfig } from '../squid-service';
import { buildNoProxyValue } from '../no-proxy-utils';

interface ProxyEnvironmentParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  environment: Record<string, string>;
}

export function buildProxyEnvironment(params: ProxyEnvironmentParams): void {
  const { config, networkConfig, environment } = params;

  const noProxyHosts: string[] = ['0.0.0.0', networkConfig.squidIp, networkConfig.agentIp];

  if (config.enableHostAccess) {
    const subnetBase = networkConfig.subnet.split('/')[0];
    const parts = subnetBase.split('.');
    const networkGatewayIp = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
    noProxyHosts.push('host.docker.internal', networkGatewayIp);
  }

  if (config.enableApiProxy && networkConfig.proxyIp) {
    // Include both IP and Docker service hostname — Node.js undici matches
    // NO_PROXY against the request hostname string, not the resolved IP.
    noProxyHosts.push(networkConfig.proxyIp, 'api-proxy');
  }

  environment.NO_PROXY = buildNoProxyValue(noProxyHosts);
  environment.no_proxy = environment.NO_PROXY;
}
