import { execaResult, mockedExeca, setupHostIptablesTestSuite } from './test-helpers/host-iptables-test-setup';
import {
  AGENT_IP,
  API_PROXY_IP,
  CLI_PROXY_IP,
  DOH_PROXY_IP,
  NETWORK_SUBNET,
  SQUID_IP,
  addDnsRules,
  cleanupChain,
  disableIpv6ViaSysctl,
  enableIpv6ViaSysctl,
  getDockerBridgeGateway,
  getNetworkBridgeName,
  isIp6tablesAvailable,
} from './host-iptables-shared';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';
import { logger } from './logger';

describe('host-iptables-shared', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  describe('network constants', () => {
    it('exports fixed container network addresses', () => {
      expect(NETWORK_SUBNET).toBe('172.30.0.0/24');
      expect(SQUID_IP).toBe('172.30.0.10');
      expect(AGENT_IP).toBe('172.30.0.20');
      expect(API_PROXY_IP).toBe('172.30.0.30');
      expect(DOH_PROXY_IP).toBe('172.30.0.40');
      expect(CLI_PROXY_IP).toBe('172.30.0.50');
    });
  });

  describe('cleanupChain', () => {
    it('removes matching DOCKER-USER references in reverse order before deleting the chain', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'iptables' && args.includes('DOCKER-USER') && args.includes('--line-numbers')) {
          return Promise.resolve(execaResult({
            stdout: '1 FW_WRAPPER all -- 0.0.0.0/0 0.0.0.0/0\n3 FW_WRAPPER all -- 0.0.0.0/0 0.0.0.0/0\n',
          }));
        }
        return Promise.resolve(execaResult());
      }) as any);

      await cleanupChain('iptables', 'FW_WRAPPER');

      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '3'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '1'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-F', 'FW_WRAPPER'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-X', 'FW_WRAPPER'], { reject: false });
    });

    it('skips DOCKER-USER reference removal when configured', async () => {
      mockedExeca.mockResolvedValue(execaResult());

      await cleanupChain('ip6tables', 'FW_WRAPPER_V6', { removeDockerUserReferences: false });

      expect(mockedExeca).not.toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
      ], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-F', 'FW_WRAPPER_V6'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-X', 'FW_WRAPPER_V6'], { reject: false });
    });

    it('uses matchPredicate to select lines for deletion', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'iptables' && args.includes('DOCKER-USER') && args.includes('--line-numbers')) {
          return Promise.resolve(execaResult({
            stdout: '1 FW_WRAPPER all -- 0.0.0.0/0 0.0.0.0/0\n2 OTHER_CHAIN all -- 0.0.0.0/0 0.0.0.0/0\n',
          }));
        }
        return Promise.resolve(execaResult());
      }) as any);

      await cleanupChain('iptables', 'FW_WRAPPER', {
        matchPredicate: (line) => line.includes('OTHER_CHAIN'),
      });

      // Should delete line 2 (OTHER_CHAIN match) but not line 1 (FW_WRAPPER)
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '2'], { reject: false });
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '1'], { reject: false });
    });
  });

  describe('getNetworkBridgeName', () => {
    it('returns bridge name on success', async () => {
      mockedExeca.mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge\n' }));

      const result = await getNetworkBridgeName();

      expect(result).toBe('fw-bridge');
    });

    it('returns null when output is empty', async () => {
      mockedExeca.mockResolvedValueOnce(execaResult({ stdout: '' }));

      const result = await getNetworkBridgeName();

      expect(result).toBeNull();
    });

    it('returns null when docker command fails', async () => {
      mockedExeca.mockRejectedValueOnce(new Error('docker: command not found'));

      const result = await getNetworkBridgeName();

      expect(result).toBeNull();
    });
  });

  describe('getDockerBridgeGateway', () => {
    it('returns the gateway IP on success', async () => {
      mockedExeca.mockResolvedValueOnce(execaResult({ stdout: '172.17.0.1' }));

      const result = await getDockerBridgeGateway();

      expect(result).toBe('172.17.0.1');
    });

    it('returns null when output is empty', async () => {
      mockedExeca.mockResolvedValueOnce(execaResult({ stdout: '' }));

      const result = await getDockerBridgeGateway();

      expect(result).toBeNull();
    });

    it('returns null and warns when gateway is not a valid IPv4 address', async () => {
      mockedExeca.mockResolvedValueOnce(execaResult({ stdout: 'not-an-ip' }));

      const result = await getDockerBridgeGateway();

      expect(result).toBeNull();
      expect(jest.mocked(logger).warn).toHaveBeenCalledWith(
        'Docker bridge gateway returned invalid IPv4: not-an-ip, skipping'
      );
    });

    it('returns null when docker command fails', async () => {
      mockedExeca.mockRejectedValueOnce(new Error('network not found'));

      const result = await getDockerBridgeGateway();

      expect(result).toBeNull();
    });
  });

  describe('isIp6tablesAvailable', () => {
    it('returns true when ip6tables succeeds', async () => {
      mockedExeca.mockResolvedValueOnce(execaResult({ stdout: '' }));

      const result = await isIp6tablesAvailable();

      expect(result).toBe(true);
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-L', '-n'], { timeout: 5000 });
    });

    it('returns false when ip6tables fails', async () => {
      mockedExeca.mockRejectedValueOnce(new Error('ip6tables not found'));

      const result = await isIp6tablesAvailable();

      expect(result).toBe(false);
    });

    it('returns cached result on second call without invoking ip6tables again', async () => {
      mockedExeca.mockResolvedValueOnce(execaResult({ stdout: '' }));

      const first = await isIp6tablesAvailable();
      const second = await isIp6tablesAvailable();

      expect(first).toBe(true);
      expect(second).toBe(true);
      // ip6tables should only be called once due to caching
      expect(mockedExeca).toHaveBeenCalledTimes(1);
    });
  });

  describe('disableIpv6ViaSysctl', () => {
    it('calls sysctl to disable IPv6 on both all and default interfaces', async () => {
      mockedExeca.mockResolvedValue(execaResult());

      await disableIpv6ViaSysctl();

      expect(mockedExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=1']);
      expect(mockedExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=1']);
    });

    it('does not throw when sysctl command fails', async () => {
      mockedExeca.mockRejectedValueOnce(new Error('sysctl: permission denied'));

      await expect(disableIpv6ViaSysctl()).resolves.not.toThrow();
    });
  });

  describe('enableIpv6ViaSysctl', () => {
    it('does nothing when IPv6 was not disabled via sysctl', async () => {
      // ipv6DisabledViaSysctl is false by default (reset in beforeEach)
      await enableIpv6ViaSysctl();

      expect(mockedExeca).not.toHaveBeenCalled();
    });

    it('re-enables IPv6 after disableIpv6ViaSysctl was called', async () => {
      mockedExeca.mockResolvedValue(execaResult());

      await disableIpv6ViaSysctl();
      await enableIpv6ViaSysctl();

      expect(mockedExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=0']);
      expect(mockedExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=0']);
    });

    it('does not throw when re-enable sysctl command fails', async () => {
      mockedExeca.mockResolvedValueOnce(execaResult()); // disable all
      mockedExeca.mockResolvedValueOnce(execaResult()); // disable default
      mockedExeca.mockRejectedValueOnce(new Error('sysctl: permission denied')); // re-enable all fails

      await disableIpv6ViaSysctl();
      await expect(enableIpv6ViaSysctl()).resolves.not.toThrow();
    });
  });

  describe('addDnsRules', () => {
    it('adds both UDP and TCP accept rules for the given destination', async () => {
      mockedExeca.mockResolvedValue(execaResult());

      await addDnsRules('iptables', 'FW_WRAPPER', '8.8.8.8');

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
    });

    it('rolls back successfully added UDP rule when TCP rule fails', async () => {
      mockedExeca
        .mockResolvedValueOnce(execaResult()) // UDP add succeeds
        .mockRejectedValueOnce(new Error('iptables: table locked')); // TCP add fails

      await expect(addDnsRules('iptables', 'FW_WRAPPER', '8.8.8.8')).rejects.toThrow('iptables: table locked');

      // Should roll back the UDP rule that was successfully added
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-D', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
    });

    it('re-throws original error even if rollback also fails', async () => {
      mockedExeca
        .mockResolvedValueOnce(execaResult()) // UDP add succeeds
        .mockRejectedValueOnce(new Error('iptables: table locked')) // TCP add fails
        .mockRejectedValueOnce(new Error('rollback failed')); // UDP delete fails

      await expect(addDnsRules('iptables', 'FW_WRAPPER', '8.8.8.8')).rejects.toThrow('iptables: table locked');
    });
  });
});
