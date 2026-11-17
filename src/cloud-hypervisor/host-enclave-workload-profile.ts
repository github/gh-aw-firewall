import { HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
import type { HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import {
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_GITHUB_MCP_PORT,
} from '../enclave/network';
import { ENCLAVE_AGENT_GITHUB_TOOLS } from '../types/enclave-options';
import type { CloudHypervisorEnclaveExportPlan } from './enclave-export-plan';
import type { HostExecutorAgentPolicy } from './enclave-executor-types';
import type { CloudHypervisorManagerGuestConfig } from './manager-types';
import type { CloudHypervisorPreflightResult } from './preflight';
import {
  CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES,
  createAgentEnclaveCloudHypervisorProfile,
  createScriptEnclaveCloudHypervisorProfile,
  type CloudHypervisorWorkloadProfile,
} from './workload-profile';

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

export function createWorkloadProfile(
  plan: HostExecutorInvocationPlan,
  exportPlan: CloudHypervisorEnclaveExportPlan,
  artifacts: CloudHypervisorPreflightResult,
  agentPolicy: HostExecutorAgentPolicy | undefined,
  publicFixtureDebug: boolean,
): CloudHypervisorWorkloadProfile {
  const resourceProfile = exportPlan.role === 'script'
    ? CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script
    : CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.agent;
  const guest: Omit<CloudHypervisorManagerGuestConfig, 'exports' | 'workspaceMount'> = {
    supervisorBinaryPath: artifacts.supervisorPath,
    supervisorSha256: artifacts.artifactDigests.supervisor,
    identity: { uid: resourceProfile.uid, gid: resourceProfile.gid },
  };
  if (exportPlan.role === 'script') {
    return createScriptEnclaveCloudHypervisorProfile({
      enclaveId: plan.entryId,
      invocationId: plan.invocationId,
      guest,
      exportPlan,
      ...(publicFixtureDebug ? { publicFixtureDebug: true } : {}),
    });
  }
  if (!agentPolicy) throw new Error('Trusted agent policy is required for an agent enclave');
  return createAgentEnclaveCloudHypervisorProfile({
    enclaveId: plan.entryId,
    invocationId: plan.invocationId,
    guest,
    exportPlan,
    ...(publicFixtureDebug ? { publicFixtureDebug: true } : {}),
    apiProxy: {
      ip: ENCLAVE_AGENT_API_PROXY_IP,
      engine: agentPolicy.engine ?? 'copilot',
      profile: agentPolicy.profile,
    },
    ...(agentPolicy.githubBearer !== undefined
      ? { githubDataPlane: { ip: ENCLAVE_AGENT_GITHUB_MCP_IP, port: ENCLAVE_GITHUB_MCP_PORT } }
      : {}),
  });
}
