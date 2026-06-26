import {
  execaError,
  execaResult,
  mockedExeca,
  setupDefaultIptablesMocks,
  setupHostIptablesTestSuite,
} from './test-helpers/host-iptables-test-setup';
import { setupHostIptables } from './host-iptables';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

describe('host-iptables (setup) — error paths and cleanup resilience', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  describe('setupHostIptables DOCKER-USER chain creation failure', () => {
    it('should throw when DOCKER-USER chain does not exist and creation fails', async () => {
      const noChainError = execaError('No chain by that name');

      mockedExeca
        // getNetworkBridgeName
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', stderr: '', exitCode: 0 }))
        // iptables --version
        .mockResolvedValueOnce(execaResult())
        // iptables -L DOCKER-USER (chain doesn't exist)
        .mockRejectedValueOnce(noChainError)
        // iptables -N DOCKER-USER (creation fails)
        .mockRejectedValueOnce(new Error('Failed to create chain'));

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'])).rejects.toThrow(
        'Failed to create DOCKER-USER chain'
      );
    });
  });

  describe('setupHostIptables chain cleanup error handling', () => {
    it('should continue setup when existing FW_WRAPPER chain cleanup throws', async () => {
      // chain exists (exitCode 0) but cleanupChain throws — should be swallowed and setup continues
      mockedExeca
        // getNetworkBridgeName
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', exitCode: 0 }))
        // iptables --version
        .mockResolvedValueOnce(execaResult({ exitCode: 0, stdout: '' }))
        // iptables -L DOCKER-USER (permission check) — success
        .mockResolvedValueOnce(execaResult({ exitCode: 0, stdout: '' }))
        // iptables -L FW_WRAPPER (check if chain exists) — exists
        .mockResolvedValueOnce(execaResult({ exitCode: 0 }));

      // cleanupChain calls: list DOCKER-USER --line-numbers (throw here)
      mockedExeca.mockRejectedValueOnce(new Error('unexpected cleanup error'));

      // remaining calls succeed
      mockedExeca.mockResolvedValue(execaResult({ stdout: '', exitCode: 0 }));

      // should NOT throw — the catch block swallows the error
      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'])).resolves.toBeUndefined();
    });

    it('should continue setup when IPv6 chain cleanup throws', async () => {
      setupDefaultIptablesMocks();

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        // ip6tables availability check — available
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('-n') && !args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        // FW_WRAPPER_V6 check — exists
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        // ip6tables -F (flush) — throw to exercise IPv6 chain cleanup error swallowing path
        if (cmd === 'ip6tables' && args.includes('-F')) {
          throw new Error('flush failed unexpectedly');
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      // Should NOT throw — the catch block at line 213 swallows the error
      await expect(
        setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']),
      ).resolves.toBeUndefined();
    });
  });
});
