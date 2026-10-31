import type { EnclaveAgentProfile } from '../types/enclave-options';
import { HOST_EXECUTOR_MAX_RESULT_BYTES } from './host-executor-protocol';

export type EnclaveExecutionRole = 'script' | 'agent';

export interface EnclaveResourcePolicy {
  readonly role: EnclaveExecutionRole;
  readonly memoryMiB: number;
  readonly vcpuCount: number;
  readonly cpuQuotaMilli: number;
  readonly maxProcesses: number;
  readonly tmpfsBytes: number;
  readonly maxFileBytes: number;
  readonly maxOpenFiles: number;
  readonly writableStorageBytes: number;
  readonly uid: number;
  readonly gid: number;
}

export interface EnclaveExecutionIdentity<Role extends EnclaveExecutionRole = EnclaveExecutionRole> {
  readonly kind: `${Role}-enclave`;
  readonly ownerId: string;
  readonly invocationId: string;
}

export interface HostExecutorAgentPolicy {
  readonly model: string;
  readonly profile: EnclaveAgentProfile;
  readonly maxOutputBytes: number;
  readonly maxModelRequests?: number;
  readonly maxModelTokens?: number;
  readonly modelBudgetSecret?: string;
  readonly githubAgentId?: string;
  readonly githubBearer?: string;
  readonly githubExpiresAt?: number;
  readonly githubAllowedTools?: readonly string[];
}

const MIB = 1024 * 1024;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CREDENTIAL_PATTERN = /^[\x21-\x7e]{16,512}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Trusted role limits, never overlaid with invocation-supplied settings. */
export const ENCLAVE_RESOURCE_POLICIES = Object.freeze({
  script: Object.freeze({
    role: 'script',
    memoryMiB: 768,
    vcpuCount: 1,
    cpuQuotaMilli: 500,
    maxProcesses: 47,
    tmpfsBytes: 256 * MIB,
    maxFileBytes: 512 * MIB,
    maxOpenFiles: 1024,
    writableStorageBytes: 1024 * MIB,
    uid: 65534,
    gid: 65534,
  }),
  agent: Object.freeze({
    role: 'agent',
    memoryMiB: 768,
    vcpuCount: 1,
    cpuQuotaMilli: 500,
    maxProcesses: 47,
    tmpfsBytes: 96 * MIB,
    maxFileBytes: 256 * MIB,
    maxOpenFiles: 1024,
    writableStorageBytes: 512 * MIB,
    uid: 65534,
    gid: 65534,
  }),
}) satisfies Readonly<Record<EnclaveExecutionRole, EnclaveResourcePolicy>>;

export function assertSafeWorkloadIdentity(value: string, label: string, context = 'enclave'): void {
  if (!SAFE_IDENTITY.test(value)) {
    throw new Error(`Unsafe ${context} workload ${label} identity: ${value}`);
  }
}

export function createEnclaveExecutionIdentity<Role extends EnclaveExecutionRole>(
  role: Role,
  ownerId: string,
  invocationId: string,
  context = 'enclave',
): EnclaveExecutionIdentity<Role> {
  assertSafeWorkloadIdentity(ownerId, 'owner', context);
  assertSafeWorkloadIdentity(invocationId, 'invocation', context);
  return Object.freeze({
    kind: `${role}-enclave` as const,
    ownerId,
    invocationId,
  });
}

export function sameEnclaveResourcePolicy(
  actual: EnclaveResourcePolicy | undefined,
  expected: EnclaveResourcePolicy,
): boolean {
  if (!actual || typeof actual !== 'object') return false;
  const keys = Object.keys(expected) as (keyof EnclaveResourcePolicy)[];
  return Object.keys(actual).length === keys.length &&
    keys.every((key) => actual[key] === expected[key]);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function normalizeAgentPolicy(
  policy: HostExecutorAgentPolicy | undefined,
  timeoutMs: number,
): HostExecutorAgentPolicy | undefined {
  if (!policy) return undefined;
  if (
    typeof policy.model !== 'string' ||
    policy.model.length === 0 ||
    Buffer.byteLength(policy.model, 'utf8') > 256 ||
    hasControlCharacters(policy.model) ||
    !['openai', 'anthropic'].includes(policy.profile) ||
    !Number.isSafeInteger(policy.maxOutputBytes) ||
    policy.maxOutputBytes < 1 ||
    policy.maxOutputBytes > HOST_EXECUTOR_MAX_RESULT_BYTES ||
    (policy.maxModelRequests !== undefined &&
      (!Number.isSafeInteger(policy.maxModelRequests) || policy.maxModelRequests < 1)) ||
    (policy.maxModelTokens !== undefined &&
      (!Number.isSafeInteger(policy.maxModelTokens) || policy.maxModelTokens < 1)) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new Error('Trusted host executor agent policy is invalid');
  }
  const hasGithubId = policy.githubAgentId !== undefined;
  const hasGithubBearer = policy.githubBearer !== undefined;
  if (hasGithubId && !hasGithubBearer) {
    throw new Error('Trusted GitHub agent identity requires a bearer');
  }
  if (
    (policy.githubAgentId !== undefined && !AGENT_ID_PATTERN.test(policy.githubAgentId)) ||
    (policy.githubBearer !== undefined &&
      (!CREDENTIAL_PATTERN.test(policy.githubBearer) ||
        Buffer.byteLength(policy.githubBearer, 'ascii') > 512))
  ) {
    throw new Error('Trusted host executor GitHub credentials are invalid');
  }
  return policy;
}
