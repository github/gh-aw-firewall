import { execaResult, mockedExeca, setupHostIptablesTestSuite } from './test-helpers/host-iptables-test-setup';
import { ensureFirewallNetwork } from './host-iptables';
import { AGENT_IP, API_PROXY_IP, NETWORK_SUBNET, SQUID_IP } from './host-iptables-shared';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

describe('host-iptables (network)', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

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
        subnet: NETWORK_SUBNET,
        squidIp: SQUID_IP,
        agentIp: AGENT_IP,
        proxyIp: API_PROXY_IP,
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
        subnet: NETWORK_SUBNET,
        squidIp: SQUID_IP,
        agentIp: AGENT_IP,
        proxyIp: API_PROXY_IP,
      });

      expect(mockedExeca).toHaveBeenCalledWith('docker', ['network', 'inspect', 'awf-net'], { env: expect.any(Object) });
      expect(mockedExeca).toHaveBeenCalledWith('docker', [
        'network',
        'create',
        'awf-net',
        '--subnet',
        NETWORK_SUBNET,
        '--opt',
        'com.docker.network.bridge.name=fw-bridge',
      ], { env: expect.any(Object) });
    });
  });
});
