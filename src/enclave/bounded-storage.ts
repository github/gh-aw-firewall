import { ENCLAVE_RESOURCE_POLICIES, type EnclaveExecutionRole } from './execution-policy';

export interface BoundedEnclaveStorageRequirement {
  readonly role: EnclaveExecutionRole;
  readonly maximumBytes: number;
  readonly uid: number;
  readonly gid: number;
}

/** Backends must verify actual confinement and capacity, not available disk space. */
export type BoundedEnclaveStorageVerifier = (
  directory: string,
  requirement: BoundedEnclaveStorageRequirement,
  writableDirectories: readonly string[],
) => Promise<void>;

export function enclaveStorageRequirement(role: EnclaveExecutionRole): BoundedEnclaveStorageRequirement {
  const policy = ENCLAVE_RESOURCE_POLICIES[role];
  return Object.freeze({
    role: policy.role,
    maximumBytes: policy.writableStorageBytes,
    uid: policy.uid,
    gid: policy.gid,
  });
}

export async function verifyBoundedInvocationStorage(
  role: EnclaveExecutionRole,
  directory: string,
  verifier: BoundedEnclaveStorageVerifier,
  writableDirectories: readonly string[] = [],
): Promise<void> {
  await verifier(directory, enclaveStorageRequirement(role), writableDirectories);
}
