import type { WrapperConfig } from '../types';
import { resolveNetworkAddressing } from '../network-subnet';
import { validateEnclavesConfig } from '../enclave/preflight';
import { validateRunSandboxBackend } from '../enclave/run-backend';
import { isEnclaveAgentGithubRouteEnabled } from '../types/enclave-options';
import { resetEnclaveStartupChecklist, updateEnclaveStartupProgress } from '../enclave/startup-progress';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import { isCloudHypervisorEnclaveSelected } from '../enclave/cloud-hypervisor-lifecycle';
import type { WorkflowContext, WorkflowDependencies, WorkflowOptions } from './context';

export function createWorkflowContext(
  config: WrapperConfig,
  dependencies: WorkflowDependencies,
  options: WorkflowOptions,
): WorkflowContext {
  resetEnclaveStartupChecklist(config);
  if (isCloudHypervisorEnclaveSelected(config)) {
    for (const scope of ['host-isolation', 'storage-admission', 'bounded-runtime', 'bounded-artifacts'] as const) {
      new HostPreflightReporter(scope, (hostPreflight) => updateEnclaveStartupProgress(config, { hostPreflight }));
    }
  }
  const checks = new HostPreflightReporter('startup', config.enclaves?.enabled
    ? (hostPreflight) => updateEnclaveStartupProgress(config, { hostPreflight }) : undefined);
  if (!isEnclaveAgentGithubRouteEnabled(config.enclaves?.executors.agent)) {
    checks.notRequired('github-attachment');
    checks.notRequired('github-ready');
  }
  if (config.enclaves?.executors.agent.dynamic === undefined) checks.notRequired('delegation');

  // Fixed sidecar addresses on awf-net, relocated when --network-subnet is set.
  const addressing = resolveNetworkAddressing(config.networkSubnet);
  return { config, dependencies, options, checks, addressing };
}

export async function stageEnclaves(context: WorkflowContext): Promise<void> {
  const { config, dependencies, checks, options: { logger } } = context;
  updateEnclaveStartupProgress(config, { stage: 'configuration' });

  // Structural validation only: the dynamic delegation handoff can be read
  // exactly once (taking custody deletes it from the environment), so that
  // check belongs to `prepareEnclaves` below, which still runs before any
  // container is created.
  await checks.check('configuration', () => {
    const enclaveErrors = [
      ...(config.enclaves ? validateRunSandboxBackend(config.containerRuntime, config.enclaves) : []),
      ...validateEnclavesConfig(config, { requireDelegationHandoff: false }),
    ];
    if (enclaveErrors.length > 0) {
      throw new Error(`Invalid enclave configuration:\n- ${enclaveErrors.join('\n- ')}`);
    }
  });

  // Step -1: Enclave staging (trusted, host-side, credential-bearing).
  //
  // Runs first so that:
  //  - a staging failure aborts before any container is created;
  //  - the staging credential is gone before the broker, the agent, or any
  //    probe exists;
  //  - compose generation (Step 1) can rely on the private seed layout
  //    already being present on disk.
  if (config.enclaves?.enabled) {
    if (!dependencies.prepareEnclaves) {
      throw new Error('Enclaves are enabled but no staging implementation was provided to runMainWorkflow');
    }
    logger.info('Staging enclave repository seeds...');
    updateEnclaveStartupProgress(config, { stage: 'enclave-preflight' });
    await checks.check('enclave-preparation', () => dependencies.prepareEnclaves!(config));
  }
  if (config.experimentalModelRouting === true && config.modelRouting) {
    if (!dependencies.prepareRouting) {
      throw new Error('Model routing is enabled but no staging implementation was provided to runMainWorkflow');
    }
    logger.info('Staging model routing conversation...');
    context.routingState = await dependencies.prepareRouting(config);
  }
}
