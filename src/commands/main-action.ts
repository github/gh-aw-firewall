import { logger } from '../logger';
import {
  writeConfigs,
  startContainers,
  runAgentCommand,
  stopContainers,
  cleanup,
  preserveIptablesAudit,
  fastKillAgentContainer,
  collectDiagnosticLogs,
  setAwfDockerHost,
} from '../docker-manager';
import {
  ensureFirewallNetwork,
  setupHostIptables,
  cleanupHostIptables,
} from '../host-iptables';
import { runMainWorkflow } from '../cli-workflow';
import { redactSecrets } from '../redact-secrets';
import { joinShellArgs } from '../option-parsers';
import { applyConfigFilePrecedence } from './preflight';
import { registerSignalHandlers } from './signal-handler';
import { validateOptions } from './validate-options';
import { probeSplitFilesystem } from '../dind-probe';

/**
 * Resolves the Commander option-value source for a given option name.
 * Injected to decouple the action handler from the global program instance,
 * enabling independent unit testing.
 */
type OptionSourceResolver = (optionName: string) => string | undefined;

/**
 * Creates the main `awf` action handler bound to a specific option-source
 * resolver (typically `program.getOptionValueSource.bind(program)`).
 *
 * @param getOptionValueSource - Resolves the Commander source for a flag name
 */
export function createMainAction(getOptionValueSource: OptionSourceResolver) {
  return async function mainAction(args: string[], options: Record<string, unknown>): Promise<void> {
  // Require -- separator for passing command arguments
  if (args.length === 0) {
    console.error('Error: No command specified. Use -- to separate command from options.');
    console.error('Example: awf --allow-domains github.com -- curl https://api.github.com');
    process.exit(1);
  }

  // Command argument handling:
  //
  // SINGLE ARGUMENT (complete shell command):
  //   When a single argument is passed, it's treated as a complete shell
  //   command string. This is CRITICAL for preserving shell variables ($HOME,
  //   $(command), etc.) that must expand in the container, not on the host.
  //
  //   Example: awf -- 'echo $HOME'
  //   → args = ['echo $HOME']  (single element)
  //   → Passed as-is: 'echo $HOME'
  //   → Docker Compose: 'echo $$HOME' (escaped for YAML)
  //   → Container shell: 'echo $HOME' (expands to container home)
  //
  // MULTIPLE ARGUMENTS (shell-parsed by user's shell):
  //   When multiple arguments are passed, each is shell-escaped and joined.
  //   This happens when the user doesn't quote the command.
  //
  //   Example: awf -- curl -H "Auth: token" https://api.github.com
  //   → args = ['curl', '-H', 'Auth: token', 'https://api.github.com']
  //   → joinShellArgs(): curl -H 'Auth: token' https://api.github.com
  //
  // Why not use shell-quote library?
  // - shell-quote expands variables on the HOST ($HOME → /home/hostuser)
  // - We need variables to expand in CONTAINER ($HOME → /root or /home/runner)
  // - The $$$$  escaping pattern requires literal $ preservation
  //
  const agentCommand = args.length === 1 ? args[0] : joinShellArgs(args);

  applyConfigFilePrecedence(options as Record<string, unknown>, getOptionValueSource);

  // Validate all options and assemble the config.
  // Calls process.exit(1) on any validation failure.
  const config = validateOptions(options as Record<string, unknown>, agentCommand);

  // Apply --docker-host override for AWF's own container operations.
  // This must be called before startContainers/stopContainers/runAgentCommand.
  setAwfDockerHost(config.awfDockerHost);

  // Auto-detect split filesystem in DinD environments when no explicit prefix is set.
  // This probe runs a lightweight container to check if the daemon can see runner paths.
  if (!config.dockerHostPathPrefix) {
    const probeResult = await probeSplitFilesystem(config.workDir);
    if (probeResult.prefix) {
      config.dockerHostPathPrefix = probeResult.prefix;
      logger.info(`Auto-applied --docker-host-path-prefix ${probeResult.prefix} (DinD split filesystem detected)`);
    } else if (probeResult.splitDetected) {
      logger.warn(
        '⚠️  Split runner/daemon filesystem detected but no known prefix worked. ' +
        'Set --docker-host-path-prefix manually if bind mounts fail.',
      );
    }
  }

  // Log config with redacted secrets - remove API keys entirely
  // to prevent sensitive data from flowing to logger (CodeQL sensitive data logging)
  const redactedConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (
      key === 'openaiApiKey' ||
      key === 'anthropicApiKey' ||
      key === 'copilotGithubToken' ||
      key === 'copilotProviderApiKey' ||
      key === 'geminiApiKey'
    ) continue;
    redactedConfig[key] = key === 'agentCommand' ? redactSecrets(value as string) : value;
  }
  logger.debug('Configuration:', JSON.stringify(redactedConfig, null, 2));
  logger.info(`Allowed domains: ${config.allowedDomains.join(', ')}`);
  if (config.blockedDomains && config.blockedDomains.length > 0) {
    logger.info(`Blocked domains: ${config.blockedDomains.join(', ')}`);
  }
  logger.debug(`DNS servers: ${(config.dnsServers ?? []).join(', ')}`);


  let exitCode = 0;
  let containersStarted = false;
  let hostIptablesSetup = false;

  // Handle cleanup on process exit
  const performCleanup = async (signal?: string) => {
    if (signal) {
      logger.info(`Received ${signal}, cleaning up...`);
    }

    // Copy iptables audit BEFORE stopping containers (volumes are destroyed by `docker compose down -v`)
    if (containersStarted) {
      preserveIptablesAudit(config.workDir, config.auditDir);
      await stopContainers(config.workDir, config.keepContainers);
    }

    if (hostIptablesSetup && !config.keepContainers) {
      await cleanupHostIptables();
    }

    if (!config.keepContainers) {
      await cleanup(config.workDir, false, config.proxyLogsDir, config.auditDir, config.sessionStateDir);
      // Note: We don't remove the firewall network here since it can be reused
      // across multiple runs. Cleanup script will handle removal if needed.
    } else {
      logger.info(`Configuration files preserved at: ${config.workDir}`);
      logger.info(`Agent logs available at: ${config.workDir}/agent-logs/`);
      logger.info(`Squid logs available at: ${config.workDir}/squid-logs/`);
      logger.info(`Host iptables rules preserved (--keep-containers enabled)`);
    }
  };

  // Register signal handlers for graceful shutdown
  registerSignalHandlers({
    getContainersStarted: () => containersStarted,
    keepContainers: config.keepContainers,
    fastKillAgentContainer,
    performCleanup,
  });

  try {
    exitCode = await runMainWorkflow(
      config,
      {
        ensureFirewallNetwork,
        setupHostIptables,
        writeConfigs,
        startContainers,
        runAgentCommand,
        collectDiagnosticLogs,
      },
      {
        logger,
        performCleanup,
        onHostIptablesSetup: () => {
          hostIptablesSetup = true;
        },
        onContainersStarted: () => {
          containersStarted = true;
        },
      }
    );

    console.error(`Process exiting with code: ${exitCode}`);
    process.exit(exitCode);
  } catch (error) {
    logger.error('Fatal error:', error);
    await performCleanup();
    console.error(`Process exiting with code: 1`);
    process.exit(1);
  }
  };
}
