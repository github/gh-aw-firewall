/**
 * Unit tests for host-iptables-rules.ts internals.
 *
 * The integration-level behaviour (setupHostIptables full flows with hostAccess,
 * cliProxy, DoH, etc.) lives in host-iptables-setup.test.ts and
 * host-iptables-host-access.test.ts. This file adds focused unit coverage for
 * pure-logic helpers that those suites only sanity-check:
 *
 *   - isValidPortSpec  – boundary values, leading zeros, floats, ranges
 *
 * The fixture-driven suite at the bottom validates all cases from
 * tests/port-spec-fixtures.json, which is the single source of truth shared
 * with the shell is_valid_port_spec() in containers/agent/setup-iptables.sh.
 */

import * as path from 'path';
import { iptablesRulesTestHelpers } from './host-iptables-rules.test-utils';

const { isValidPortSpec } = iptablesRulesTestHelpers;

describe('isValidPortSpec – single port', () => {
  it('accepts the minimum valid port (1)', () => {
    expect(isValidPortSpec('1')).toBe(true);
  });

  it('accepts the maximum valid port (65535)', () => {
    expect(isValidPortSpec('65535')).toBe(true);
  });

  it('accepts common HTTP / HTTPS ports', () => {
    expect(isValidPortSpec('80')).toBe(true);
    expect(isValidPortSpec('443')).toBe(true);
    expect(isValidPortSpec('3128')).toBe(true);
  });

  it('rejects port 0 (below the valid range)', () => {
    expect(isValidPortSpec('0')).toBe(false);
  });

  it('rejects port 65536 (above the valid range)', () => {
    expect(isValidPortSpec('65536')).toBe(false);
  });

  it('rejects very large numbers', () => {
    expect(isValidPortSpec('99999')).toBe(false);
    expect(isValidPortSpec('100000')).toBe(false);
  });

  it('rejects negative numbers', () => {
    expect(isValidPortSpec('-1')).toBe(false);
    expect(isValidPortSpec('-80')).toBe(false);
    expect(isValidPortSpec('-443')).toBe(false);
  });

  it('rejects port with leading zeros', () => {
    // parseInt("080") === 80 but String(80) !== "080"
    expect(isValidPortSpec('080')).toBe(false);
    expect(isValidPortSpec('0080')).toBe(false);
    expect(isValidPortSpec('00443')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidPortSpec('')).toBe(false);
  });

  it('rejects purely alphabetic strings', () => {
    expect(isValidPortSpec('abc')).toBe(false);
    expect(isValidPortSpec('http')).toBe(false);
    expect(isValidPortSpec('NaN')).toBe(false);
  });

  it('rejects alphanumeric strings', () => {
    expect(isValidPortSpec('80abc')).toBe(false);
    expect(isValidPortSpec('abc80')).toBe(false);
    expect(isValidPortSpec('8 0')).toBe(false);
  });

  it('rejects floating-point port numbers (integer part is valid but whole spec is not)', () => {
    expect(isValidPortSpec('80.5')).toBe(false);
    expect(isValidPortSpec('3000.0')).toBe(false);
  });

  it('rejects strings with leading or trailing whitespace', () => {
    expect(isValidPortSpec(' 80')).toBe(false);
    expect(isValidPortSpec('80 ')).toBe(false);
    expect(isValidPortSpec(' 80 ')).toBe(false);
  });
});

describe('isValidPortSpec – port range', () => {
  it('accepts a valid minimal range (1-2)', () => {
    expect(isValidPortSpec('1-2')).toBe(true);
  });

  it('accepts the full valid range (1-65535)', () => {
    expect(isValidPortSpec('1-65535')).toBe(true);
  });

  it('accepts a single-value range (equal start and end)', () => {
    expect(isValidPortSpec('80-80')).toBe(true);
    expect(isValidPortSpec('65535-65535')).toBe(true);
  });

  it('accepts typical application port ranges', () => {
    expect(isValidPortSpec('3000-3010')).toBe(true);
    expect(isValidPortSpec('8080-8090')).toBe(true);
    expect(isValidPortSpec('10000-10003')).toBe(true);
  });

  it('rejects a reversed range (start > end)', () => {
    expect(isValidPortSpec('3010-3000')).toBe(false);
    expect(isValidPortSpec('65535-1')).toBe(false);
    expect(isValidPortSpec('443-80')).toBe(false);
  });

  it('rejects a range whose start is 0', () => {
    expect(isValidPortSpec('0-100')).toBe(false);
    expect(isValidPortSpec('0-65535')).toBe(false);
  });

  it('rejects a range whose end is 0', () => {
    expect(isValidPortSpec('100-0')).toBe(false);
  });

  it('rejects a range whose end exceeds 65535', () => {
    expect(isValidPortSpec('1-65536')).toBe(false);
    expect(isValidPortSpec('60000-70000')).toBe(false);
  });

  it('rejects a range whose start exceeds 65535', () => {
    expect(isValidPortSpec('65536-65537')).toBe(false);
  });

  it('rejects a range with leading zeros in the start value', () => {
    // String(parseInt("01", 10)) = "1" !== "01"
    expect(isValidPortSpec('01-100')).toBe(false);
    expect(isValidPortSpec('008-100')).toBe(false);
  });

  it('rejects a range with leading zeros in the end value', () => {
    expect(isValidPortSpec('1-0100')).toBe(false);
    expect(isValidPortSpec('80-0443')).toBe(false);
  });

  it('rejects a range with both parts having leading zeros', () => {
    expect(isValidPortSpec('080-0443')).toBe(false);
  });

  it('rejects non-numeric range components', () => {
    expect(isValidPortSpec('abc-def')).toBe(false);
  });

  it('rejects a single hyphen (empty range components)', () => {
    // "-" has digits on neither side matching /^(\d+)-(\d+)$/
    expect(isValidPortSpec('-')).toBe(false);
  });

  it('rejects a range with whitespace', () => {
    // Spaces are not digits, so the regex won't match
    expect(isValidPortSpec('80 - 443')).toBe(false);
    expect(isValidPortSpec('80- 443')).toBe(false);
    expect(isValidPortSpec(' 80-443')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture-driven suite — single source of truth shared with the shell
// is_valid_port_spec() in containers/agent/setup-iptables.sh.
// tests/port-spec-fixtures.json is authoritative; both implementations are
// expected to conform to every case defined there.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const portSpecFixtures: { valid: string[]; invalid: string[] } = require(
  path.join(__dirname, '..', 'tests', 'port-spec-fixtures.json'),
);

describe('isValidPortSpec – shared fixtures (tests/port-spec-fixtures.json)', () => {
  it.each(portSpecFixtures.valid)('accepts valid spec %j', (spec) => {
    expect(isValidPortSpec(spec)).toBe(true);
  });

  it.each(portSpecFixtures.invalid)('rejects invalid spec %j', (spec) => {
    expect(isValidPortSpec(spec)).toBe(false);
  });
});
