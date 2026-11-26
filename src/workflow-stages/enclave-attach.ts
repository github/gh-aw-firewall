import { isEnclaveAgentGithubRouteEnabled } from '../types/enclave-options';
import { assertEnclaveStartupChecklistComplete, updateEnclaveStartupProgress } from '../enclave/startup-progress';
import type { WorkflowContext } from './context';

export async function attachEnclaveGateways(context: WorkflowContext): Promise<void> {
  const { config, dependencies, checks, options: { logger } } = context;
  if (!dependencies.connectEnclaveGateway || !dependencies.assertEnclaveGatewayReady) {
    throw new Error('Enclaves require an exclusive MCP gateway readiness implementation');
  }
  logger.info('Attaching the trusted MCP gateway to the private enclave control path...');
  updateEnclaveStartupProgress(config, { stage: 'gateway-attach' });
  await checks.check('gateway-attachment', () => dependencies.connectEnclaveGateway!(config));
  if (isEnclaveAgentGithubRouteEnabled(config.enclaves?.executors.agent)) {
    if (
      !dependencies.connectEnclaveGithubGateway
      || !dependencies.assertEnclaveGithubGatewayReady
    ) {
      throw new Error(
        'The enclave GitHub gateway (agent.tools.github or the legacy agent.github.cli ' +
        'marker) requires an exclusive enclave GitHub gateway readiness implementation',
      );
    }
    logger.info('Attaching the compiler-owned GitHub proxy to its private control path...');
    updateEnclaveStartupProgress(config, { stage: 'github-readiness' });
    await checks.check('github-attachment', () => dependencies.connectEnclaveGithubGateway!(config));
    await checks.check('github-ready', () => dependencies.assertEnclaveGithubGatewayReady!(config));
  }
  logger.info('Proving enclave tools end to end through the MCP gateway...');
  await checks.check('gateway-ready', () => dependencies.assertEnclaveGatewayReady!(config));
  if (config.enclaves?.executors.agent.dynamic !== undefined) {
    if (!dependencies.startEnclaveDynamicDelegation) {
      throw new Error(
        'enclaves[].dynamic requires the AWF-private delegation admission authority; '
        + 'AWF never runs a dynamic entry without it',
      );
    }
    logger.info('Reconciling mcpg delegation state and opening dynamic admission...');
    updateEnclaveStartupProgress(config, { stage: 'delegation' });
    await checks.check('delegation', () => dependencies.startEnclaveDynamicDelegation!(config));
  }
  await checks.check('readiness', () => assertEnclaveStartupChecklistComplete(config, true));
}
