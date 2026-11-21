import * as path from 'path';
import type { DockerHostExecutorEntry } from './docker-host-context';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import { HOST_EXECUTOR_ID_PATTERN } from './host-executor-protocol';
import { assertDockerHostPath } from './docker-host-storage';
import type { PublicEnclaveOperationStage } from './public-debug-events';

export type DockerHostDebugCheck = <T>(
  stage: PublicEnclaveOperationStage, operation: () => Promise<T> | T, cleanup?: boolean,
) => Promise<T>;

export function isDockerHostPlanIdentityValid(
  plan: HostExecutorInvocationPlan, runId: string, entry: DockerHostExecutorEntry | undefined,
): boolean {
  return Boolean(entry && plan.runId === runId && plan.executorKind === entry.executorKind
    && HOST_EXECUTOR_ID_PATTERN.test(plan.invocationId));
}

export async function isDockerHostInvocationPathValid(
  plan: HostExecutorInvocationPlan, debugCheck: DockerHostDebugCheck,
): Promise<boolean> {
  await debugCheck('storage-preparation', () => assertDockerHostPath(plan.invocationHostDir));
  return path.basename(plan.invocationHostDir) === plan.invocationId;
}

export async function isDockerHostSeedValid(
  plan: HostExecutorInvocationPlan, dynamicEnabled: boolean, debugCheck: DockerHostDebugCheck,
): Promise<boolean> {
  if (!dynamicEnabled && (!plan.seedId || !plan.seedHostPath)) return false;
  if (plan.seedHostPath) await debugCheck('storage-preparation', () => assertDockerHostPath(plan.seedHostPath!));
  return true;
}
