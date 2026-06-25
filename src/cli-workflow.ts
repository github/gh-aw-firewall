import { WrapperConfig } from './types';
import { HostAccessConfig, CliProxyHostConfig } from './host-iptables';
import { DEFAULT_DNS_SERVERS } from './dns-resolver';
import { parseDifcProxyHost } from './docker-manager';
import { CLI_PROXY_IP, DOH_PROXY_IP } from './host-iptables-shared';
import { TOPOLOGY_NETWORK_NAME } from './topology';

interface WorkflowDependencies {
  ensureFirewallNetwork: () => Promise<{ squidIp: string; agentIp: string; proxyIp: string; subnet: string }>;
  setupHostIptables: (squidIp: string, port: number, dnsServers: string[], apiProxyIp?: string, dohProxyIp?: string, hostAccess?: HostAccessConfig, cliProxyConfig?: CliProxyHostConfig) => Promise<void>;
  writeConfigs: (config: WrapperConfig) => Promise<void>;
  startContainers: (workDir: string, allowedDomains: string[], proxyLogsDir?: string, skipPull?: boolean, onNetworkReady?: () => Promise<void>) => Promise<void>;
  runAgentCommand: (
    workDir: string,
    allowedDomains: string[],
    proxyLogsDir?: string,
    agentTimeoutMinutes?: number
  ) => Promise<{ exitCode: number }>;
  collectDiagnosticLogs?: (workDir: string) => Promise<void>;
  /**
   * Fail-stop preflight for network-isolation mode. Aborts (process exit) when
   * topology enforcement cannot be supported on the current platform.
   */
  assertTopologySupported?: () => Promise<void>;
  /**
   * Connects externally-launched trusted containers to the internal topology
   * network after the AWF containers have started.
   */
  connectTopologyContainers?: (networkName: string, containerNames: string[]) => Promise<void>;
}

interface WorkflowCallbacks {
  onHostIptablesSetup?: () => void;
  onContainersStarted?: () => void;
}

interface WorkflowLogger {
  info: (message: string, ...args: unknown[]) => void;
  success: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

interface WorkflowOptions extends WorkflowCallbacks {
  logger: WorkflowLogger;
  performCleanup: () => Promise<void>;
}

/**
 * Executes the primary workflow for the CLI. This function is intentionally pure so
 * it can be unit tested with mocked dependencies.
 */
export async function runMainWorkflow(
  config: WrapperConfig,
  dependencies: WorkflowDependencies,
  options: WorkflowOptions
): Promise<number> {
  const { logger, performCleanup, onHostIptablesSetup, onContainersStarted } = options;

  // Step 0: Setup host-level network and iptables
  //
  // In network-isolation (topology) mode, egress is enforced purely by Docker
  // network topology (internal network + dual-homed proxy). No host iptables and
  // no pre-created external network are needed — docker-compose creates the
  // internal and external networks itself — so this step is skipped entirely.
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
    const networkConfig = await dependencies.ensureFirewallNetwork();
    // When API proxy is enabled, allow agent→sidecar traffic at the host level.
    // The sidecar itself routes through Squid, so domain whitelisting is still enforced.
    const dnsServers = config.dnsServers || DEFAULT_DNS_SERVERS;
    const apiProxyIp = config.enableApiProxy ? networkConfig.proxyIp : undefined;
    // When DoH is enabled, the DoH proxy needs direct HTTPS access to the resolver
    const dohProxyIp = config.dnsOverHttps ? DOH_PROXY_IP : undefined;
    const hostAccess: HostAccessConfig | undefined = config.enableHostAccess
      ? { enabled: true, allowHostPorts: config.allowHostPorts, allowHostServicePorts: config.allowHostServicePorts }
      : undefined;
    // When DIFC proxy is enabled, allow cli-proxy container to reach the host gateway
    // on the DIFC proxy port (e.g., 18443)
    let cliProxyConfig: CliProxyHostConfig | undefined;
    if (config.difcProxyHost) {
      const { port } = parseDifcProxyHost(config.difcProxyHost);
      cliProxyConfig = { ip: CLI_PROXY_IP, difcProxyPort: parseInt(port, 10) };
    }
    await dependencies.setupHostIptables(networkConfig.squidIp, 3128, dnsServers, apiProxyIp, dohProxyIp, hostAccess, cliProxyConfig);
    onHostIptablesSetup?.();
  }

  // Step 1: Write configuration files
  logger.info('Generating configuration files...');
  await dependencies.writeConfigs(config);

  // Step 2: Start containers.
  //
  // In network-isolation (topology) mode with topology-attach peers, use a phased
  // startup to break the ordering deadlock: the cli-proxy liveness probe requires
  // the external DIFC peer to be reachable on awf-net, but the peer is only joined
  // to awf-net after startContainers() returns — a circular dependency that causes
  // EAI_AGAIN → fail-fast → agent never invoked.
  //
  // Fix: pass an onNetworkReady hook so startContainers() can:
  //   1. Start squid-proxy alone (creates awf-net, no health-gated dependents).
  //   2. Invoke onNetworkReady() — attaches the topology peers to awf-net.
  //   3. Run the full docker compose up — cli-proxy probe resolves the peer.
  //
  // Non-topology runs (no onNetworkReady) keep the existing single-up path.
  const onNetworkReady =
    config.networkIsolation &&
    config.topologyAttach &&
    config.topologyAttach.length > 0 &&
    dependencies.connectTopologyContainers
      ? async () => {
          logger.info(`Attaching ${config.topologyAttach!.length} trusted container(s) to the internal network...`);
          await dependencies.connectTopologyContainers!(TOPOLOGY_NETWORK_NAME, config.topologyAttach!);
        }
      : undefined;

  try {
    await dependencies.startContainers(config.workDir, config.allowedDomains, config.proxyLogsDir, config.skipPull, onNetworkReady);
  } catch (startError) {
    // Signal that containers may have been partially created so the caller's
    // cleanup (stopContainers / docker compose down -v) will tear them down
    // instead of leaving orphaned containers and networks.
    onContainersStarted?.();

    // Collect diagnostics for startup failures before containers are torn down.
    // Must happen before performCleanup() / stopContainers() destroys them.
    if (config.diagnosticLogs && dependencies.collectDiagnosticLogs) {
      try {
        await dependencies.collectDiagnosticLogs(config.workDir);
      } catch (diagError) {
        logger.warn('Failed to collect diagnostic logs; continuing with cleanup.', diagError);
      }
    }
    throw startError;
  }
  onContainersStarted?.();

  // Step 3: Wait for agent to complete
  const result = await dependencies.runAgentCommand(config.workDir, config.allowedDomains, config.proxyLogsDir, config.agentTimeout);

  // Step 3.5: Collect diagnostic logs before containers are stopped
  // Must run BEFORE performCleanup() which calls docker compose down -v.
  if (config.diagnosticLogs && result.exitCode !== 0 && dependencies.collectDiagnosticLogs) {
    try {
      await dependencies.collectDiagnosticLogs(config.workDir);
    } catch (error) {
      logger.warn('Failed to collect diagnostic logs; continuing with cleanup.', error);
    }
  }

  // Step 4: Cleanup (logs will be preserved automatically if they exist)
  await performCleanup();

  if (result.exitCode === 0) {
    logger.success('Command completed successfully');
  } else {
    logger.warn(`Command completed with exit code: ${result.exitCode}`);
  }

  return result.exitCode;
}
