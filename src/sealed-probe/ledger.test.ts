import * as path from 'path';

/**
 * Unit tests for the per-repository information-budget ledger.
 *
 * There is no per-query cap: every invocation's schema-derived charge (see
 * `queryBitsForSchema` in `./protocol`) is atomically checked against and
 * debited from the repository's shared run balance. These tests exercise
 * the ledger in isolation, independent of the broker's orchestration.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'sealed-probe', 'broker');
const { createLedger } = require(path.join(brokerDir, 'ledger.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

interface Ledger {
  tryDebit(repoKey: string, bits: number): boolean;
  remainingBits(repoKey: string): number | null | undefined;
}

function buildLedger(seeds: Array<[string, string]>): Ledger {
  return createLedger(new Map(seeds.map(([repo, sensitivity]) => [repo, { seedId: 'seed', sensitivity }])));
}

describe('createLedger', () => {
  it('starts each repository at its sensitivity-derived run budget', () => {
    const ledger = buildLedger([
      ['octo/pub', 'public'],
      ['octo/int', 'internal'],
      ['octo/conf', 'confidential'],
      ['octo/sealed', 'sealed'],
    ]);

    expect(ledger.remainingBits('octo/pub')).toBeNull();
    expect(ledger.remainingBits('octo/int')).toBe(64);
    expect(ledger.remainingBits('octo/conf')).toBe(8);
    expect(ledger.remainingBits('octo/sealed')).toBe(0);
  });

  it('returns undefined for a repository outside the ledger', () => {
    const ledger = buildLedger([['octo/int', 'internal']]);
    expect(ledger.remainingBits('octo/unknown')).toBeUndefined();
  });

  it('debits exactly the requested charge on success', () => {
    const ledger = buildLedger([['octo/int', 'internal']]);
    expect(ledger.tryDebit('octo/int', 10)).toBe(true);
    expect(ledger.remainingBits('octo/int')).toBe(54);
    expect(ledger.tryDebit('octo/int', 54)).toBe(true);
    expect(ledger.remainingBits('octo/int')).toBe(0);
  });

  it('denies (without debiting) a charge exceeding the remaining balance', () => {
    const ledger = buildLedger([['octo/conf', 'confidential']]);
    expect(ledger.tryDebit('octo/conf', 9)).toBe(false);
    expect(ledger.remainingBits('octo/conf')).toBe(8);
  });

  it('allows a charge exactly equal to the remaining balance (exhausting it)', () => {
    const ledger = buildLedger([['octo/conf', 'confidential']]);
    expect(ledger.tryDebit('octo/conf', 8)).toBe(true);
    expect(ledger.remainingBits('octo/conf')).toBe(0);
    // Even the cheapest possible charge (4 bits: 1 status + 0 const + 3 timing) is now unaffordable.
    expect(ledger.tryDebit('octo/conf', 4)).toBe(false);
  });

  it('a sealed (0-bit) repository can never afford any positive charge', () => {
    const ledger = buildLedger([['octo/sealed', 'sealed']]);
    expect(ledger.tryDebit('octo/sealed', 1)).toBe(false);
    expect(ledger.tryDebit('octo/sealed', 0)).toBe(true); // A zero-bit charge is not physically possible in practice (min charge is 4), but is not itself unaffordable.
    expect(ledger.remainingBits('octo/sealed')).toBe(0);
  });

  it('a public (unmetered) repository can never be exhausted regardless of charge size', () => {
    const ledger = buildLedger([['octo/pub', 'public']]);
    expect(ledger.tryDebit('octo/pub', 1_000_000)).toBe(true);
    expect(ledger.tryDebit('octo/pub', Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(ledger.remainingBits('octo/pub')).toBeNull();
  });

  it('denies a debit against an unknown repository', () => {
    const ledger = buildLedger([['octo/int', 'internal']]);
    expect(ledger.tryDebit('octo/unknown', 1)).toBe(false);
  });

  it('tracks balances independently per repository', () => {
    const ledger = buildLedger([
      ['octo/a', 'internal'],
      ['octo/b', 'internal'],
    ]);
    expect(ledger.tryDebit('octo/a', 60)).toBe(true);
    expect(ledger.remainingBits('octo/a')).toBe(4);
    expect(ledger.remainingBits('octo/b')).toBe(64);
  });

  it('never refunds a charge, regardless of the invocation outcome', () => {
    // The ledger API has no refund/credit operation at all — modeling the
    // "never refunded" guarantee structurally rather than behaviorally.
    const ledger = buildLedger([['octo/int', 'internal']]);
    expect(Object.keys(ledger)).not.toContain('refund');
    expect(Object.keys(ledger)).not.toContain('credit');
  });

  it('accumulates many small debits down to exactly zero remaining', () => {
    const ledger = buildLedger([['octo/int', 'internal']]);
    for (let i = 0; i < 16; i++) {
      expect(ledger.tryDebit('octo/int', 4)).toBe(true);
    }
    expect(ledger.remainingBits('octo/int')).toBe(0);
    expect(ledger.tryDebit('octo/int', 1)).toBe(false);
  });
});
