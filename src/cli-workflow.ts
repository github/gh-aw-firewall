import { WrapperConfig } from './types';

export interface WorkflowDependencies {
  ensureFirewallNetwork: () => Promise<{ squidIp: string; agentIp: string; proxyIp: string; subnet: string }>;
  setupHostIptables: (squidIp: string, port: number, apiProxyIp?: string) => Promise<void>;
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
  // When API proxy is enabled, allow agent→sidecar traffic at the host level.
  // The sidecar itself routes through Squid, so domain whitelisting is still enforced.
  const apiProxyIp = config.enableApiProxy ? networkConfig.proxyIp : undefined;
  await dependencies.setupHostIptables(networkConfig.squidIp, 3128, apiProxyIp);
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
