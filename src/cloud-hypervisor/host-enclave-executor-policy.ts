import { normalizeAgentPolicy } from '../enclave/execution-policy';
import { HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
import type { HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import { ENCLAVE_AGENT_GITHUB_TOOLS } from '../types/enclave-options';
import type { HostExecutorAgentPolicy } from './enclave-executor-types';

export { createWorkloadProfile } from './host-enclave-workload-profile';

export function resolveInvocationPolicy(
  plan: HostExecutorInvocationPlan,
  policies: Readonly<Record<string, HostExecutorAgentPolicy>> | undefined,
): HostExecutorAgentPolicy | undefined {
  const raw = policies && Object.prototype.hasOwnProperty.call(policies, plan.entryId)
    ? policies[plan.entryId] : undefined;
  const policy = plan.executorKind === 'agent' ? normalizeAgentPolicy(raw, plan.timeoutMs) : undefined;
  assertGithubCapabilityLifetime(policy, plan.timeoutMs);
  return policy;
}

export function assertGithubCapabilityLifetime(
  policy: HostExecutorAgentPolicy | undefined,
  timeoutMs: number,
): void {
  if (!policy) return;
  const hasCredentials = policy.githubAgentId !== undefined || policy.githubBearer !== undefined;
  if (!hasCredentials && policy.githubExpiresAt === undefined && policy.githubAllowedTools === undefined) return;
  if (!hasCredentials || !Number.isSafeInteger(policy.githubExpiresAt)
    || policy.githubExpiresAt! < Date.now() + timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS
    || !Array.isArray(policy.githubAllowedTools) || policy.githubAllowedTools.length === 0
    || new Set(policy.githubAllowedTools).size !== policy.githubAllowedTools.length
    || !policy.githubAllowedTools.every((tool) =>
      (ENCLAVE_AGENT_GITHUB_TOOLS as readonly string[]).includes(tool))) {
    throw new Error('Trusted Cloud Hypervisor GitHub capability must include tools and cover the invocation deadline');
  }
}
