import { execaResult, mockedExeca, setupHostIptablesTestSuite } from './test-helpers/host-iptables-test-setup';
import { ensureFirewallNetwork } from './host-iptables';
import { AGENT_IP, API_PROXY_IP, NETWORK_NAME, NETWORK_SUBNET, SQUID_IP } from './host-iptables-shared';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

describe('host-iptables (network)', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  describe('ensureFirewallNetwork', () => {
    const expectFirewallNetworkConfig = (result: Awaited<ReturnType<typeof ensureFirewallNetwork>>): void => {
      expect(result).toEqual({
        subnet: NETWORK_SUBNET,
        squidIp: SQUID_IP,
        agentIp: AGENT_IP,
        proxyIp: API_PROXY_IP,
      });
    };

    const expectNetworkInspectCalled = (): void => {
      expect(mockedExeca).toHaveBeenCalledWith(
        'docker',
        ['network', 'inspect', NETWORK_NAME, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'],
        { env: expect.any(Object) },
      );
    };

    it('should return network config when network already exists', async () => {
      // Mock successful network inspect (network exists with the default subnet)
      mockedExeca
        .mockResolvedValueOnce(execaResult({ stdout: `${NETWORK_SUBNET} ` }))
        .mockResolvedValueOnce(execaResult({ stdout: '{"com.docker.network.bridge.name":"fw-bridge"}' }));

      const result = await ensureFirewallNetwork();

      expectFirewallNetworkConfig(result);

      // Should only check if network exists, not create it
      expectNetworkInspectCalled();
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

      expectFirewallNetworkConfig(result);

      expectNetworkInspectCalled();
      expect(mockedExeca).toHaveBeenCalledWith('docker', [
        'network',
        'create',
        NETWORK_NAME,
        '--subnet',
        NETWORK_SUBNET,
        '--opt',
        'com.docker.network.bridge.name=fw-bridge',
      ], { env: expect.any(Object) });
    });

    it('creates the network with an overridden subnet and derived IPs', async () => {
      mockedExeca
        .mockRejectedValueOnce(new Error('network not found'))
        .mockResolvedValueOnce(execaResult({ stdout: '', stderr: '', exitCode: 0 }));

      const result = await ensureFirewallNetwork('10.88.0.0/24');

      expect(result).toEqual({
        subnet: '10.88.0.0/24',
        squidIp: '10.88.0.10',
        agentIp: '10.88.0.20',
        proxyIp: '10.88.0.30',
      });
      expect(mockedExeca).toHaveBeenCalledWith('docker', [
        'network',
        'create',
        NETWORK_NAME,
        '--subnet',
        '10.88.0.0/24',
        '--opt',
        'com.docker.network.bridge.name=fw-bridge',
      ], { env: expect.any(Object) });
    });

    it('fails when a pre-existing network uses a different subnet', async () => {
      mockedExeca.mockResolvedValue(execaResult({
        stdout: `${NETWORK_SUBNET} `,
        stderr: '',
        exitCode: 0,
      }));

      await expect(ensureFirewallNetwork('10.88.0.0/24')).rejects.toThrow(
        /already exists with subnet 172\.30\.0\.0\/24/,
      );
    });

    it('recreates an empty network missing the bridge option', async () => {
      mockedExeca
        .mockResolvedValueOnce(execaResult({ stdout: `${NETWORK_SUBNET} ` }))
        .mockResolvedValueOnce(execaResult({ stdout: '{}' }))
        .mockResolvedValueOnce(execaResult({ stdout: '0' }))
        .mockResolvedValueOnce(execaResult({ stdout: NETWORK_NAME }))
        .mockResolvedValueOnce(execaResult({ stdout: NETWORK_NAME }));

      expectFirewallNetworkConfig(await ensureFirewallNetwork());
      expect(mockedExeca).toHaveBeenCalledWith('docker', ['network', 'rm', NETWORK_NAME], { env: expect.any(Object) });
      expect(mockedExeca).toHaveBeenCalledWith('docker', [
        'network', 'create', NETWORK_NAME, '--subnet', NETWORK_SUBNET,
        '--opt', 'com.docker.network.bridge.name=fw-bridge',
      ], { env: expect.any(Object) });
      expect(mockedExeca).toHaveBeenCalledTimes(5);
    });

    it('does not remove a network with attached containers', async () => {
      mockedExeca
        .mockResolvedValueOnce(execaResult({ stdout: `${NETWORK_SUBNET} ` }))
        .mockResolvedValueOnce(execaResult({ stdout: '{}' }))
        .mockResolvedValueOnce(execaResult({ stdout: '1' }));

      await expect(ensureFirewallNetwork()).rejects.toThrow(/awf-net.*docker network rm awf-net/);
      expect(mockedExeca).not.toHaveBeenCalledWith('docker', ['network', 'rm', NETWORK_NAME], expect.anything());
    });

    it('reports how to remove a stale network when automatic removal fails', async () => {
      mockedExeca
        .mockResolvedValueOnce(execaResult({ stdout: `${NETWORK_SUBNET} ` }))
        .mockResolvedValueOnce(execaResult({ stdout: '{}' }))
        .mockResolvedValueOnce(execaResult({ stdout: '0' }))
        .mockRejectedValueOnce(new Error('network has active endpoints'));

      await expect(ensureFirewallNetwork()).rejects.toThrow(/awf-net.*docker network rm awf-net/);
      expect(mockedExeca).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['network', 'create']), expect.anything());
    });
  });
});
