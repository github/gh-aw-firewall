import * as path from 'path';
import {
  createEnclaveInformationBudgetLedger,
  ENCLAVE_INFORMATION_BUDGET_POLICY,
} from './information-budget';
import {
  ENCLAVE_SENSITIVITIES,
  ENCLAVE_SENSITIVITY_RUN_BITS,
} from '../types/enclave-options';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerPolicy = require(
  path.join(__dirname, '..', '..', 'containers', 'bounded-execution', 'sensitivity-policy.js'),
);
const brokerLedger = require(
  path.join(__dirname, '..', '..', 'containers', 'bounded-execution', 'sensitivity-ledger.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

describe('enclave information budget', () => {
  it('matches the server-side sensitivity policy', () => {
    expect(ENCLAVE_SENSITIVITIES).toEqual(brokerPolicy.ENCLAVE_SENSITIVITIES);
    expect(ENCLAVE_SENSITIVITY_RUN_BITS).toEqual(brokerPolicy.ENCLAVE_SENSITIVITY_RUN_BITS);
    expect(ENCLAVE_INFORMATION_BUDGET_POLICY.runBits).toBe(ENCLAVE_SENSITIVITY_RUN_BITS);
  });

  it('shares one repository balance across script and agent invocations', () => {
    const ledger = createEnclaveInformationBudgetLedger(new Map([
      ['octo/private', { sensitivity: 'confidential' as const }],
    ]));

    expect(ledger.tryDebit('octo/private', 4, 'script')).toBe(true);
    expect(ledger.remainingBits('octo/private')).toBe(4);
    expect(ledger.tryDebit('Octo/Private', 4, 'agent')).toBe(true);
    expect(ledger.remainingBits('OCTO/PRIVATE')).toBe(0);
    expect(ledger.tryDebit('octo/private', 1, 'script')).toBe(false);
  });

  it('opens a balance for a dynamically admitted repository exactly once', () => {
    const ledger = createEnclaveInformationBudgetLedger(new Map());

    expect(ledger.remainingBits('octo/dynamic')).toBeUndefined();
    expect(ledger.tryDebit('octo/dynamic', 1, 'agent')).toBe(false);

    ledger.registerRepository('Octo/Dynamic', 'confidential');
    expect(ledger.remainingBits('octo/dynamic')).toBe(8);
    expect(ledger.tryDebit('octo/dynamic', 8, 'agent')).toBe(true);

    // Re-admitting the same repository never refills a spent budget.
    ledger.registerRepository('octo/dynamic', 'confidential');
    expect(ledger.remainingBits('octo/dynamic')).toBe(0);
    expect(ledger.tryDebit('octo/dynamic', 1, 'script')).toBe(false);
    expect(() => ledger.registerRepository('octo/other', 'bogus' as never)).toThrow(/sensitivity/);
  });

  it('registers repositories identically in the in-image broker ledger', () => {
    const broker = brokerLedger.createEnclaveInformationBudgetLedger(new Map());

    expect(broker.remainingBits('octo/dynamic')).toBeUndefined();
    broker.registerRepository('Octo/Dynamic', 'confidential');
    expect(broker.remainingBits('octo/dynamic')).toBe(8);
    expect(broker.tryDebit('octo/dynamic', 8, 'agent')).toBe(true);
    broker.registerRepository('octo/dynamic', 'confidential');
    expect(broker.remainingBits('octo/dynamic')).toBe(0);
    expect(() => broker.registerRepository('octo/other', 'bogus')).toThrow(/sensitivity/);
  });

  it('keeps trusted repositories unmetered', () => {
    const ledger = createEnclaveInformationBudgetLedger(new Map([
      ['octo/trusted', { sensitivity: 'trusted' as const }],
    ]));

    expect(ledger.tryDebit('octo/trusted', Number.MAX_SAFE_INTEGER, 'agent')).toBe(true);
    expect(ledger.remainingBits('octo/trusted')).toBeNull();
  });
});
