import type { HostAccessConfig, CliProxyHostConfig } from '../host-iptables';
import { DEFAULT_DNS_SERVERS } from '../dns-resolver';
import { parseDifcProxyHost } from '../docker-manager';
import { updateEnclaveStartupProgress } from '../enclave/startup-progress';
import type { WorkflowContext } from './context';

export async function setupHostNetwork(context: WorkflowContext): Promise<void> {
  const { config, dependencies, checks, addressing, options: { logger, onHostIptablesSetup } } = context;
  // Step 0: Setup host-level network and iptables
  //
  // In network-isolation (topology) mode, egress is enforced purely by Docker
  // network topology (internal network + dual-homed proxy). No host iptables and
  // no pre-created external network are needed — docker-compose creates the
  // internal and external networks itself — so this step is skipped entirely.
  updateEnclaveStartupProgress(config, { stage: 'host-network' });
  await checks.check('network-enforcement', async () => {
    if (config.networkIsolation) {
      // Topology enforcement runs entirely through the Docker daemon's networking,
      // so a reachable daemon is mandatory. Abort early with a clear message on
      // unsupported platforms (e.g. ARC Kubernetes-native without DinD).
      if (dependencies.assertTopologySupported) {
        await dependencies.assertTopologySupported();
      }
      logger.info('Network-isolation mode: enforcing egress via Docker network topology (no host iptables, no sudo).');
    } else {
      logger.info('Setting up host-level firewall network and iptables rules...');
      const networkConfig = await dependencies.ensureFirewallNetwork(config.networkSubnet);
      // When API proxy is enabled, allow agent→sidecar traffic at the host level.
      // The sidecar itself routes through Squid, so domain whitelisting is still enforced.
      const dnsServers = config.dnsServers || DEFAULT_DNS_SERVERS;
      const apiProxyIp = config.enableApiProxy ? networkConfig.proxyIp : undefined;
      // When DoH is enabled, the DoH proxy needs direct HTTPS access to the resolver
      const dohProxyIp = config.dnsOverHttps ? addressing.dohProxyIp : undefined;
      const hostAccess: HostAccessConfig | undefined = config.enableHostAccess
        ? { enabled: true, allowHostPorts: config.allowHostPorts, allowHostServicePorts: config.allowHostServicePorts }
        : undefined;
      // When DIFC proxy is enabled, allow cli-proxy container to reach the host gateway
      // on the DIFC proxy port (e.g., 18443)
      let cliProxyConfig: CliProxyHostConfig | undefined;
      if (config.difcProxyHost) {
        const { port } = parseDifcProxyHost(config.difcProxyHost);
        cliProxyConfig = { ip: addressing.cliProxyIp, difcProxyPort: parseInt(port, 10) };
      }
      await dependencies.setupHostIptables(networkConfig.squidIp, 3128, dnsServers, apiProxyIp, dohProxyIp, hostAccess, cliProxyConfig, addressing.gatewayIp);
      onHostIptablesSetup?.();
    }
  });
}
