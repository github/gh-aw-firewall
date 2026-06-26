import {
  mockedExeca,
  setupDefaultIptablesMocks,
  setupHostIptablesTestSuite,
} from './test-helpers/host-iptables-test-setup';
import { setupHostIptables } from './host-iptables';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

describe('host-iptables (setup) — IPv6 DNS server handling', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  describe('setupHostIptables with IPv6 DNS servers', () => {
    it('should create FW_WRAPPER_V6 chain and add IPv6 DNS rules when ip6tables is available', async () => {
      setupDefaultIptablesMocks();

      // ip6tables available; FW_WRAPPER_V6 does not exist
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // Verify IPv6 chain creation
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);

      // Verify IPv6 DNS allow rules
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'udp', '-d', '2001:4860:4860::8888', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'tcp', '-d', '2001:4860:4860::8888', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      // IPv4 DNS rule should still be added via iptables
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
    });

    it('should flush existing FW_WRAPPER_V6 chain if it already exists', async () => {
      setupDefaultIptablesMocks();

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        // ip6tables availability check (-L -n without chain name)
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('-n') && !args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        // FW_WRAPPER_V6 chain already exists
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // Should flush and delete existing chain
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-F', 'FW_WRAPPER_V6'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-X', 'FW_WRAPPER_V6'], { reject: false });
      // Then recreate
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);
    });

    it('should skip IPv6 DNS rules (not create chain) when ip6tables is unavailable', async () => {
      setupDefaultIptablesMocks();

      mockedExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // Should NOT create IPv6 chain
      expect(mockedExeca).not.toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);
    });
  });
});
