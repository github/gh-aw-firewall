import { promises as fs } from 'fs';
import * as path from 'path';
import type { FiniteSchemaNode } from '../bounded-execution/finite-schema';
import {
  assertNoHostGithubTokenValue,
  getGithubTokenEnvValues,
} from '../services/agent-environment/github-token-isolation';
import {
  ENCLAVE_RESOURCE_POLICIES,
  type EnclaveExecutionRole,
  type HostExecutorAgentPolicy,
} from './execution-policy';

export interface InvocationInputPlan {
  readonly invocationHostDir: string;
  readonly payload: string;
  readonly schema: FiniteSchemaNode;
}

export interface InvocationStagingDependencies {
  readonly writeFile: typeof fs.writeFile;
  readonly chown: typeof fs.chown;
  readonly chmod: typeof fs.chmod;
}

export function invocationFilePath(directory: string, name: string): string {
  const result = path.join(directory, name);
  if (path.dirname(result) !== directory) throw new Error('Invalid enclave artifact path');
  return result;
}

export async function writePrivateInvocationFile(
  filePathValue: string,
  contents: string,
  uid: number,
  gid: number,
  mode: number,
  dependencies: InvocationStagingDependencies,
): Promise<void> {
  await dependencies.writeFile(filePathValue, contents, { encoding: 'utf8', mode, flag: 'wx' });
  await dependencies.chown(filePathValue, uid, gid);
  await dependencies.chmod(filePathValue, mode);
}

export async function stageInvocationInputs(
  plan: InvocationInputPlan,
  role: EnclaveExecutionRole,
  policy: HostExecutorAgentPolicy | undefined,
  dependencies: InvocationStagingDependencies,
  credentialContext = 'enclave GitHub bearer file',
): Promise<void> {
  if (role === 'agent' && policy?.githubBearer) {
    assertNoHostGithubTokenValue(
      policy.githubBearer,
      getGithubTokenEnvValues(),
      credentialContext,
    );
  }
  const resourceProfile = ENCLAVE_RESOURCE_POLICIES[role];
  const requestDir = invocationFilePath(plan.invocationHostDir, 'request');
  const write = (directory: string, name: string, contents: string, mode = 0o400) =>
    writePrivateInvocationFile(
      invocationFilePath(directory, name), contents,
      resourceProfile.uid, resourceProfile.gid, mode, dependencies,
    );
  if (role === 'script') {
    await write(requestDir, 'query-script.py', plan.payload);
    return;
  }
  if (!policy) throw new Error('Trusted agent policy is required for an agent enclave');
  await write(requestDir, 'task.txt', plan.payload);
  await write(requestDir, 'schema.json', JSON.stringify(plan.schema));
  await write(invocationFilePath(plan.invocationHostDir, 'runtime'), 'session.jsonl', '', 0o600);
  if (policy.githubAgentId !== undefined || policy.githubBearer !== undefined) {
    const handoffDir = invocationFilePath(plan.invocationHostDir, 'session-handoff');
    if (policy.githubAgentId !== undefined) {
      await write(handoffDir, 'github-agent-id', `${policy.githubAgentId}\n`);
    }
    if (policy.githubBearer !== undefined) {
      await write(handoffDir, 'github-bearer', `${policy.githubBearer}\n`);
    }
  }
}
