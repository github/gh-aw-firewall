'use strict';

const { ENCLAVE_INFORMATION_BUDGET_POLICY } = require('./sensitivity-policy');

/**
 * Per-repository information-budget ledger.
 *
 * There is no per-query cap: every invocation may use an arbitrarily
 * different schema, and its maximum complete-transcript charge (see
 * `queryBitsForSchema` in `./protocol`) is computed and debited from the
 * repository's shared run balance *before* a seed is copied or Python is
 * launched. An invocation is allowed iff its charge fits the remaining
 * balance. Charges are never refunded, regardless of the invocation's
 * outcome (success, failure, or timeout) — the broker committed to
 * revealing up to that many bits of signal the moment it decided to run.
 *
 * The ledger's scope is one broker process — one AWF run. The broker has no
 * durable identity or storage across runs.
 */

/**
 * Builds a ledger from the loaded seed map.
 *
 * @param seeds `Map<normalizedRepoKey, { seedId, sensitivity }>` as returned
 *   by `config.loadSeedMap`.
 */
function createLedger(seeds, policy = ENCLAVE_INFORMATION_BUDGET_POLICY) {
  const remaining = new Map();
  for (const [repoKey, seed] of seeds) {
    remaining.set(repoKey.toLowerCase(), policy.runBits[seed.sensitivity]);
  }

  return {
    /**
     * Atomically checks and debits `bits` from `repoKey`'s remaining
     * balance. Returns `true` (and debits) iff the charge is affordable;
     * returns `false` (and leaves the balance untouched) otherwise. Safe
     * to call synchronously with no intervening `await` — Node's
     * single-threaded event loop makes this indivisible.
     */
    tryDebit(repoKey, bits, executorKind = 'script') {
      if (executorKind !== 'script' && executorKind !== 'agent') return false;
      if (!Number.isSafeInteger(bits) || bits < 0) return false;
      const normalizedRepoKey = repoKey.toLowerCase();
      if (!remaining.has(normalizedRepoKey)) return false;
      const current = remaining.get(normalizedRepoKey);
      if (current === null) return true; // unmetered (public)
      if (bits > current) return false;
      remaining.set(normalizedRepoKey, current - bits);
      return true;
    },

    /** Returns the remaining balance for a repo, or `undefined` if unknown. */
    remainingBits(repoKey) {
      return remaining.get(repoKey.toLowerCase());
    },
  };
}

module.exports = {
  createEnclaveInformationBudgetLedger: createLedger,
  createLedger,
  createSensitivityLedger: createLedger,
};
