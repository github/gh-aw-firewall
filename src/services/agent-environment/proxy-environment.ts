import { WrapperConfig } from '../../types';
import { NetworkConfig } from '../squid-service';
import { buildNoProxyValue } from '../no-proxy-utils';
import { runtimeUsesIptables, runtimeUsesComposeAgent } from '../../container-runtime';

interface ProxyEnvironmentParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  environment: Record<string, string>;
}

export function buildProxyEnvironment(params: ProxyEnvironmentParams): void {
  const { config, networkConfig, environment } = params;

  const noProxyHosts: string[] = ['0.0.0.0', networkConfig.squidIp, networkConfig.agentIp];

  // Network-isolation (topology) mode has no iptables-init container, so the
  // only lever to keep intra-`awf-net` peer traffic out of Squid is NO_PROXY.
  // Exempt topology-attached peers (e.g. the MCP gateway `awmg-mcpg` and the
  // DIFC/cli-proxy `awmg-cli-proxy`) so proxy-aware clients (rmcp/undici)
  // connect to them directly instead of being routed through Squid and denied.
  //
  // Only meaningful when the agent actually shares `awf-net`, i.e. a
  // compose-managed agent (runc, gVisor). For microVM backends (Docker sbx) the
  // agent runs off `awf-net` and cannot resolve or route to these container
  // hostnames — adding them to NO_PROXY there would turn a Squid 403 into an
  // unroutable direct connection, so they are deliberately skipped. sbx reaches
  // gateway peers through its own proxy-chaining path, not NO_PROXY.
  //
  // Hostname-only by design: peer IPs are not known at config-write time (they
  // are discovered after the network attach in cli-workflow's onNetworkReady),
  // and MCP URLs address peers by hostname (e.g. http://awmg-mcpg:8080), which
  // is what undici matches NO_PROXY against.
  if (config.networkIsolation && runtimeUsesComposeAgent(config.containerRuntime)) {
    if (config.topologyAttach) {
      noProxyHosts.push(...config.topologyAttach);
    }
  }

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

  environment.NO_PROXY = buildNoProxyValue([...new Set(noProxyHosts)]);
  environment.no_proxy = environment.NO_PROXY;
}
