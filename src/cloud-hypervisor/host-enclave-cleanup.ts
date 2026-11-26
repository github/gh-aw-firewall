import type { HostExecutorBackendResult } from '../enclave/host-executor-server';
import type { HostEnclaveExecutorDependencies, HostExecutorAgentPolicy } from './enclave-executor-types';
import type { HostEnclaveInvocationResources } from './host-enclave-executor-cleanup';
import type { HostEnclaveInvocationInterruption } from './host-enclave-execution-phases';
import type { HostEnclaveExecutionProgress } from './host-enclave-result';

export async function cleanupHostEnclaveInvocation(
  resources: HostEnclaveInvocationResources,
  policy: HostExecutorAgentPolicy | undefined,
  progress: HostEnclaveExecutionProgress,
  interruption: HostEnclaveInvocationInterruption,
  outcome: HostExecutorBackendResult,
  originalDependencies: HostEnclaveExecutorDependencies,
): Promise<HostExecutorBackendResult> {
  const { diagnostic, evidence, stderr } = progress;
  diagnostic.milestone('work-complete', outcome.outcome);
  diagnostic.milestone('cleanup-start');
  interruption.dispose();
  const cleanupCheck = progress.createCleanupCheck();
  let cleanupError = await resources.drainAndStop(cleanupCheck);
  cleanupError = await evidence.retain(resources, policy, stderr.captured(), outcome.outcome, cleanupError);
  cleanupError = await resources.removeResources(cleanupCheck, cleanupError, originalDependencies);
  await evidence.refreshCleanupFailure(resources.dependencies, cleanupError);
  diagnostic.milestone('cleanup-complete', cleanupError === undefined ? outcome.outcome : 'executor-failure');
  if (cleanupError !== undefined || diagnostic.persistenceFailed) {
    return { outcome: 'executor-failure', cleanupComplete: false };
  }
  if (progress.guestWorkloadFailed && outcome.outcome === 'executor-failure') {
    return { outcome: 'executor-failure', cleanupComplete: true, recoverableFailure: true };
  }
  return outcome;
}
