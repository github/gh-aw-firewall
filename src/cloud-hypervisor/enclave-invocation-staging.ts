import { promises as fs } from 'fs';
import * as path from 'path';
import {
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_GITHUB_MCP_PORT,
} from '../enclave/network';
import type {
  HostExecutorInvocationPlan,
  HostExecutorRunState,
} from '../enclave/host-executor-server';
import { HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
import { verifyBoundedInvocationStorage } from '../enclave/bounded-storage';
import {
  invocationFilePath as filePath,
  stageInvocationInputs as stageSharedInvocationInputs,
  writePrivateInvocationFile as writePrivateFile,
} from '../enclave/invocation-staging';
import {
  assertTrustedAncestorChain,
  calculateSha256,
} from './artifact-trust';
import type {
  CloudHypervisorEnclaveRole,
} from './enclave-artifact-manifest';
import type {
  HostEnclaveExecutorDependencies,
  HostExecutorAgentPolicy,
} from './enclave-executor-types';
import type { CloudHypervisorHostToolPaths } from './preflight';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES } from './workload-profile';
import { createEnclaveModelBudgetToken } from '../enclave/model-budget-capability';
import {
  enforceGithubTokenIsolation,
  getGithubTokenEnvValues,
} from '../services/agent-environment/github-token-isolation';

const GITHUB_PROFILE = 'issues-read-v1';
const GITHUB_ENDPOINT = `http://${ENCLAVE_AGENT_GITHUB_MCP_IP}:${ENCLAVE_GITHUB_MCP_PORT}/mcp/github`;
const OUTPUT_NAME = 'out';

export async function prepareInvocationFilesystem(
  runState: HostExecutorRunState,
  plan: HostExecutorInvocationPlan,
  role: CloudHypervisorEnclaveRole,
  dependencies: HostEnclaveExecutorDependencies,
  tools: CloudHypervisorHostToolPaths,
  beforeDirectoryCreated: () => Promise<void>,
  onDirectoryCreated: () => Promise<void>,
  onMounted: () => Promise<void>,
): Promise<void> {
  const invocationParent = path.dirname(plan.invocationHostDir);
  const invocationRoot = runState.invocationsDir;
  if (
    invocationParent !== path.join(invocationRoot, plan.entryId) ||
    path.dirname(invocationParent) !== invocationRoot
  ) {
    throw new Error('Host executor invocation directory is outside the trusted run root');
  }
  const identity = dependencies.resolveIdentity();
  const resourceProfile = role === 'script'
    ? CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script
    : CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.agent;
  const trustDependencies = {
    uid: identity.uid,
    access: fs.access,
    lstat: dependencies.lstat,
    sha256: calculateSha256,
  };
  await assertTrustedAncestorChain(
    'host executor invocation storage',
    invocationRoot,
    trustDependencies,
  );
  await assertTrustedDirectory(invocationRoot, identity.uid, dependencies);
  try {
    await dependencies.lstat(invocationParent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await dependencies.mkdir(invocationParent, { mode: 0o700 });
  }
  await assertTrustedDirectory(invocationParent, identity.uid, dependencies);
  await beforeDirectoryCreated();
  await dependencies.mkdir(plan.invocationHostDir, { mode: 0o700 });
  await onDirectoryCreated();
  const invocationStat = await dependencies.lstat(plan.invocationHostDir);
  if (invocationStat.isSymbolicLink() || !invocationStat.isDirectory()) {
    throw new Error('Host executor invocation directory must be a new real directory');
  }
  await dependencies.mountTmpfs(
    plan.invocationHostDir,
    resourceProfile.writableStorageBytes,
    resourceProfile.uid,
    resourceProfile.gid,
    tools,
  );
  await onMounted();
  await verifyBoundedInvocationStorage(role, plan.invocationHostDir,
    (directory, requirement) =>
      dependencies.verifyStorage(directory, requirement.maximumBytes));
  for (const name of ['request', 'output', 'runtime']) {
    const directory = filePath(plan.invocationHostDir, name);
    await dependencies.mkdir(directory, { mode: 0o700 });
    await dependencies.chown(directory, resourceProfile.uid, resourceProfile.gid);
  }
  await writePrivateFile(
    filePath(filePath(plan.invocationHostDir, 'output'), OUTPUT_NAME),
    '',
    resourceProfile.uid,
    resourceProfile.gid,
    0o600,
    dependencies,
  );

  if (role === 'agent') {
    for (const name of ['session-handoff', 'session-state']) {
      const directory = filePath(plan.invocationHostDir, name);
      await dependencies.mkdir(directory, { mode: 0o700 });
      await dependencies.chown(directory, resourceProfile.uid, resourceProfile.gid);
    }
  }
}

async function assertTrustedDirectory(
  directory: string,
  operatorUid: number,
  dependencies: HostEnclaveExecutorDependencies,
): Promise<void> {
  const stat = await dependencies.lstat(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    (stat.uid !== 0 && stat.uid !== operatorUid) ||
    await dependencies.realpath(directory) !== directory
  ) {
    throw new Error('Host executor invocation directories must be trusted private directories');
  }
}

export async function stageInvocationInputs(
  plan: HostExecutorInvocationPlan,
  role: CloudHypervisorEnclaveRole,
  policy: HostExecutorAgentPolicy | undefined,
  dependencies: Pick<HostEnclaveExecutorDependencies, 'writeFile' | 'chown' | 'chmod'>,
): Promise<void> {
  await stageSharedInvocationInputs(plan, role, policy, dependencies,
    'Cloud Hypervisor enclave GitHub bearer file');
}

export function agentEnvironment(
  policy: HostExecutorAgentPolicy,
  plan: HostExecutorInvocationPlan,
): Readonly<Record<string, string>> {
  const modelBudgetToken = createEnclaveModelBudgetToken(
    policy.modelBudgetSecret,
    plan.invocationId,
    policy.maxModelRequests,
    policy.maxModelTokens,
  );
  const environment = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/agent/home',
    COPILOT_HOME: '/agent/copilot',
    COPILOT_OFFLINE: 'true',
    COPILOT_GITHUB_TOKEN: '******',
    COPILOT_TOKEN: modelBudgetToken || '******',
    COPILOT_PROVIDER_BEARER_TOKEN: modelBudgetToken?.slice('Bearer '.length) || '******',
    COPILOT_API_URL: `http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`,
    COPILOT_PROVIDER_BASE_URL: `http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`,
    COPILOT_MODEL: policy.model,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    AWF_ENCLAVE_AGENT_ENGINE: 'copilot',
    AWF_ENCLAVE_AGENT_PROFILE: policy.profile,
    AWF_ENCLAVE_AGENT_MODEL: policy.model,
    AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES: String(policy.maxOutputBytes),
    AWF_ENCLAVE_AGENT_DEADLINE_SECONDS: String(Math.max(1,
      Math.floor((plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS) / 1000))),
    AWF_ENCLAVE_AGENT_API_ENDPOINT: `http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`,
    AWF_ENCLAVE_AGENT_GITHUB_ENABLED: String(policy.githubAgentId !== undefined),
    ...(policy.githubAgentId !== undefined ? {
      AWF_ENCLAVE_AGENT_GITHUB_AUTH_MODE: 'scoped-bearer',
      AWF_ENCLAVE_AGENT_GITHUB_ALLOWED_TOOLS: JSON.stringify(policy.githubAllowedTools),
      AWF_ENCLAVE_AGENT_GITHUB_PROFILE: GITHUB_PROFILE,
      AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: GITHUB_ENDPOINT,
    } : {}),
    ...(policy.maxModelRequests !== undefined
      ? { AWF_ENCLAVE_AGENT_MAX_MODEL_REQUESTS: String(policy.maxModelRequests) }
      : {}),
    ...(policy.maxModelTokens !== undefined
      ? { AWF_ENCLAVE_AGENT_MAX_MODEL_TOKENS: String(policy.maxModelTokens) }
      : {}),
  };
  enforceGithubTokenIsolation(
    environment,
    getGithubTokenEnvValues(),
    'Cloud Hypervisor enclave',
  );
  return Object.freeze(environment);
}
