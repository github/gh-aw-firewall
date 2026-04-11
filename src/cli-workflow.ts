import { WrapperConfig } from './types';
import { HostAccessConfig, CliProxyHostConfig } from './host-iptables';
import { DEFAULT_DNS_SERVERS } from './dns-resolver';
import { parseDifcProxyHost } from './docker-manager';

export interface WorkflowDependencies {
  ensureFirewallNetwork: () => Promise<{ squidIp: string; agentIp: string; proxyIp: string; subnet: string }>;
  setupHostIptables: (squidIp: string, port: number, dnsServers: string[], apiProxyIp?: string, dohProxyIp?: string, hostAccess?: HostAccessConfig, cliProxyConfig?: CliProxyHostConfig) => Promise<void>;
  writeConfigs: (config: WrapperConfig) => Promise<void>;
  startContainers: (workDir: string, allowedDomains: string[], proxyLogsDir?: string, skipPull?: boolean) => Promise<void>;
  runAgentCommand: (
    workDir: string,
    allowedDomains: string[],
    proxyLogsDir?: string,
    agentTimeoutMinutes?: number
  ) => Promise<{ exitCode: number }>;
  collectDiagnosticLogs?: (workDir: string) => Promise<void>;
}

export interface WorkflowCallbacks {
  onHostIptablesSetup?: () => void;
  onContainersStarted?: () => void;
}

export interface WorkflowLogger {
  info: (message: string, ...args: unknown[]) => void;
  success: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

export interface WorkflowOptions extends WorkflowCallbacks {
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
  logger.info('Setting up host-level firewall network and iptables rules...');
  const networkConfig = await dependencies.ensureFirewallNetwork();
  // When API proxy is enabled, allow agent→sidecar traffic at the host level.
  // The sidecar itself routes through Squid, so domain whitelisting is still enforced.
  const dnsServers = config.dnsServers || DEFAULT_DNS_SERVERS;
  const apiProxyIp = config.enableApiProxy ? networkConfig.proxyIp : undefined;
  // When DoH is enabled, the DoH proxy needs direct HTTPS access to the resolver
  const dohProxyIp = config.dnsOverHttps ? '172.30.0.40' : undefined;
  const hostAccess: HostAccessConfig | undefined = config.enableHostAccess
    ? { enabled: true, allowHostPorts: config.allowHostPorts, allowHostServicePorts: config.allowHostServicePorts }
    : undefined;
  // When DIFC proxy is enabled, allow cli-proxy container to reach the host gateway
  // on the DIFC proxy port (e.g., 18443)
  let cliProxyConfig: CliProxyHostConfig | undefined;
  if (config.difcProxyHost) {
    const { port } = parseDifcProxyHost(config.difcProxyHost);
    cliProxyConfig = { ip: '172.30.0.50', difcProxyPort: parseInt(port, 10) };
  }
  await dependencies.setupHostIptables(networkConfig.squidIp, 3128, dnsServers, apiProxyIp, dohProxyIp, hostAccess, cliProxyConfig);
  onHostIptablesSetup?.();

  // Step 1: Write configuration files
  logger.info('Generating configuration files...');
  await dependencies.writeConfigs(config);

  // Step 2: Start containers
  await dependencies.startContainers(config.workDir, config.allowedDomains, config.proxyLogsDir, config.skipPull);
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
