/**
 * Targeted branch coverage tests for host-iptables-rules.ts and host-iptables-shared.ts.
 *
 * This file covers three specific uncovered branches identified in the coverage report:
 *
 * 1. checkPermissionsAndSetupChain – fallback to empty stderr string when the thrown error has no
 *    string `stderr` property (e.g. a plain `new Error()` rather than an ExecaError).
 * 2. addIpv6DnsRules – fallback to DEFAULT_DNS_SERVERS when `dnsServers` is an empty array.
 * 3. cleanupChain – skip deletion for matching lines that don't start with a digit (no line number).
 */

import {
  execaResult,
  mockedExeca,
  setupDefaultIptablesMocks,
  setupHostIptablesTestSuite,
} from './test-helpers/host-iptables-test-setup';
import { setupHostIptables } from './host-iptables';
import { cleanupChain } from './host-iptables-shared';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

describe('host-iptables branch coverage', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  // -------------------------------------------------------------------------
  // Branch 1: host-iptables-rules.ts line 85
  // checkPermissionsAndSetupChain – the ternary `? error.stderr : ''` when the
  // thrown error object does NOT have a string `stderr` property.
  // -------------------------------------------------------------------------
  describe('checkPermissionsAndSetupChain – no-stderr error object', () => {
    it('treats missing stderr as empty string and proceeds with chain creation', async () => {
      // Throw a plain Error (no .stderr property) from the DOCKER-USER list check.
      // This forces the ternary on line 85 to evaluate the `''` (else) branch.
      mockedExeca
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', exitCode: 0 })) // getNetworkBridgeName
        .mockRejectedValueOnce(new Error('iptables: table locked'))               // DOCKER-USER check – no stderr
        .mockResolvedValueOnce(execaResult({ exitCode: 0 }))                      // iptables -N DOCKER-USER
        .mockResolvedValueOnce(execaResult({ exitCode: 1 }));                     // FW_WRAPPER existence check

      mockedExeca.mockResolvedValue(execaResult({ stdout: '', exitCode: 0 }));

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // The chain creation call proves we went through the warn branch (not the Permission denied throw)
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-N', 'DOCKER-USER']);
    });
  });

  // -------------------------------------------------------------------------
  // Branch 2: host-iptables-rules.ts line 172
  // addIpv6DnsRules – the ternary `dnsServers.length > 0 ? dnsServers : DEFAULT_DNS_SERVERS`
  // when an empty dnsServers array is passed.
  // -------------------------------------------------------------------------
  describe('addIpv6DnsRules – empty dnsServers falls back to DEFAULT_DNS_SERVERS', () => {
    it('uses Google DNS (8.8.8.8, 8.8.4.4) when dnsServers is an empty array', async () => {
      setupDefaultIptablesMocks();

      await setupHostIptables('172.30.0.10', 3128, []);

      // Verify that rules for the default DNS servers were added
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.4.4', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '8.8.4.4', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Branch 3: host-iptables-shared.ts line 171 (inside cleanupChain)
  // The `if (match)` check: when shouldDelete is true but the line does NOT
  // start with a digit (e.g. an iptables header like "Chain FW_WRAPPER (2 references)"),
  // the regex match is null and the line number is silently skipped.
  // -------------------------------------------------------------------------
  describe('cleanupChain – shouldDelete true but line has no leading digit', () => {
    it('silently skips matching lines that lack a numeric prefix', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'iptables' && Array.isArray(args) && args.includes('--line-numbers')) {
          // Include a line that matches the chain name but has no leading digits (match = null).
          return Promise.resolve(execaResult({
            stdout: [
              'FW_WRAPPER all -- 0.0.0.0/0 0.0.0.0/0',
              '1 FW_WRAPPER all -- 0.0.0.0/0 0.0.0.0/0',
              '',
            ].join('\n'),
          }));
        }
        return Promise.resolve(execaResult());
      }) as any);

      await cleanupChain('iptables', 'FW_WRAPPER');

      // Only the numeric line (1) should produce a delete call
      expect(mockedExeca).toHaveBeenCalledWith(
        'iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '1'], { reject: false }
      );

      // The header line must NOT have generated any additional delete call
      const deleteCalls = (mockedExeca as jest.Mock).mock.calls.filter(
        ([_cmd, args]: [string, string[]]) =>
          _cmd === 'iptables' && Array.isArray(args) && args.includes('-D') && args.includes('DOCKER-USER')
      );
      expect(deleteCalls).toHaveLength(1);
    });
  });
});
