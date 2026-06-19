import { execaResult, mockedExeca, setupHostIptablesTestSuite } from './test-helpers/host-iptables-test-setup';
import { setupHostIptables } from './host-iptables';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

describe('host-iptables (doh)', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  describe('setupHostIptables with DoH proxy', () => {
    it('should add HTTPS ACCEPT rule for DoH proxy when dohProxyIp is provided', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', stderr: '', exitCode: 0 }))
        // Mock iptables --version
        .mockResolvedValueOnce(execaResult({ stdout: '', stderr: '', exitCode: 0 }))
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce(execaResult({ stdout: '', stderr: '', exitCode: 0 }))
        // Mock chain existence check (doesn't exist)
        .mockResolvedValueOnce(execaResult({ exitCode: 1 }));

      // Mock all subsequent iptables calls
      mockedExeca.mockResolvedValue(execaResult({
        stdout: 'Chain DOCKER-USER\nChain FW_WRAPPER',
        stderr: '',
        exitCode: 0,
      }));

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, '172.30.0.40');

      // Verify HTTPS ACCEPT rule for DoH proxy
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-s', '172.30.0.40', '-p', 'tcp', '--dport', '443',
        '-j', 'ACCEPT',
      ]);

      // Verify DNS ACCEPT rules for DoH proxy
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '172.30.0.40', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.40', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
    });

    it('should not add DoH rules when dohProxyIp is not provided', async () => {
      mockedExeca
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', stderr: '', exitCode: 0 }))
        .mockResolvedValueOnce(execaResult({ stdout: '', stderr: '', exitCode: 0 }))
        .mockResolvedValueOnce(execaResult({ stdout: '', stderr: '', exitCode: 0 }))
        .mockResolvedValueOnce(execaResult({ exitCode: 1 }));

      mockedExeca.mockResolvedValue(execaResult({
        stdout: 'Chain DOCKER-USER\nChain FW_WRAPPER',
        stderr: '',
        exitCode: 0,
      }));

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Verify no DoH proxy rules were added
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '-s', '172.30.0.40',
      ]));
    });
  });
});
