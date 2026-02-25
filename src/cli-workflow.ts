import { WrapperConfig } from './types';

export interface WorkflowDependencies {
  ensureFirewallNetwork: () => Promise<{ squidIp: string; agentIp: string; subnet: string }>;
  setupHostIptables: (squidIp: string, port: number, dnsServers: string[], apiProxyEnabled?: boolean) => Promise<void>;
  writeConfigs: (config: WrapperConfig) => Promise<void>;
  startContainers: (workDir: string, allowedDomains: string[], proxyLogsDir?: string, skipPull?: boolean) => Promise<void>;
  runAgentCommand: (
    workDir: string,
    allowedDomains: string[],
    proxyLogsDir?: string
  ) => Promise<{ exitCode: number }>;
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
  const dnsServers = config.dnsServers || ['8.8.8.8', '8.8.4.4'];
  // When API proxy is enabled, allow agent→auth proxy traffic at the host level.
  // The auth proxy is embedded in the Squid container and routes through Squid internally.
  const apiProxyEnabled = config.enableApiProxy || false;
  await dependencies.setupHostIptables(networkConfig.squidIp, 3128, dnsServers, apiProxyEnabled);
  onHostIptablesSetup?.();

  // Step 1: Write configuration files
  logger.info('Generating configuration files...');
  await dependencies.writeConfigs(config);

  // Step 2: Start containers
  await dependencies.startContainers(config.workDir, config.allowedDomains, config.proxyLogsDir, config.skipPull);
  onContainersStarted?.();

  // Step 3: Wait for agent to complete
  const result = await dependencies.runAgentCommand(config.workDir, config.allowedDomains, config.proxyLogsDir);

  // Step 4: Cleanup (logs will be preserved automatically if they exist)
  await performCleanup();

  if (result.exitCode === 0) {
    logger.success('Command completed successfully');
  } else {
    logger.warn(`Command completed with exit code: ${result.exitCode}`);
  }

  return result.exitCode;
}
