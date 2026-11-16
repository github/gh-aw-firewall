import type { WorkflowDependencies } from '../../cli-workflow';
import type { WrapperConfig } from '../../types';
import {
  writeConfigs,
  startContainers,
  runAgentCommand,
  fastKillAgentContainer,
  collectDiagnosticLogs,
} from '../../docker-manager';
import { ensureFirewallNetwork, setupHostIptables } from '../../host-iptables';
import { adaptExternalRuntimeBackend } from '../../external-runtime-backend';
import { createDockerHarnessObservation } from '../../docker-harness-observation';
import { harnessContext } from '../../harness-observation';
import { assertTopologySupported, connectTopologyContainers } from '../../topology';
import { prepareEnclaves } from '../../enclave/manager';
import { startEnclaveDynamicDelegation } from '../../enclave/dynamic-delegation';
import { assertEnclaveGatewayReady, connectEnclaveGateway } from '../../enclave/gateway';
import { assertEnclaveGithubGatewayReady, connectEnclaveGithubGateway } from '../../enclave/github-gateway';
import {
  cleanupRoutingState,
  stageRoutingConversation,
  verifyRoutingCompletion,
  waitForRoutingSelection,
} from '../../routing/bootstrap';
import { registerSignalHandlers } from '../signal-handler';
import { emitWorkflowExitMarker, type MainActionLifecycleState } from './exit-handling';

export function registerRuntimeSignalHandlers(config: WrapperConfig, state: MainActionLifecycleState): void {
  registerSignalHandlers({
    getContainersStarted: () => state.containersStarted,
    keepContainers: config.keepContainers,
    fastKillAgentContainer: async () => {
      if (state.externalRuntimeBackend) {
        await state.externalRuntimeBackend.stop();
      } else {
        await fastKillAgentContainer();
      }
      if (state.commandOutputCapture) {
        if (state.agentCommandStarted) {
          await state.commandOutputCapture.waitForCommandCompletion();
        } else {
          state.commandOutputCapture.finishCommand(undefined, 'cancelled');
        }
      }
    },
    performCleanup: async (signal) => {
      try {
        await state.performCleanup(signal);
        state.commandOutputCapture?.setTeardown('complete');
      } catch (error) {
        state.commandOutputCapture?.setTeardown('failed');
        throw error;
      } finally {
        if (signal) {
          state.commandOutputCapture?.finishCommand(
            undefined,
            config.keepContainers && state.agentCommandStarted ? 'interrupted' : 'cancelled',
          );
        }
        state.commandOutputCapture?.close();
      }
    },
    cleanupRouting: () => cleanupRoutingState(config),
  });
}

export function createWorkflowDependencies(
  config: WrapperConfig,
  state: MainActionLifecycleState,
): WorkflowDependencies {
  const externalRuntimeBackend = state.externalRuntimeBackend;
  const externalWorkflowDependencies = externalRuntimeBackend
    ? adaptExternalRuntimeBackend(externalRuntimeBackend)
    : undefined;
  const dockerHarness = externalRuntimeBackend
    ? undefined : createDockerHarnessObservation(config, harnessContext(config));
  const workflowRunAgentCommand: WorkflowDependencies['runAgentCommand'] =
    externalWorkflowDependencies?.runAgentCommand
    ?? ((workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, capture) => capture
      ? runAgentCommand(
        workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, config.containerRuntime, capture,
      )
      : runAgentCommand(
        workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, config.containerRuntime,
      ));
  const trackedRunAgentCommand: WorkflowDependencies['runAgentCommand'] = async (
    workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, capture,
  ) => {
    state.agentCommandStarted = true;
    const result = capture
      ? await workflowRunAgentCommand(
        workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes, capture,
      )
      : await workflowRunAgentCommand(workDir, allowedDomains, proxyLogsDir, agentTimeoutMinutes);
    emitWorkflowExitMarker(config, state, result.exitCode, 'pending');
    return result;
  };
  const workflowCollectDiagnosticLogs = externalRuntimeBackend
    ? async (workDir: string): Promise<void> => {
      const results = await Promise.allSettled([
        externalRuntimeBackend.collectDiagnostics(),
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

  return {
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
              || state.externalRuntimeBackend?.runtime !== 'cloud-hypervisor'
              || !state.cloudHypervisorPrimaryPreflightPassed
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
  };
}
