import {
  mockedExeca,
  setupDefaultIptablesMocks,
  setupDockerBridgeMock,
  setupHostIptablesTestSuite,
} from './test-helpers/host-iptables-test-setup';
import { setupHostIptables } from './host-iptables';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

describe('host-iptables (setup) — cliProxyConfig integration', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  describe('setupHostIptables with cliProxyConfig', () => {
    it('should add iptables rules allowing cli-proxy to reach host gateway when cliProxyConfig is provided', async () => {
      setupDefaultIptablesMocks();

      // getDockerBridgeGateway
      setupDockerBridgeMock();

      const cliProxyConfig = { ip: '172.30.0.50', difcProxyPort: 18443 };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, undefined, cliProxyConfig);

      // Verify rule for AWF network gateway
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-s', '172.30.0.50', '-d', '172.30.0.1', '--dport', '18443',
        '-j', 'ACCEPT',
      ]);

      // Verify rule for Docker bridge gateway
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-s', '172.30.0.50', '-d', '172.17.0.1', '--dport', '18443',
        '-j', 'ACCEPT',
      ]);
    });

    it('should only add AWF gateway rule when Docker bridge gateway is unavailable', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock({ error: new Error('bridge network not found') });

      const cliProxyConfig = { ip: '172.30.0.50', difcProxyPort: 18443 };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, undefined, cliProxyConfig);

      // Should have rule for AWF network gateway only
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-s', '172.30.0.50', '-d', '172.30.0.1', '--dport', '18443',
        '-j', 'ACCEPT',
      ]);
      // Should NOT have a rule for 172.17.0.1
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-s', '172.30.0.50', '-d', '172.17.0.1', '--dport', '18443',
        '-j', 'ACCEPT',
      ]);
    });

    it('should resolve Docker bridge gateway once when cliProxyConfig and hostAccess are both enabled', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock();

      const cliProxyConfig = { ip: '172.30.0.50', difcProxyPort: 18443 };
      const hostAccess = { enabled: true };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess, cliProxyConfig);

      const bridgeGatewayCalls = mockedExeca.mock.calls.filter(([cmd, args]) =>
        cmd === 'docker' && Array.isArray(args) && args.includes('bridge')
      );
      expect(bridgeGatewayCalls).toHaveLength(1);
    });
  });
});
