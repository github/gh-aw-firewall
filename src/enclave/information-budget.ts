import {
  ENCLAVE_SENSITIVITY_RUN_BITS,
  type EnclaveSensitivity,
} from '../types/enclave-options';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';

export type EnclaveExecutorKind = 'script' | 'agent';

export interface EnclaveInformationBudgetPolicy {
  readonly runBits: Readonly<Record<EnclaveSensitivity, number | null>>;
}

export const ENCLAVE_INFORMATION_BUDGET_POLICY: EnclaveInformationBudgetPolicy = {
  runBits: ENCLAVE_SENSITIVITY_RUN_BITS,
};

export interface EnclaveInformationBudgetLedger {
  tryDebit(repoKey: string, bits: number, executor: EnclaveExecutorKind): boolean;
  remainingBits(repoKey: string): number | null | undefined;
}

/**
 * Creates one run-scoped ledger shared by script and agent executor calls.
 *
 * The executor argument is intentionally not part of the balance key: switching
 * executor kinds cannot reset or fork a repository's disclosure budget.
 */
export function createEnclaveInformationBudgetLedger(
  repositories: ReadonlyMap<string, { sensitivity: EnclaveSensitivity }>,
  policy: EnclaveInformationBudgetPolicy = ENCLAVE_INFORMATION_BUDGET_POLICY,
): EnclaveInformationBudgetLedger {
  const remaining = new Map<string, number | null>();
  for (const [repoKey, repository] of repositories) {
    remaining.set(normalizePrivateRepositoryKey(repoKey), policy.runBits[repository.sensitivity]);
  }

  return {
    tryDebit(repoKey, bits, _executor) {
      const normalizedRepoKey = normalizePrivateRepositoryKey(repoKey);
      if (!Number.isSafeInteger(bits) || bits < 0 || !remaining.has(normalizedRepoKey)) return false;
      const current = remaining.get(normalizedRepoKey);
      if (current === null) return true;
      if (current === undefined || bits > current) return false;
      remaining.set(normalizedRepoKey, current - bits);
      return true;
    },
    remainingBits(repoKey) {
      return remaining.get(normalizePrivateRepositoryKey(repoKey));
    },
  };
}
