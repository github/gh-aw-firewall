/**
 * Unit tests for host-iptables-validation.ts.
 *
 * Covers all exported functions with direct unit tests, including branches
 * that are only exercised indirectly (or not at all) by other test files:
 *
 * - getErrorStringProperty: all four condition branches of the compound ternary
 * - isMissingIptablesError: delegated to host-iptables-chain-branches.test.ts;
 *   included here for completeness of the module boundary
 * - parseValidPortSpecs: undefined input, empty string, invalid entries (warn),
 *   valid entries, mixed valid/invalid
 */

import { logger } from './logger';
import {
  getErrorStringProperty,
  isMissingIptablesError,
  parseValidPortSpecs,
} from './host-iptables-validation';

// ---------------------------------------------------------------------------
// getErrorStringProperty
// ---------------------------------------------------------------------------

describe('getErrorStringProperty', () => {
  it('returns the string property value when error is an object with the property as a string', () => {
    expect(getErrorStringProperty({ code: 'ENOENT' }, 'code')).toBe('ENOENT');
    expect(getErrorStringProperty({ stderr: 'Permission denied' }, 'stderr')).toBe('Permission denied');
  });

  it('returns empty string when the property value is not a string', () => {
    expect(getErrorStringProperty({ code: 42 }, 'code')).toBe('');
    expect(getErrorStringProperty({ code: null }, 'code')).toBe('');
    expect(getErrorStringProperty({ code: undefined }, 'code')).toBe('');
    expect(getErrorStringProperty({ code: { nested: true } }, 'code')).toBe('');
  });

  it('returns empty string when the property does not exist on the object', () => {
    expect(getErrorStringProperty({}, 'code')).toBe('');
    expect(getErrorStringProperty({ message: 'oops' }, 'stderr')).toBe('');
  });

  it('returns empty string when error is null', () => {
    expect(getErrorStringProperty(null, 'code')).toBe('');
  });

  it('returns empty string when error is not an object (string, number, boolean)', () => {
    expect(getErrorStringProperty('ENOENT', 'code')).toBe('');
    expect(getErrorStringProperty(42, 'code')).toBe('');
    expect(getErrorStringProperty(true, 'code')).toBe('');
  });

  it('returns the property value for an Error instance that has the property set', () => {
    const err = Object.assign(new Error('something'), { code: 'EACCES' });
    expect(getErrorStringProperty(err, 'code')).toBe('EACCES');
  });
});

// ---------------------------------------------------------------------------
// isMissingIptablesError (supplemental — core cases live in chain-branches.test.ts)
// ---------------------------------------------------------------------------

describe('isMissingIptablesError', () => {
  it('returns true for an Error whose message contains ENOENT', () => {
    expect(isMissingIptablesError(new Error('spawn iptables ENOENT'))).toBe(true);
  });

  it('returns true for an Error whose message contains "not found"', () => {
    expect(isMissingIptablesError(new Error('iptables: not found'))).toBe(true);
  });

  it('returns false for an unrelated Error', () => {
    expect(isMissingIptablesError(new Error('Permission denied'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseValidPortSpecs
// ---------------------------------------------------------------------------

describe('parseValidPortSpecs', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns empty array when input is undefined', () => {
    expect(parseValidPortSpecs(undefined, 'port')).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns empty array when input is empty string', () => {
    expect(parseValidPortSpecs('', 'port')).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns parsed ports for valid single-port entries', () => {
    expect(parseValidPortSpecs('80,443,8080', 'port')).toEqual(['80', '443', '8080']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns parsed ranges for valid port-range entries', () => {
    expect(parseValidPortSpecs('3000-3010,8080', 'port')).toEqual(['3000-3010', '8080']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips and warns for invalid port specs', () => {
    const result = parseValidPortSpecs('abc,443,99999', 'test-port');
    expect(result).toEqual(['443']);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith('Skipping invalid test-port: abc');
    expect(warnSpy).toHaveBeenCalledWith('Skipping invalid test-port: 99999');
  });

  it('skips empty entries between commas without warning', () => {
    const result = parseValidPortSpecs('80,,443', 'port');
    expect(result).toEqual(['80', '443']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('trims whitespace around entries', () => {
    const result = parseValidPortSpecs(' 80 , 443 ', 'port');
    expect(result).toEqual(['80', '443']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips whitespace-only entries without warning', () => {
    const result = parseValidPortSpecs('80,   ,443', 'port');
    expect(result).toEqual(['80', '443']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns empty array when all entries are invalid', () => {
    const result = parseValidPortSpecs('abc,def', 'port');
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
