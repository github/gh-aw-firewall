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

const GITHUB_PROFILE = 'issues-read-v1';
const GITHUB_ENDPOINT = `http://${ENCLAVE_AGENT_GITHUB_MCP_IP}:${ENCLAVE_GITHUB_MCP_PORT}/mcp/github`;
const OUTPUT_NAME = 'out';

function filePath(directory: string, name: string): string {
  const result = path.join(directory, name);
  if (path.dirname(result) !== directory) throw new Error('Invalid enclave artifact path');
  return result;
}

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
  await dependencies.verifyStorage(plan.invocationHostDir, resourceProfile.writableStorageBytes);
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

async function writePrivateFile(
  filePathValue: string,
  contents: string,
  uid: number,
  gid: number,
  mode: number,
  dependencies: HostEnclaveExecutorDependencies,
): Promise<void> {
  await dependencies.writeFile(filePathValue, contents, { encoding: 'utf8', mode, flag: 'wx' });
  await dependencies.chown(filePathValue, uid, gid);
  await dependencies.chmod(filePathValue, mode);
}

export async function stageInvocationInputs(
  plan: HostExecutorInvocationPlan,
  role: CloudHypervisorEnclaveRole,
  policy: HostExecutorAgentPolicy | undefined,
  dependencies: HostEnclaveExecutorDependencies,
): Promise<void> {
  const resourceProfile = role === 'script'
    ? CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script
    : CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.agent;
  const requestDir = filePath(plan.invocationHostDir, 'request');
  if (role === 'script') {
    await writePrivateFile(
      filePath(requestDir, 'query-script.py'),
      plan.payload,
      resourceProfile.uid,
      resourceProfile.gid,
      0o400,
      dependencies,
    );
    return;
  }
  if (!policy) throw new Error('Trusted agent policy is required for an agent enclave');
  await writePrivateFile(
    filePath(requestDir, 'task.txt'),
    plan.payload,
    resourceProfile.uid,
    resourceProfile.gid,
    0o400,
    dependencies,
  );
  await writePrivateFile(
    filePath(requestDir, 'schema.json'),
    JSON.stringify(plan.schema),
    resourceProfile.uid,
    resourceProfile.gid,
    0o400,
    dependencies,
  );
  const runtimeDir = filePath(plan.invocationHostDir, 'runtime');
  const sessionFile = filePath(runtimeDir, 'session.jsonl');
  await writePrivateFile(
    sessionFile,
    '',
    resourceProfile.uid,
    resourceProfile.gid,
    0o600,
    dependencies,
  );
  if (policy.githubAgentId !== undefined && policy.githubBearer !== undefined) {
    const handoffDir = filePath(plan.invocationHostDir, 'session-handoff');
    await writePrivateFile(
      filePath(handoffDir, 'github-agent-id'),
      `${policy.githubAgentId}\n`,
      resourceProfile.uid,
      resourceProfile.gid,
      0o400,
      dependencies,
    );
    await writePrivateFile(
      filePath(handoffDir, 'github-bearer'),
      `${policy.githubBearer}\n`,
      resourceProfile.uid,
      resourceProfile.gid,
      0o400,
      dependencies,
    );
  }
}

export function agentEnvironment(
  policy: HostExecutorAgentPolicy,
  plan: HostExecutorInvocationPlan,
): Readonly<Record<string, string>> {
  return Object.freeze({
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/agent/home',
    COPILOT_HOME: '/agent/copilot',
    COPILOT_OFFLINE: 'true',
    COPILOT_GITHUB_TOKEN: '******',
    COPILOT_TOKEN: '******',
    COPILOT_API_URL: `http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`,
    COPILOT_PROVIDER_BASE_URL: `http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`,
    COPILOT_MODEL: policy.model,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    AWF_ENCLAVE_AGENT_ENGINE: 'copilot',
    AWF_ENCLAVE_AGENT_PROFILE: policy.profile,
    AWF_ENCLAVE_AGENT_MODEL: policy.model,
    AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES: String(policy.maxOutputBytes),
    AWF_ENCLAVE_AGENT_DEADLINE_SECONDS: String(Math.max(1, Math.floor(plan.timeoutMs / 1000))),
    AWF_ENCLAVE_AGENT_API_ENDPOINT: `http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`,
    AWF_ENCLAVE_AGENT_GITHUB_ENABLED: String(policy.githubAgentId !== undefined),
    ...(policy.githubAgentId !== undefined ? {
      AWF_ENCLAVE_AGENT_GITHUB_PROFILE: GITHUB_PROFILE,
      AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: GITHUB_ENDPOINT,
    } : {}),
    ...(policy.maxModelRequests !== undefined
      ? { AWF_ENCLAVE_AGENT_MAX_MODEL_REQUESTS: String(policy.maxModelRequests) }
      : {}),
    ...(policy.maxModelTokens !== undefined
      ? { AWF_ENCLAVE_AGENT_MAX_MODEL_TOKENS: String(policy.maxModelTokens) }
      : {}),
  });
}
