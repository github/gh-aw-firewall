import { WrapperConfig } from '../../types';
import { NetworkConfig } from '../squid-service';
import { buildNoProxyValue } from '../no-proxy-utils';
import { runtimeUsesIptables } from '../../container-runtime';

interface ProxyEnvironmentParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  environment: Record<string, string>;
}

export function buildProxyEnvironment(params: ProxyEnvironmentParams): void {
  const { config, networkConfig, environment } = params;

  const noProxyHosts: string[] = ['0.0.0.0', networkConfig.squidIp, networkConfig.agentIp];

  // The MCP gateway is served on the network gateway (e.g. 172.30.0.1). In
  // standard mode an iptables NAT RETURN rule bypasses Squid for it. Runtimes
  // whose netstack can't use host-netns iptables (e.g. gVisor) have no such
  // bypass, so add the gateway to NO_PROXY so proxy-aware clients (rmcp) connect
  // to it directly instead of being routed through Squid and rejected.
  const gatewayNeedsNoProxy = config.enableHostAccess || !runtimeUsesIptables(config.containerRuntime);
  if (gatewayNeedsNoProxy) {
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
