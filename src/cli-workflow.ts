import { WrapperConfig } from './types';
import { updateEnclaveStartupProgress } from './enclave/startup-progress';
import { ensureAgentRuntimeStartMarker } from './agent-runtime-start';
import { observeHarness } from './harness-observation';
import { preparePrivateHostSocketIsolation } from './private-host-sockets';
import { createWorkflowContext, stageEnclaves } from './workflow-stages/enclave-staging';
import { setupHostNetwork } from './workflow-stages/host-network';
import { startWorkflowContainers } from './workflow-stages/container-startup';
import type { WorkflowDependencies, WorkflowOptions } from './workflow-stages/context';

export type { WorkflowDependencies } from './workflow-stages/context';

/**
 * Executes the primary workflow for the CLI. This function is intentionally pure so
 * it can be unit tested with mocked dependencies.
 */
export async function runMainWorkflow(
  config: WrapperConfig,
  dependencies: WorkflowDependencies,
  options: WorkflowOptions
): Promise<number> {
  const { logger, performCleanup } = options;
  const releasePrivateHostSocketGate = preparePrivateHostSocketIsolation(config);
  const context = createWorkflowContext(config, dependencies, options);
  await stageEnclaves(context);
  await setupHostNetwork(context);

  // Step 1: Write configuration files
  logger.info('Generating configuration files...');
  updateEnclaveStartupProgress(config, { stage: 'compose-config' });
  await context.checks.check('compose-configuration', () => dependencies.writeConfigs(config));
  await startWorkflowContainers(context);
  const setupExited = (await releasePrivateHostSocketGate?.()) === 'setup-exited';
  if (!setupExited) {
    await observeHarness(config, dependencies.probeHarness);
    await dependencies.releaseHarness?.();
    updateEnclaveStartupProgress(config, { stage: 'primary-agent' });
    if (config.enableApiProxy && config.agentTimeout !== undefined) {
      ensureAgentRuntimeStartMarker(config.workDir, config.proxyLogsDir);
    }
  }
  // The usual wait/log path also collects diagnostics from an exited entrypoint.
  const result = options.commandOutputCapture
    ? await dependencies.runAgentCommand(
      config.workDir,
      config.allowedDomains,
      config.proxyLogsDir,
      config.agentTimeout,
      options.commandOutputCapture,
    )
    : await dependencies.runAgentCommand(
      config.workDir,
      config.allowedDomains,
      config.proxyLogsDir,
      config.agentTimeout,
    );

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
  if (config.experimentalModelRouting === true && config.modelRouting) {
    if (!dependencies.verifyRoutingCompletion) {
      throw new Error('Model routing is enabled but no completion verification implementation was provided');
    }
    try {
      await dependencies.verifyRoutingCompletion(context.routingState);
    } finally {
      await dependencies.cleanupRouting?.(config);
    }
  }

  if (result.exitCode === 0) {
    logger.success('Command completed successfully');
  } else {
    logger.warn(`Command completed with exit code: ${result.exitCode}`);
  }

  return result.exitCode;
}
