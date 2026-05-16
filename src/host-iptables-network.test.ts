import { execaResult, mockedExeca, setupHostIptablesTestSuite } from './test-helpers/host-iptables-test-setup';
import { testHelpers as networkTestHelpers } from './host-iptables-network';
import { ensureFirewallNetwork } from './host-iptables';
import { testHelpers } from './host-iptables-shared';

const { cleanupFirewallNetwork } = networkTestHelpers;

describe('host-iptables (network)', () => {
  setupHostIptablesTestSuite(testHelpers.resetIpv6State);

  describe('ensureFirewallNetwork', () => {
    it('should return network config when network already exists', async () => {
      // Mock successful network inspect (network exists)
      mockedExeca.mockResolvedValue(execaResult({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      const result = await ensureFirewallNetwork();

      expect(result).toEqual({
        subnet: '172.30.0.0/24',
        squidIp: '172.30.0.10',
        agentIp: '172.30.0.20',
        proxyIp: '172.30.0.30',
      });

      // Should only check if network exists, not create it
      expect(mockedExeca).toHaveBeenCalledWith('docker', ['network', 'inspect', 'awf-net'], { env: expect.any(Object) });
      expect(mockedExeca).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['network', 'create']), expect.anything());
    });

    it('should create network when it does not exist', async () => {
      // First call (network inspect) fails - network doesn't exist
      // Second call (network create) succeeds
      mockedExeca
        .mockRejectedValueOnce(new Error('network not found'))
        .mockResolvedValueOnce(execaResult({
          stdout: '',
          stderr: '',
          exitCode: 0,
        }));

      const result = await ensureFirewallNetwork();

      expect(result).toEqual({
        subnet: '172.30.0.0/24',
        squidIp: '172.30.0.10',
        agentIp: '172.30.0.20',
        proxyIp: '172.30.0.30',
      });

      expect(mockedExeca).toHaveBeenCalledWith('docker', ['network', 'inspect', 'awf-net'], { env: expect.any(Object) });
      expect(mockedExeca).toHaveBeenCalledWith('docker', [
        'network',
        'create',
        'awf-net',
        '--subnet',
        '172.30.0.0/24',
        '--opt',
        'com.docker.network.bridge.name=fw-bridge',
      ], { env: expect.any(Object) });
    });
  });

  describe('cleanupFirewallNetwork', () => {
    it('should remove the firewall network', async () => {
      mockedExeca.mockResolvedValue(execaResult({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      await cleanupFirewallNetwork();

      expect(mockedExeca).toHaveBeenCalledWith('docker', ['network', 'rm', 'awf-net'], { reject: false, env: expect.any(Object) });
    });

    it('should not throw on errors (best-effort cleanup)', async () => {
      mockedExeca.mockRejectedValue(new Error('network removal error'));

      // Should not throw
      await expect(cleanupFirewallNetwork()).resolves.not.toThrow();
    });
  });
});
