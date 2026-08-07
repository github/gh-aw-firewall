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
});
