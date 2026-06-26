import {
  mockedExeca,
  setupDefaultIptablesMocks,
  setupDockerBridgeMock,
  setupHostIptablesTestSuite,
} from './test-helpers/host-iptables-test-setup';
import { iptablesRulesTestHelpers } from './host-iptables-rules.test-utils';
import { setupHostIptables } from './host-iptables';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

describe('host-iptables (setup) — port-spec validation and edge cases', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  describe('isValidPortSpec', () => {
    it('should accept valid single ports', () => {
      expect(iptablesRulesTestHelpers.isValidPortSpec('1')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('80')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('443')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('65535')).toBe(true);
    });

    it('should accept valid port ranges', () => {
      expect(iptablesRulesTestHelpers.isValidPortSpec('3000-3010')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('1-65535')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('80-80')).toBe(true);
    });

    it('should reject invalid port specs', () => {
      expect(iptablesRulesTestHelpers.isValidPortSpec('abc')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('0')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('65536')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('-1')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('99999')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('3010-3000')).toBe(false); // reversed range
      expect(iptablesRulesTestHelpers.isValidPortSpec('')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('080-090')).toBe(false); // leading zeros in range
      expect(iptablesRulesTestHelpers.isValidPortSpec('01-100')).toBe(false); // leading zero in start
      expect(iptablesRulesTestHelpers.isValidPortSpec('1-0100')).toBe(false); // leading zero in end
    });
  });

  describe('setupHostIptables with empty entries in allowHostPorts', () => {
    it('should skip empty entries in allowHostPorts (covers parseValidPortSpecs empty-entry branch)', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock({ gateway: '', exitCode: 1 });

      // "80,,443,8080" contains an empty entry between the two commas; 8080 is a non-default port
      await setupHostIptables(
        '172.30.0.10', 3128, ['8.8.8.8'],
        undefined, undefined,
        { enabled: true, allowHostPorts: '80,,443,8080' },
      );

      // Non-default port should be added; empty entry should be silently skipped
      expect(mockedExeca).toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '--dport', '8080',
      ]));
    });
  });
});
