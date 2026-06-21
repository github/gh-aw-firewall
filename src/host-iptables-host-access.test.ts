import { mockedExeca, setupDefaultIptablesMocks, setupDockerBridgeMock, setupHostIptablesTestSuite } from './test-helpers/host-iptables-test-setup';
import { HostAccessConfig, setupHostIptables } from './host-iptables';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';
import { expectGatewayHttpAcceptRules } from './host-iptables-test-helpers.test-utils';

describe('host-iptables (host access)', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  describe('setupHostIptables with host access', () => {
    const invalidHostServicePorts = ['abc', '99999', '-1'];

    const setupHostAccessWithServicePorts = async (allowHostServicePorts: string) => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock();

      const hostAccess: HostAccessConfig = { enabled: true, allowHostServicePorts };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);
    };

    const expectInvalidHostServicePortsSkipped = (ports: string[]) => {
      for (const port of ports) {
        expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
          '--dport', port,
        ]));
      }
    };

    it('should add gateway ACCEPT rules when hostAccess is enabled', async () => {
      setupDefaultIptablesMocks();

      // Default mock for all subsequent calls; getDockerBridgeGateway returns 172.17.0.1
      setupDockerBridgeMock();

      const hostAccess: HostAccessConfig = { enabled: true };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Verify ACCEPT rules for Docker bridge gateway on default ports
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.17.0.1', '--dport', '80',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.17.0.1', '--dport', '443',
        '-j', 'ACCEPT',
      ]);

      // Verify ACCEPT rules for AWF network gateway (172.30.0.1) on default ports
      expectGatewayHttpAcceptRules(mockedExeca, '172.30.0.1');
    });

    it('should not add gateway rules when hostAccess is undefined', async () => {
      setupDefaultIptablesMocks();

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Verify no gateway rules for 172.30.0.1 or 172.17.0.1
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '-d', '172.30.0.1', '--dport', '80',
      ]));
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '-d', '172.17.0.1',
      ]));
    });

    it('should add custom port rules when allowHostPorts is specified', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock();

      const hostAccess: HostAccessConfig = { enabled: true, allowHostPorts: '3000,8080' };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Verify custom port rules for Docker bridge gateway
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.17.0.1', '--dport', '3000',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.17.0.1', '--dport', '8080',
        '-j', 'ACCEPT',
      ]);

      // Verify custom port rules for AWF network gateway
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '3000',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '8080',
        '-j', 'ACCEPT',
      ]);
    });

    it('should only use AWF gateway when Docker bridge gateway is null', async () => {
      setupDefaultIptablesMocks();

      // Make getDockerBridgeGateway return null (docker network inspect bridge fails)
      setupDockerBridgeMock({ error: new Error('network bridge not found') });

      const hostAccess: HostAccessConfig = { enabled: true };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Verify rules for AWF network gateway (172.30.0.1)
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '80',
        '-j', 'ACCEPT',
      ]);

      // Verify NO rules for Docker bridge gateway (172.17.0.1)
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.17.0.1', '--dport', '80',
        '-j', 'ACCEPT',
      ]);
    });

    it('should only add default ports when allowHostPorts is empty', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock();

      const hostAccess: HostAccessConfig = { enabled: true, allowHostPorts: '' };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Verify default port 80 rules exist
      expectGatewayHttpAcceptRules(mockedExeca, '172.30.0.1');
    });

    it('should support port ranges in allowHostPorts', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock();

      const hostAccess: HostAccessConfig = { enabled: true, allowHostPorts: '3000-3010' };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Verify port range rule
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '3000-3010',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.17.0.1', '--dport', '3000-3010',
        '-j', 'ACCEPT',
      ]);
    });

    it('should skip invalid ports in allowHostServicePorts', async () => {
      await setupHostAccessWithServicePorts(invalidHostServicePorts.join(','));

      expectInvalidHostServicePortsSkipped(invalidHostServicePorts);

      // Default ports should still be present
      expectGatewayHttpAcceptRules(mockedExeca, '172.30.0.1');
    });

    it('should skip invalid ports in allowHostPorts', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock();

      const hostAccess: HostAccessConfig = { enabled: true, allowHostPorts: 'abc,99999,-1' };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Verify invalid ports are NOT added - only default ports (80, 443) should exist
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '--dport', 'abc',
      ]));
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '--dport', '99999',
      ]));
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '--dport', '-1',
      ]));

      // Default ports should still be present
      expectGatewayHttpAcceptRules(mockedExeca, '172.30.0.1');
    });

    it('should deduplicate ports when custom ports overlap with defaults', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock();

      // Pass 80 and 443 as custom ports (duplicates of defaults) plus 3000
      const hostAccess: HostAccessConfig = { enabled: true, allowHostPorts: '80,443,3000' };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Count how many times port 80 rule was called for 172.30.0.1
      const port80Calls = mockedExeca.mock.calls.filter(
        (call) => call[0] === 'iptables' &&
          Array.isArray(call[1]) &&
          call[1].includes('--dport') &&
          call[1][call[1].indexOf('--dport') + 1] === '80' &&
          call[1].includes('-d') &&
          call[1][call[1].indexOf('-d') + 1] === '172.30.0.1'
      );
      // Should only be called once (deduplicated)
      expect(port80Calls).toHaveLength(1);

      // Verify port 3000 also got a rule
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '3000',
        '-j', 'ACCEPT',
      ]);
    });

    it('should add service port rules when allowHostServicePorts is specified', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock();

      const hostAccess: HostAccessConfig = { enabled: true, allowHostServicePorts: '5432,6379' };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Verify service ports get ACCEPT rules on both gateway IPs
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '5432',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '6379',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.17.0.1', '--dport', '5432',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.17.0.1', '--dport', '6379',
        '-j', 'ACCEPT',
      ]);
    });

    it('should skip invalid service ports in allowHostServicePorts', async () => {
      await setupHostAccessWithServicePorts(`${invalidHostServicePorts.join(',')},5432`);

      expectInvalidHostServicePortsSkipped(invalidHostServicePorts);

      // Valid service port should be present
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '5432',
        '-j', 'ACCEPT',
      ]);
    });

    it('should deduplicate service ports with regular host ports', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock();

      // Both allowHostPorts and allowHostServicePorts include 5432
      const hostAccess: HostAccessConfig = {
        enabled: true,
        allowHostPorts: '5432,3000',
        allowHostServicePorts: '5432,6379',
      };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Count how many times port 5432 rule was called for 172.30.0.1
      const port5432Calls = mockedExeca.mock.calls.filter(
        (call) => call[0] === 'iptables' &&
          Array.isArray(call[1]) &&
          call[1].includes('--dport') &&
          call[1][call[1].indexOf('--dport') + 1] === '5432' &&
          call[1].includes('-d') &&
          call[1][call[1].indexOf('-d') + 1] === '172.30.0.1'
      );
      // Should only be called once (deduplicated)
      expect(port5432Calls).toHaveLength(1);

      // Verify 6379 also got a rule
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '6379',
        '-j', 'ACCEPT',
      ]);
    });
  });

  describe('getDockerBridgeGateway invalid IPv4', () => {
    it('should skip gateway rule when Docker bridge returns non-IPv4 gateway', async () => {
      setupDefaultIptablesMocks();

      // Return non-IPv4 (e.g. IPv6 address) from Docker bridge gateway
      setupDockerBridgeMock({ gateway: 'not-an-ip-address' });

      const hostAccess = { enabled: true };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Should NOT create rules for invalid gateway IP, only for AWF network gateway (172.30.0.1)
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '80',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', 'not-an-ip-address', '--dport', '80',
        '-j', 'ACCEPT',
      ]);
    });
  });
});
