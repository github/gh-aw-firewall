'use strict';

/**
 * Repository sensitivity categories and their fixed per-run information
 * budgets — broker-side mirror of `BOUNDED_QUERY_SENSITIVITY_RUN_BITS` in
 * `src/types/bounded-query-options.ts`. Kept in a tiny standalone module (not
 * `protocol.js`) because it is config/ledger data, not wire protocol.
 *
 * `null` means "unmetered": `public` still runs through the same finite
 * schema/result validation and operational limits (`maxInvocations`,
 * timeouts, sandboxing) as every other category, but its responses are not
 * debited against a confidentiality ledger. `sealed` is `0`, which —
 * because every accepted query's minimum charge is 4 bits (1 status bit +
 * 3 timing bits) — always exceeds the remaining balance, so a `sealed`
 * repository can never fund a single query and therefore never copies a
 * seed or launches Python.
 */
const BOUNDED_QUERY_SENSITIVITIES = ['public', 'internal', 'confidential', 'sealed'];

const BOUNDED_QUERY_SENSITIVITY_RUN_BITS = {
  public: null,
  internal: 64,
  confidential: 8,
  sealed: 0,
};

module.exports = { BOUNDED_QUERY_SENSITIVITIES, BOUNDED_QUERY_SENSITIVITY_RUN_BITS };
