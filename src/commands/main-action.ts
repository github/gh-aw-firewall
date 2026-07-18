import * as fs from 'fs';
import * as path from 'path';
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
import { assertTopologySupported, connectTopologyContainers } from '../topology';
import { runDindBootstrap } from '../dind-bootstrap';
import { runtimeUsesComposeAgent } from '../container-runtime';
import { createSandbox, execInSandbox, removeSandbox, isSbxAvailable, SBX_DEFAULT_NAME } from '../sbx-manager';
import type { WrapperConfig } from '../types';
import { buildAgentEnvironment } from '../services/agent-service';
import { buildAgentCredentialEnv } from '../services/api-proxy-credential-env';
import { DEFAULT_DNS_SERVERS } from '../dns-resolver';
import { AGENT_IP, CLI_PROXY_IP, DOH_PROXY_IP, NETWORK_SUBNET, SQUID_IP } from '../host-iptables-shared';

/** Report whether a secret is set (and its length) without exposing the value. */
function redactSecret(value: string | undefined): string {
  if (!value) return '(unset)';
  return `(set, len=${value.length})`;
}

const SENSITIVE_CONFIG_KEYS = new Set([
  'openaiApiKey',
  'anthropicApiKey',
  'copilotGithubToken',
  'copilotProviderApiKey',
  'geminiApiKey',
  'googleApiKey',
  'githubToken',
]);

function redactConfigForLogging(config: WrapperConfig): Record<string, unknown> {
  const redactedConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SENSITIVE_CONFIG_KEYS.has(key)) continue;

    if (key === 'agentCommand') {
      redactedConfig[key] = redactSecrets(value as string);
      continue;
    }

    if (key === 'additionalEnv' && value && typeof value === 'object') {
      redactedConfig[key] = Object.fromEntries(
        Object.keys(value as Record<string, string>).map((envKey) => [envKey, '[REDACTED]']),
      );
      continue;
    }

    redactedConfig[key] = value;
  }
  return redactedConfig;
}

function persistConfigAuditArtifact(
  config: WrapperConfig,
  redactedConfig: Record<string, unknown>,
): void {
  try {
    const configArtifactDir = config.auditDir || path.join(config.workDir, 'audit');
    fs.mkdirSync(configArtifactDir, { recursive: true, mode: 0o700 });
    const configArtifactPath = path.join(configArtifactDir, 'awf-resolved-config.json');
    const fd = fs.openSync(configArtifactPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(redactedConfig, null, 2) + '\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    logger.debug(`Failed to write resolved config artifact: ${err}`);
  }
}

function buildCleanupFn(
  config: WrapperConfig,
  getContainersStarted: () => boolean,
  getHostIptablesSetup: () => boolean,
) {
  return async (signal?: string) => {
    if (signal) {
      logger.info(`Received ${signal}, cleaning up...`);
    }

    // Clean up sbx sandbox if using microVM runtime
    if (!runtimeUsesComposeAgent(config.containerRuntime) && !config.keepContainers) {
      try {
        await removeSandbox(SBX_DEFAULT_NAME);
      } catch {
        // Sandbox may not exist yet — that's fine
      }
    }

    // Copy iptables audit BEFORE stopping containers (volumes are destroyed by `docker compose down -v`)
    if (getContainersStarted()) {
      preserveIptablesAudit(config.workDir, config.auditDir);
      await stopContainers(config.workDir, config.keepContainers);
    }

    if (getHostIptablesSetup() && !config.keepContainers) {
      await cleanupHostIptables();
    }

    if (!config.keepContainers) {
      await cleanup(
        config.workDir,
        false,
        config.proxyLogsDir,
        config.auditDir,
        config.sessionStateDir,
        config.dockerHostPathPrefix,
        config.imageRegistry,
        config.imageTag,
        config.agentImage,
      );
      // Note: We don't remove the firewall network here since it can be reused
      // across multiple runs. Cleanup script will handle removal if needed.
    } else {
      logger.info(`Configuration files preserved at: ${config.workDir}`);
      logger.info(`Agent logs available at: ${config.workDir}/agent-logs/`);
      logger.info(`Squid logs available at: ${config.workDir}/squid-logs/`);
      logger.info(`Host iptables rules preserved (--keep-containers enabled)`);
    }
  };
}

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

    await runDindBootstrap(config);
  }

  // Log config with redacted secrets - remove API keys entirely
  // to prevent sensitive data from flowing to logger (CodeQL sensitive data logging)
  const redactedConfig = redactConfigForLogging(config);
  logger.debug('Configuration:', JSON.stringify(redactedConfig, null, 2));
  persistConfigAuditArtifact(config, redactedConfig);

  logger.info(`Allowed domains: ${config.allowedDomains.join(', ')}`);
  if (config.blockedDomains && config.blockedDomains.length > 0) {
    logger.info(`Blocked domains: ${config.blockedDomains.join(', ')}`);
  }
  logger.debug(`DNS servers: ${(config.dnsServers ?? []).join(', ')}`);


  let exitCode = 0;
  let containersStarted = false;
  let hostIptablesSetup = false;

  const performCleanup = buildCleanupFn(
    config,
    () => containersStarted,
    () => hostIptablesSetup,
  );

  // Register signal handlers for graceful shutdown
  registerSignalHandlers({
    getContainersStarted: () => containersStarted,
    keepContainers: config.keepContainers,
    fastKillAgentContainer,
    performCleanup,
  });

  try {
    // For sbx (microVM) runtime, wrap startContainers and runAgentCommand
    // to launch the agent in a sandbox instead of Docker Compose.
    const useSbx = !runtimeUsesComposeAgent(config.containerRuntime);
    let sbxName: string | undefined;
    let sbxEnvironment: Record<string, string> | undefined;

    const sbxStartContainers = useSbx
      ? async (workDir: string, allowedDomains: string[], proxyLogsDir?: string, skipPull?: boolean, onNetworkReady?: () => Promise<void>) => {
          // Start infra-only compose (squid, api-proxy — no agent service)
          await startContainers(workDir, allowedDomains, proxyLogsDir, skipPull, onNetworkReady);

          // Verify sbx is available
          if (!await isSbxAvailable()) {
            throw new Error('Docker sbx CLI not found. Install sbx to use --container-runtime sbx.');
          }

          // For sbx, the microVM can't reach Docker internal IPs (172.30.0.x).
          // Published Squid port (3128) is accessible via the sbx gateway IP.
          // The api-proxy is on the awf-ext bridge network and reachable from
          // inside the sbx via `host.docker.internal` (resolves to the docker0
          // bridge IP, typically 172.17.0.1).
          const SBX_GATEWAY_IP = '172.17.0.0';
          const SBX_HOST_DOCKER_INTERNAL = 'host.docker.internal';

          sbxEnvironment = buildAgentEnvironment({
            config,
            networkConfig: {
              subnet: NETWORK_SUBNET,
              squidIp: SBX_GATEWAY_IP,
              agentIp: AGENT_IP,
              proxyIp: config.enableApiProxy ? SBX_HOST_DOCKER_INTERNAL : undefined,
              dohProxyIp: config.dnsOverHttps ? DOH_PROXY_IP : undefined,
              cliProxyIp: config.difcProxyHost ? CLI_PROXY_IP : undefined,
            },
            dnsServers: config.dnsServers || DEFAULT_DNS_SERVERS,
          });

          // Merge credential isolation env vars (COPILOT_API_URL, COPILOT_PROVIDER_BASE_URL, etc.)
          // In Docker mode these are merged by assembleOptionalServices during compose generation.
          // For sbx, we call buildAgentCredentialEnv directly with host.docker.internal
          // as the proxy target (the api-proxy is on the awf-ext bridge network).
          if (config.enableApiProxy) {
            const credentialEnv = buildAgentCredentialEnv({
              config,
              networkConfig: {
                subnet: NETWORK_SUBNET,
                squidIp: SBX_GATEWAY_IP,
                agentIp: AGENT_IP,
                proxyIp: SBX_HOST_DOCKER_INTERNAL,
              },
            });
            Object.assign(sbxEnvironment, credentialEnv);
          }

          // Log critical env vars for debugging auth flow (redact secret values)
          logger.info(`[sbx-env] COPILOT_API_URL=${sbxEnvironment.COPILOT_API_URL || '(unset)'}`);
          logger.info(`[sbx-env] COPILOT_PROVIDER_BASE_URL=${sbxEnvironment.COPILOT_PROVIDER_BASE_URL || '(unset)'}`);
          logger.info(`[sbx-env] COPILOT_GITHUB_TOKEN=${redactSecret(sbxEnvironment.COPILOT_GITHUB_TOKEN)}`);
          logger.info(`[sbx-env] COPILOT_API_KEY=${redactSecret(sbxEnvironment.COPILOT_API_KEY)}`);
          logger.info(`[sbx-env] HTTPS_PROXY=${sbxEnvironment.HTTPS_PROXY || '(unset)'}`);
          logger.info(`[sbx-env] COPILOT_PROVIDER_API_KEY=${redactSecret(sbxEnvironment.COPILOT_PROVIDER_API_KEY)}`);

          // Create the sandbox with configured mounts, proxy chaining through Squid
          const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
          sbxName = await createSandbox({
            workspaceDir,
            squidIp: SQUID_IP,
            extraMounts: config.volumeMounts,
          });

          // Wait for api-proxy to be healthy before launching agent.
          // In Docker mode, depends_on: service_healthy gates this; for sbx we poll
          // via host.docker.internal which resolves to the docker0 bridge from the VM.
          if (config.enableApiProxy) {
            logger.info('[sbx] Polling api-proxy health via host.docker.internal...');
            const healthCmd = [
              'for i in $(seq 1 30); do',
              `  if curl -sf --max-time 2 http://${SBX_HOST_DOCKER_INTERNAL}:10000/health >/dev/null 2>&1; then`,
              '    echo "api-proxy healthy after ${i}s"; exit 0;',
              '  fi;',
              '  sleep 1;',
              'done;',
              'echo "api-proxy health timeout"; exit 1',
            ].join(' ');

            const healthResult = await execInSandbox(sbxName, healthCmd, {
              timeoutMinutes: 1,
              workDir: config.containerWorkDir,
              environment: sbxEnvironment,
            });
            if (healthResult.exitCode !== 0) {
              logger.warn('[sbx] api-proxy health check failed — proceeding anyway');
            }
          }

          // Verify squid proxy is reachable from sandbox
          logger.info('[sbx-diag] Verifying squid proxy connectivity...');
          const diagCmd = [
            `echo -n "squid ${SBX_GATEWAY_IP}:3128 → "`,
            `curl -sS --max-time 5 --proxy "http://${SBX_GATEWAY_IP}:3128" -o /dev/null -w "%{http_code}" https://api.github.com/ 2>&1`,
            'echo ""',
          ].join(' && ');

          const diagResult = await execInSandbox(sbxName, diagCmd, {
            timeoutMinutes: 1,
            workDir: config.containerWorkDir,
            environment: sbxEnvironment,
          });
          logger.info(`[sbx-diag] Connectivity check exited with code ${diagResult.exitCode}`);
        }
      : startContainers;

    const sbxRunAgentCommand = useSbx
      ? async (_workDir: string, _allowedDomains: string[], _proxyLogsDir?: string, agentTimeoutMinutes?: number) => {
          if (!sbxName) throw new Error('Sandbox not created');
          logger.info(`[sbx] Launching agent command in sandbox "${sbxName}" (timeout: ${agentTimeoutMinutes ?? 'none'} min)`);
          logger.debug(`[sbx] Agent command: ${config.agentCommand.substring(0, 200)}...`);
          const result = await execInSandbox(sbxName, config.agentCommand, {
            timeoutMinutes: agentTimeoutMinutes,
            workDir: config.containerWorkDir,
            environment: sbxEnvironment,
            tty: config.tty,
          });
          logger.info(`[sbx] Agent command exited with code ${result.exitCode}`);

          // Dump api-proxy logs for debugging connection issues
          if (config.enableApiProxy && result.exitCode !== 0) {
            try {
              const { execSync } = await import('child_process');
              const proxyLogs = execSync('docker logs --tail 80 awf-api-proxy 2>&1', { encoding: 'utf-8', timeout: 10000 });
              logger.info(`[sbx-diag] api-proxy logs:\n${proxyLogs}`);
              const healthStatus = execSync('docker inspect --format={{.State.Health.Status}} awf-api-proxy 2>&1', { encoding: 'utf-8', timeout: 5000 });
              logger.info(`[sbx-diag] api-proxy health status: ${healthStatus.trim()}`);
            } catch { /* ignore diagnostic failures */ }
          }

          return { exitCode: result.exitCode, blockedDomains: [] as string[] };
        }
      : runAgentCommand;

    exitCode = await runMainWorkflow(
      config,
      {
        ensureFirewallNetwork,
        setupHostIptables,
        writeConfigs,
        startContainers: sbxStartContainers,
        runAgentCommand: sbxRunAgentCommand,
        collectDiagnosticLogs,
        assertTopologySupported,
        connectTopologyContainers,
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

/** @internal Exposed for unit tests. */
// ts-prune-ignore-next
export const testHelpers = {
  redactConfigForLogging,
  persistConfigAuditArtifact,
  buildCleanupFn,
};
