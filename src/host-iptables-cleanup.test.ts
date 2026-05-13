import { execaResult, mockedExeca, setupHostIptablesTestSuite } from './test-helpers/host-iptables-test-setup';
import { cleanupHostIptables, setupHostIptables } from './host-iptables';
import { _resetIpv6State } from './host-iptables-shared';

describe('host-iptables (cleanup)', () => {
  setupHostIptablesTestSuite(_resetIpv6State);

  describe('cleanupHostIptables', () => {
    it('should flush and delete both FW_WRAPPER and FW_WRAPPER_V6 chains', async () => {
      mockedExeca.mockResolvedValue(execaResult({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      await cleanupHostIptables();

      // Verify IPv4 chain cleanup operations
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-F', 'FW_WRAPPER'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-X', 'FW_WRAPPER'], { reject: false });

      // Verify IPv6 chain cleanup operations
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-F', 'FW_WRAPPER_V6'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-X', 'FW_WRAPPER_V6'], { reject: false });
    });

    it('should re-enable IPv6 via sysctl on cleanup if it was disabled', async () => {
      // First, simulate setup that disabled IPv6
      mockedExeca
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', stderr: '', exitCode: 0 }))
        .mockResolvedValueOnce(execaResult({ stdout: '', stderr: '', exitCode: 0 }))
        .mockResolvedValueOnce(execaResult({ exitCode: 1 }));

      // Make ip6tables unavailable to trigger sysctl disable
      mockedExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Now run cleanup
      jest.clearAllMocks();
      mockedExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await cleanupHostIptables();

      // Verify IPv6 was re-enabled via sysctl
      expect(mockedExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=0']);
      expect(mockedExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=0']);
    });

    it('should clean up IPv6 rules from DOCKER-USER when ip6tables is available', async () => {
      // Mock all calls to succeed (ip6tables available)
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        // getNetworkBridgeName
        if (cmd === 'docker' && args[0] === 'network') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        // ip6tables -L -n (availability check)
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('-n') && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        // ip6tables DOCKER-USER listing with FW_WRAPPER_V6 reference
        if (cmd === 'ip6tables' && args.includes('DOCKER-USER') && args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '1    FW_WRAPPER_V6  all  --  *      *       ::/0                 ::/0\n', stderr: '', exitCode: 0 });
        }
        // iptables DOCKER-USER listing with FW_WRAPPER reference
        if (cmd === 'iptables' && args.includes('DOCKER-USER') && args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '1    FW_WRAPPER  all  --  -i fw-bridge  -o fw-bridge  0.0.0.0/0            0.0.0.0/0\n', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await cleanupHostIptables();

      // Verify IPv6 chain was flushed and deleted
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-F', 'FW_WRAPPER_V6'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-X', 'FW_WRAPPER_V6'], { reject: false });
      // Verify IPv6 DOCKER-USER rule was removed
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-D', 'DOCKER-USER', '1'], { reject: false });
      // Verify IPv4 chain was also cleaned
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-F', 'FW_WRAPPER'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-X', 'FW_WRAPPER'], { reject: false });
    });

    it('should skip IPv6 cleanup when ip6tables is not available', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        if (cmd === 'iptables' && args.includes('DOCKER-USER') && args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await cleanupHostIptables();

      // Should NOT attempt ip6tables cleanup (except the availability check)
      expect(mockedExeca).not.toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-F', 'FW_WRAPPER_V6'], { reject: false });
    });

    it('should not throw on errors (best-effort cleanup)', async () => {
      mockedExeca.mockRejectedValue(new Error('iptables error'));

      // Should not throw
      await expect(cleanupHostIptables()).resolves.not.toThrow();
    });
  });

  describe('cleanupHostIptables when bridge name is null', () => {
    it('should skip IPv4 DOCKER-USER rule removal when bridge name is not found', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        // getNetworkBridgeName returns empty string → null
        if (cmd === 'docker' && args[0] === 'network' && args[1] === 'inspect') {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await cleanupHostIptables();

      // Should NOT attempt to list DOCKER-USER rules (bridge name is null)
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
      ], { reject: false });

      // Should still flush/delete the chain
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-F', 'FW_WRAPPER'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-X', 'FW_WRAPPER'], { reject: false });
    });
  });
});
