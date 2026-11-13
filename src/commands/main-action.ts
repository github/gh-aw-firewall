import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../logger';
import { assertPersistentDebugArtifactsIsolated } from '../enclave/mount-policy';
import {
  writeConfigs,
  startContainers,
  runAgentCommand,
  fastKillAgentContainer,
  collectDiagnosticLogs,
  setAwfDockerHost,
} from '../docker-manager';
import {
  ensureFirewallNetwork,
  setupHostIptables,
} from '../host-iptables';
import { runMainWorkflow } from '../cli-workflow';
import { joinShellArgs } from '../option-parsers';
import { applyConfigFilePrecedence } from './preflight';
import { registerSignalHandlers } from './signal-handler';
import { validateOptions } from './validate-options';
import { probeSplitFilesystem } from '../dind-probe';
import { assertTopologySupported, connectTopologyContainers } from '../topology';
import { runDindBootstrap } from '../dind-bootstrap';
import { adaptExternalRuntimeBackend } from '../external-runtime-backend';
import { createDockerHarnessObservation } from '../docker-harness-observation';
import { harnessContext } from '../harness-observation';
import type { ExternalAgentRuntimeBackend } from '../external-runtime-backend';
import { resolveExternalRuntimeBackend } from '../external-runtime-backend-resolver';
import { prepareEnclaves } from '../enclave/manager';
import {
  startEnclaveDynamicDelegation,
} from '../enclave/dynamic-delegation';
import { takeStaticGithubExecutorCapability } from '../enclave/static-github-handoff';
import { withEarlyStartupDiagnostics } from '../logs/early-startup-diagnostics';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import {
  initializeEnclaveStartupProgress,
  updateEnclaveStartupProgress,
} from '../enclave/startup-progress';
import {
  assertEnclaveGatewayReady,
  connectEnclaveGateway,
} from '../enclave/gateway';
import {
  assertEnclaveGithubGatewayReady,
  connectEnclaveGithubGateway,
} from '../enclave/github-gateway';
import {
  prepareProtectedCommandOutputCapture,
  type ProtectedCommandOutputCapture,
} from '../protected-command-output-capture';
import {
  formatCloudHypervisorDockerFallbackWarning,
  isCloudHypervisorUnsupportedHostError,
} from '../cloud-hypervisor/errors';
import {
  cleanupRoutingState,
  RoutingFailureExitError,
  stageRoutingConversation,
  verifyRoutingCompletion,
  waitForRoutingSelection,
} from '../routing/bootstrap';

import { persistConfigAuditArtifact, redactConfigForLogging } from './main-action-audit';
import { buildCleanupFn } from './main-action-cleanup';
import {
  writeStartupFailureDiagnostic,
  emitStartupExitMarker,
  startupElapsedBucket,
  writeIncompleteEnclaveAuditMarker,
  type StartupDiagnosticWriteOutcome,
  type StartupDiagnosticWriteReason,
  type StartupExitState,
} from './main-action-startup-diagnostics';

const REFLECT_COMMAND = 'curl --fail --silent --show-error --noproxy "*" http://api-proxy:10000/reflect';

function findRoutingFailure(error: unknown): RoutingFailureExitError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof RoutingFailureExitError) return current;
    seen.add(current);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return undefined;
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
  const reflect = options.reflect === true;

  // Require -- separator for passing command arguments
  if (args.length === 0 && !reflect) {
    console.error('Error: No command specified. Use -- to separate command from options.');
    console.error('Example: awf --allow-domains github.com -- curl https://api.github.com');
    process.exit(1);
  }
  if (reflect && args.length > 0) {
    console.error('Error: --reflect cannot be used with a command.');
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
  const agentCommand = reflect
    ? REFLECT_COMMAND
    : args.length === 1 ? args[0] : joinShellArgs(args);

  withEarlyStartupDiagnostics('configuration', () =>
    applyConfigFilePrecedence(options as Record<string, unknown>, getOptionValueSource));

  // Validate all options and assemble the config.
  // Calls process.exit(1) on any validation failure.
  const config = withEarlyStartupDiagnostics('validation', () =>
    validateOptions(options as Record<string, unknown>, agentCommand));
  if (config.workDir === undefined) {
    config.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-'));
  }
  if (reflect) {
    config.additionalEnv = {
      ...config.additionalEnv,
      AWF_COMMAND_STDOUT_ONLY: '1',
    };
  }

  let exitCode = 0;
  let containersStarted = false;
  let agentCommandStarted = false;
  let hostIptablesSetup = false;
  let externalRuntimeBackend: ExternalAgentRuntimeBackend | undefined;
  let commandOutputCapture: ProtectedCommandOutputCapture | undefined;
  let cloudHypervisorPrimaryPreflightPassed = false;
  let performCleanup = buildCleanupFn(
    config,
    () => containersStarted,
    () => hostIptablesSetup,
  );

  const startupExitState: StartupExitState = {
    startedAt: Date.now(), lastProgressWrite: 'not-attempted', progressWriteFailures: 0,
  };

  try {
    if (config.enclaves?.enabled) {
      takeStaticGithubExecutorCapability(config, process.env);
    }
    initializeEnclaveStartupProgress(config, () => {
      const outcome = writeStartupFailureDiagnostic(
        config, new Error('Enclave startup in progress'), 'enclave-startup-progress',
        reason => {
          startupExitState.firstProgressWriteFailure ??= reason;
          startupExitState.lastProgressWriteFailure = reason;
        },
      );
      startupExitState.lastProgressWrite = outcome;
      if (outcome !== 'written') {
        startupExitState.progressWriteFailures = Math.min(startupExitState.progressWriteFailures + 1, 999999);
      }
    });
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
    assertPersistentDebugArtifactsIsolated(config);
    commandOutputCapture = prepareProtectedCommandOutputCapture(config);
    if (commandOutputCapture) {
      config.additionalEnv = {
        ...config.additionalEnv,
        AWF_CAPTURE_COMMAND_OUTPUT: '1',
      };
    }

    // Log config with redacted secrets - remove API keys entirely
    // to prevent sensitive data from flowing to logger (CodeQL sensitive data logging)
    const redactedConfig = redactConfigForLogging(config);
    logger.debug('Configuration:', JSON.stringify(redactedConfig, null, 2));

    logger.info(`Allowed domains: ${config.allowedDomains.join(', ')}`);
    if (config.blockedDomains && config.blockedDomains.length > 0) {
      logger.info(`Blocked domains: ${config.blockedDomains.join(', ')}`);
    }
    logger.debug(`DNS servers: ${(config.dnsServers ?? []).join(', ')}`);

    updateEnclaveStartupProgress(config, { stage: 'runtime-preflight' });
    externalRuntimeBackend = resolveExternalRuntimeBackend(config, startContainers);
    performCleanup = buildCleanupFn(
      config,
      () => containersStarted,
      () => hostIptablesSetup,
      externalRuntimeBackend,
    );

    // Register signal handlers for graceful shutdown
    registerSignalHandlers({
      getContainersStarted: () => containersStarted,
      keepContainers: config.keepContainers,
      fastKillAgentContainer: async () => {
        if (externalRuntimeBackend) {
          await externalRuntimeBackend.stop();
        } else {
          await fastKillAgentContainer();
        }
        if (commandOutputCapture) {
          if (agentCommandStarted) {
            await commandOutputCapture.waitForCommandCompletion();
          } else {
            commandOutputCapture.finishCommand(undefined, 'cancelled');
          }
        }
      },
      performCleanup: async (signal) => {
        try {
          await performCleanup(signal);
          commandOutputCapture?.setTeardown('complete');
        } catch (error) {
          commandOutputCapture?.setTeardown('failed');
          throw error;
        } finally {
          if (signal) {
            commandOutputCapture?.finishCommand(
              undefined,
              config.keepContainers && agentCommandStarted ? 'interrupted' : 'cancelled',
            );
          }
          commandOutputCapture?.close();
        }
      },
      cleanupRouting: () => cleanupRoutingState(config),
    });

    if (externalRuntimeBackend) {
      try {
        if (config.enclaves?.enabled && externalRuntimeBackend.runtime === 'cloud-hypervisor') {
          const checks = new HostPreflightReporter('enclave-runtime', (hostPreflight) =>
            updateEnclaveStartupProgress(config, { hostPreflight }));
          await checks.check('primary-runtime', () => externalRuntimeBackend!.preflight());
          cloudHypervisorPrimaryPreflightPassed = true;
        } else {
          await externalRuntimeBackend.preflight();
        }
      } catch (error) {
        if (
          externalRuntimeBackend.runtime === 'cloud-hypervisor' &&
          !config.enclaves?.enabled &&
          isCloudHypervisorUnsupportedHostError(error)
        ) {
          logger.warn(formatCloudHypervisorDockerFallbackWarning(error));
          config.containerRuntime = undefined;
          config.cloudHypervisor = undefined;
          externalRuntimeBackend = undefined;
          performCleanup = buildCleanupFn(
            config,
            () => containersStarted,
            () => hostIptablesSetup,
          );
        } else {
          throw error;
        }
      }
    }

    // Persist only after preflight so the audit artifact records the effective
    // runtime when an unsupported Cloud Hypervisor host falls back to Docker.
    persistConfigAuditArtifact(config, redactConfigForLogging(config));

    const externalWorkflowDependencies = externalRuntimeBackend
      ? adaptExternalRuntimeBackend(externalRuntimeBackend)
      : undefined;
    const dockerHarness = externalRuntimeBackend
      ? undefined : createDockerHarnessObservation(config, harnessContext(config));
    const workflowRunAgentCommand = externalWorkflowDependencies?.runAgentCommand
      ?? ((
        workDir: string,
        allowedDomains: string[],
        proxyLogsDir?: string,
        agentTimeoutMinutes?: number,
        capture?: ProtectedCommandOutputCapture,
      ) => capture
        ? runAgentCommand(
          workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, config.containerRuntime, capture,
        )
        : runAgentCommand(
          workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, config.containerRuntime,
        ));
    const trackedRunAgentCommand = async (
      workDir: string,
      allowedDomains: string[],
      proxyLogsDir?: string,
      agentTimeoutMinutes?: number,
      capture?: ProtectedCommandOutputCapture,
    ) => {
      agentCommandStarted = true;
      const result = capture
        ? await workflowRunAgentCommand(
          workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, capture,
        )
        : await workflowRunAgentCommand(workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes);
      if (result.exitCode !== 0) {
        emitStartupExitMarker(config, startupExitState, {
          path: 'workflow-return', exitCode: result.exitCode, containersStarted,
          agentStarted: agentCommandStarted, recordWrite: 'not-attempted', cleanup: 'pending',
        });
      }
      return result;
    };
    const diagnosticRuntimeBackend = externalRuntimeBackend;
    const workflowCollectDiagnosticLogs = diagnosticRuntimeBackend
      ? async (workDir: string): Promise<void> => {
         const results = await Promise.allSettled([
           diagnosticRuntimeBackend.collectDiagnostics(),
           collectDiagnosticLogs(workDir),
         ]);
         const failures = results.filter(
           (result): result is PromiseRejectedResult => result.status === 'rejected',
         );
         if (failures.length > 0) {
           throw new Error(
             failures.map((failure) => (
               failure.reason instanceof Error
                 ? failure.reason.message
                 : String(failure.reason)
             )).join('; '),
           );
         }
        }
      : collectDiagnosticLogs;

    exitCode = await runMainWorkflow(
      config,
      {
        ensureFirewallNetwork,
        setupHostIptables,
        writeConfigs,
        probeHarness: externalRuntimeBackend?.probeHarness?.bind(externalRuntimeBackend) ?? dockerHarness?.probeHarness,
        releaseHarness: dockerHarness?.releaseHarness,
        startContainers: externalWorkflowDependencies?.startContainers ?? startContainers,
        runAgentCommand: trackedRunAgentCommand,
        collectDiagnosticLogs: workflowCollectDiagnosticLogs,
        assertTopologySupported,
        connectTopologyContainers,
        connectEnclaveGateway,
        assertEnclaveGatewayReady,
        connectEnclaveGithubGateway,
        assertEnclaveGithubGatewayReady,
        prepareEnclaves: config.enclaves?.enabled
          && externalRuntimeBackend?.runtime === 'cloud-hypervisor'
          ? async (candidate) => {
            if (candidate !== config) {
              throw new Error('Cloud Hypervisor primary runtime preflight evidence is unavailable for this run');
            }
            return prepareEnclaves(candidate, {
              assertCloudHypervisorPrimaryPreflight: async (preflightConfig) => {
                if (
                  preflightConfig !== config
                  || config.containerRuntime !== 'cloud-hypervisor'
                  || externalRuntimeBackend?.runtime !== 'cloud-hypervisor'
                  || !cloudHypervisorPrimaryPreflightPassed
                ) {
                  throw new Error('Cloud Hypervisor primary runtime preflight evidence is unavailable for this run');
                }
              },
            });
          }
          : prepareEnclaves,
        startEnclaveDynamicDelegation,
        prepareRouting: async (routingConfig) => stageRoutingConversation(routingConfig),
        waitForRoutingSelection,
        verifyRoutingCompletion: async (routingState) => verifyRoutingCompletion(routingState),
        cleanupRouting: async (routingConfig) => cleanupRoutingState(routingConfig),
      },
      {
        logger,
        performCleanup: async () => {
          try {
            await performCleanup();
            commandOutputCapture?.setTeardown('complete');
          } catch (error) {
            commandOutputCapture?.setTeardown('failed');
            throw error;
          }
        },
        commandOutputCapture,
        onHostIptablesSetup: () => {
          hostIptablesSetup = true;
        },
        onContainersStarted: () => {
          containersStarted = true;
        },
      }
    );

    if (exitCode !== 0) {
      emitStartupExitMarker(config, startupExitState, {
        path: 'workflow-return', exitCode, containersStarted, agentStarted: agentCommandStarted,
        recordWrite: 'not-attempted', cleanup: 'completed',
      });
    }
    commandOutputCapture?.close();
    console.error(`Process exiting with code: ${exitCode}`);
    process.exit(exitCode);
    return;
  } catch (error) {
    logger.error('Fatal error:', error);
    let recordWriteReason: StartupDiagnosticWriteReason | null = null;
    const recordWrite: StartupDiagnosticWriteOutcome = agentCommandStarted
      ? 'not-attempted'
      : writeStartupFailureDiagnostic(config, error, 'startup', reason => { recordWriteReason = reason; });
    const plannedExitCode = findRoutingFailure(error)?.exitCode ?? 1;
    const exitMarker = {
      path: 'fatal' as const, exitCode: plannedExitCode, containersStarted,
      agentStarted: agentCommandStarted, recordWrite, recordWriteReason,
    };
    // Emit before cleanup too, so a hung or crashing teardown still leaves evidence.
    emitStartupExitMarker(config, startupExitState, { ...exitMarker, cleanup: 'pending' });
    let cleanupOutcome: 'completed' | 'failed' = 'completed';
    try {
      await performCleanup();
    } catch (cleanupError) {
      cleanupOutcome = 'failed';
      logger.warn('Cleanup after a fatal error failed.', cleanupError);
    }
    if (commandOutputCapture) {
      commandOutputCapture.finishCommand(
        undefined,
        'failed',
      );
      commandOutputCapture.setTeardown(cleanupOutcome === 'completed' ? 'complete' : 'failed');
      commandOutputCapture.close();
    }
    emitStartupExitMarker(config, startupExitState, { ...exitMarker, cleanup: cleanupOutcome });
    cleanupRoutingState(config);
    const fatalExitCode = findRoutingFailure(error)?.exitCode ?? 1;
    console.error(`Process exiting with code: ${fatalExitCode}`);
    process.exit(fatalExitCode);
  }
  };
}

/** @internal Exposed for unit tests. */
// ts-prune-ignore-next
export const testHelpers = {
  redactConfigForLogging,
  persistConfigAuditArtifact,
  writeStartupFailureDiagnostic,
  emitStartupExitMarker,
  startupElapsedBucket,
  writeIncompleteEnclaveAuditMarker,
  buildCleanupFn,
};
