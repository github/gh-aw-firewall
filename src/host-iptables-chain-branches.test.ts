/**
 * Branch coverage tests for host-iptables-chain.ts and host-iptables-validation.ts.
 *
 * These tests cover the two remaining uncovered branches identified by the
 * coverage report:
 *
 * 1. host-iptables-chain.ts — `checkPermissionsAndSetupChain`:
 *    `throw new Error('iptables is required but was not found...')` inside the
 *    DOCKER-USER check catch block — triggered when the DOCKER-USER list command
 *    fails with an ENOENT / "not found" error.
 *
 * 2. host-iptables-validation.ts — `isMissingIptablesError`:
 *    `error instanceof Error ? error.message : ''` — the `''` fallback branch
 *    exercised when `isMissingIptablesError` receives a non-Error thrown value
 *    (e.g. a plain object or string).
 */

import {
  execaResult,
  execaMissingCommandError,
  mockedExeca,
  setupHostIptablesTestSuite,
} from './test-helpers/host-iptables-test-setup';
import { checkPermissionsAndSetupChain } from './host-iptables-chain';
import { isMissingIptablesError } from './host-iptables-validation';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

describe('host-iptables-chain branch coverage', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  // -------------------------------------------------------------------------
  // checkPermissionsAndSetupChain – the DOCKER-USER list check fails with an
  // ENOENT / "not found" error.  This path re-throws as a user-readable
  // "iptables is required but was not found" message.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // checkPermissionsAndSetupChain – iptables --version fails with a non-ENOENT
  // error (e.g. unexpected system error).  This path re-throws the original error.
  // -------------------------------------------------------------------------
  describe('checkPermissionsAndSetupChain – iptables --version fails with non-ENOENT error', () => {
    it('rethrows the original error when iptables --version fails for a non-missing-command reason', async () => {
      const originalError = new Error('Unexpected iptables failure');
      mockedExeca
        // iptables --version — fails with a non-ENOENT error
        .mockRejectedValueOnce(originalError);

      await expect(checkPermissionsAndSetupChain('FW_TEST')).rejects.toBe(originalError);
    });
  });

  describe('checkPermissionsAndSetupChain – DOCKER-USER check fails with ENOENT', () => {
    it('throws a user-readable message when DOCKER-USER list reports iptables not found', async () => {
      mockedExeca
        // iptables --version — succeeds (iptables binary IS present)
        .mockResolvedValueOnce(execaResult({ exitCode: 0 }))
        // iptables -L DOCKER-USER — fails with ENOENT (iptables binary absent on this call)
        .mockRejectedValueOnce(execaMissingCommandError('iptables'));

      await expect(checkPermissionsAndSetupChain('FW_TEST')).rejects.toThrow(
        'iptables is required but was not found. Please install iptables and try again.',
      );
    });

    it('throws a user-readable message when DOCKER-USER list rejects with a "not found" message', async () => {
      const notFoundError = new Error('iptables: not found');

      mockedExeca
        // iptables --version — succeeds
        .mockResolvedValueOnce(execaResult({ exitCode: 0 }))
        // iptables -L DOCKER-USER — fails with "not found" in message
        .mockRejectedValueOnce(notFoundError);

      await expect(checkPermissionsAndSetupChain('FW_TEST')).rejects.toThrow(
        'iptables is required but was not found. Please install iptables and try again.',
      );
    });
  });
});

// -------------------------------------------------------------------------
// isMissingIptablesError – the `''` branch of the ternary:
//   `const message = error instanceof Error ? error.message : ''`
// This branch fires when the caught value is NOT an Error instance.
// -------------------------------------------------------------------------
describe('isMissingIptablesError – non-Error thrown values', () => {
  it('returns false for a plain object with no code or message (takes the "" branch)', () => {
    // Not an Error instance → message = '' → all three conditions false → returns false
    expect(isMissingIptablesError({ someKey: 'someValue' })).toBe(false);
  });

  it('returns false for a thrown string (takes the "" branch)', () => {
    // Strings are not Error instances; the '' branch produces no match
    expect(isMissingIptablesError('something went wrong')).toBe(false);
  });

  it('returns false for null (takes the "" branch)', () => {
    expect(isMissingIptablesError(null)).toBe(false);
  });

  it('returns true for a plain object with code ENOENT (takes the "" branch for message)', () => {
    // code === 'ENOENT' is true even though message falls to '' — confirms short-circuit
    expect(isMissingIptablesError({ code: 'ENOENT' })).toBe(true);
  });

  it('returns false for a plain object with non-ENOENT code (takes the "" branch)', () => {
    // code !== 'ENOENT', message = '' → no match
    expect(isMissingIptablesError({ code: 'EAGAIN', message: 'resource temporarily unavailable' })).toBe(false);
  });
});
