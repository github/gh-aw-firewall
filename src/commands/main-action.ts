import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../logger';
import { assertPersistentDebugArtifactsIsolated } from '../enclave/mount-policy';
import { startContainers, setAwfDockerHost } from '../docker-manager';
import { runMainWorkflow } from '../cli-workflow';
import { applyConfigFilePrecedence } from './preflight';
import { validateOptions } from './validate-options';
import { probeSplitFilesystem } from '../dind-probe';
import { runDindBootstrap } from '../dind-bootstrap';
import { resolveExternalRuntimeBackend } from '../external-runtime-backend-resolver';
import { takeStaticGithubExecutorCapability } from '../enclave/static-github-handoff';
import { withEarlyStartupDiagnostics } from '../logs/early-startup-diagnostics';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import {
  initializeEnclaveStartupProgress,
  updateEnclaveStartupProgress,
} from '../enclave/startup-progress';
import { prepareProtectedCommandOutputCapture } from '../protected-command-output-capture';
import {
  formatCloudHypervisorDockerFallbackWarning,
  isCloudHypervisorUnsupportedHostError,
} from '../cloud-hypervisor/errors';
import { assembleAgentCommand } from './main-action/agent-command';
import { createWorkflowDependencies, registerRuntimeSignalHandlers } from './main-action/external-runtime-wiring';
import { handleFatalExit, handleWorkflowExit, type MainActionLifecycleState } from './main-action/exit-handling';
import { persistConfigAuditArtifact, redactConfigForLogging } from './main-action-audit';
import { buildCleanupFn } from './main-action-cleanup';
import {
  writeStartupFailureDiagnostic,
  emitStartupExitMarker,
  startupElapsedBucket,
  writeIncompleteEnclaveAuditMarker,
} from './main-action-startup-diagnostics';

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
    const agentCommand = assembleAgentCommand(args, reflect);

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

    const state: MainActionLifecycleState = {
      exitCode: 0,
      containersStarted: false,
      agentCommandStarted: false,
      hostIptablesSetup: false,
      cloudHypervisorPrimaryPreflightPassed: false,
      performCleanup: buildCleanupFn(
        config,
        () => state.containersStarted,
        () => state.hostIptablesSetup,
      ),
      startupExitState: {
        startedAt: Date.now(), lastProgressWrite: 'not-attempted', progressWriteFailures: 0,
      },
    };

    try {
      if (config.enclaves?.enabled) {
        takeStaticGithubExecutorCapability(config, process.env);
      }
      initializeEnclaveStartupProgress(config, () => {
        const outcome = writeStartupFailureDiagnostic(
          config, new Error('Enclave startup in progress'), 'enclave-startup-progress',
          reason => {
            state.startupExitState.firstProgressWriteFailure ??= reason;
            state.startupExitState.lastProgressWriteFailure = reason;
          },
        );
        state.startupExitState.lastProgressWrite = outcome;
        if (outcome !== 'written') {
          state.startupExitState.progressWriteFailures = Math.min(state.startupExitState.progressWriteFailures + 1, 999999);
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
      state.commandOutputCapture = prepareProtectedCommandOutputCapture(config);
      if (state.commandOutputCapture) {
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
      state.externalRuntimeBackend = resolveExternalRuntimeBackend(config, startContainers);
      state.performCleanup = buildCleanupFn(
        config,
        () => state.containersStarted,
        () => state.hostIptablesSetup,
        state.externalRuntimeBackend,
      );

      // Register signal handlers for graceful shutdown
      registerRuntimeSignalHandlers(config, state);

      if (state.externalRuntimeBackend) {
        try {
          if (config.enclaves?.enabled && state.externalRuntimeBackend.runtime === 'cloud-hypervisor') {
            const checks = new HostPreflightReporter('enclave-runtime', (hostPreflight) =>
              updateEnclaveStartupProgress(config, { hostPreflight }));
            await checks.check('primary-runtime', () => state.externalRuntimeBackend!.preflight());
            state.cloudHypervisorPrimaryPreflightPassed = true;
          } else {
            await state.externalRuntimeBackend.preflight();
          }
        } catch (error) {
          if (
            state.externalRuntimeBackend.runtime === 'cloud-hypervisor' &&
            !config.enclaves?.enabled &&
            isCloudHypervisorUnsupportedHostError(error)
          ) {
            logger.warn(formatCloudHypervisorDockerFallbackWarning(error));
            config.containerRuntime = undefined;
            config.cloudHypervisor = undefined;
            state.externalRuntimeBackend = undefined;
            state.performCleanup = buildCleanupFn(
              config,
              () => state.containersStarted,
              () => state.hostIptablesSetup,
            );
          } else {
            throw error;
          }
        }
      }

      // Persist only after preflight so the audit artifact records the effective
      // runtime when an unsupported Cloud Hypervisor host falls back to Docker.
      persistConfigAuditArtifact(config, redactConfigForLogging(config));

      state.exitCode = await runMainWorkflow(
        config,
        createWorkflowDependencies(config, state),
        {
          logger,
          performCleanup: async () => {
            try {
              await state.performCleanup();
              state.commandOutputCapture?.setTeardown('complete');
            } catch (error) {
              state.commandOutputCapture?.setTeardown('failed');
              throw error;
            }
          },
          commandOutputCapture: state.commandOutputCapture,
          onHostIptablesSetup: () => {
            state.hostIptablesSetup = true;
          },
          onContainersStarted: () => {
            state.containersStarted = true;
          },
        },
      );

      handleWorkflowExit(config, state);
      return;
    } catch (error) {
      await handleFatalExit(config, state, error);
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
