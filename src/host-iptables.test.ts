import { ensureFirewallNetwork, setupHostIptables, cleanupHostIptables, cleanupFirewallNetwork, _resetIpv6State } from './host-iptables';
import execa from 'execa';

// Mock execa
jest.mock('execa');
const mockedExeca = execa as jest.MockedFunction<typeof execa>;

// Mock logger to avoid console output during tests
jest.mock('./logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}));

describe('host-iptables', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetIpv6State();
  });

  describe('ensureFirewallNetwork', () => {
    it('should return network config when network already exists', async () => {
      // Mock successful network inspect (network exists)
      mockedExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      const result = await ensureFirewallNetwork();

      expect(result).toEqual({
        subnet: '172.30.0.0/24',
        squidIp: '172.30.0.10',
        agentIp: '172.30.0.20',
        proxyIp: '172.30.0.30',
      });

      // Should only check if network exists, not create it
      expect(mockedExeca).toHaveBeenCalledWith('docker', ['network', 'inspect', 'awf-net']);
      expect(mockedExeca).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['network', 'create']));
    });

    it('should create network when it does not exist', async () => {
      // First call (network inspect) fails - network doesn't exist
      // Second call (network create) succeeds
      mockedExeca
        .mockRejectedValueOnce(new Error('network not found'))
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
        } as any);

      const result = await ensureFirewallNetwork();

      expect(result).toEqual({
        subnet: '172.30.0.0/24',
        squidIp: '172.30.0.10',
        agentIp: '172.30.0.20',
        proxyIp: '172.30.0.30',
      });

      expect(mockedExeca).toHaveBeenCalledWith('docker', ['network', 'inspect', 'awf-net']);
      expect(mockedExeca).toHaveBeenCalledWith('docker', [
        'network',
        'create',
        'awf-net',
        '--subnet',
        '172.30.0.0/24',
        '--opt',
        'com.docker.network.bridge.name=fw-bridge',
      ]);
    });
  });

  describe('setupHostIptables', () => {
    it('should throw error if iptables permission denied', async () => {
      const permissionError: any = new Error('Permission denied');
      permissionError.stderr = 'iptables: Permission denied';

      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({
          stdout: 'fw-bridge',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockRejectedValueOnce(permissionError);

      await expect(setupHostIptables('172.30.0.10', 3128)).rejects.toThrow(
        'Permission denied: iptables commands require root privileges'
      );
    });

    it('should create FW_WRAPPER chain and add rules', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({
          stdout: 'fw-bridge',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock chain existence check (doesn't exist)
        .mockResolvedValueOnce({
          exitCode: 1,
        } as any);

      // Mock all subsequent iptables calls
      mockedExeca.mockResolvedValue({
        stdout: 'Chain DOCKER-USER\nChain FW_WRAPPER',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128);

      // Verify chain was created
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-N', 'FW_WRAPPER']);

      // Verify allow Squid proxy rule
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-s', '172.30.0.10',
        '-j', 'ACCEPT',
      ]);

      // Verify established/related rule
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED',
        '-j', 'ACCEPT',
      ]);

      // Verify no DNS-specific rules (simplified model uses Docker embedded DNS)
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining(['--dport', '53']));

      // Verify traffic to Squid rule
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.10', '--dport', '3128',
        '-j', 'ACCEPT',
      ]);

      // Verify default deny with logging
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-j', 'LOG', '--log-prefix', '[FW_BLOCKED_OTHER] ', '--log-level', '4',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
      ]);

      // Verify jump from DOCKER-USER to FW_WRAPPER
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-I', 'DOCKER-USER', '1',
        '-i', 'fw-bridge',
        '-j', 'FW_WRAPPER',
      ]);
    });

    it('should cleanup existing chain before creating new one', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({
          stdout: 'fw-bridge',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock chain existence check (exists)
        .mockResolvedValueOnce({
          exitCode: 0,
        } as any)
        // Mock DOCKER-USER list with existing references
        .mockResolvedValueOnce({
          stdout: '1    FW_WRAPPER  all  --  *      *       0.0.0.0/0            0.0.0.0/0\n',
          stderr: '',
          exitCode: 0,
        } as any);

      // Mock all subsequent calls
      mockedExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128);

      // Should delete reference from DOCKER-USER
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-D', 'DOCKER-USER', '1',
      ], { reject: false });

      // Should flush existing chain
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-F', 'FW_WRAPPER',
      ], { reject: false });

      // Should delete existing chain
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-X', 'FW_WRAPPER',
      ], { reject: false });

      // Then create new chain
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-N', 'FW_WRAPPER',
      ]);
    });

    it('should allow localhost traffic', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({
          stdout: 'fw-bridge',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock chain existence check
        .mockResolvedValueOnce({
          exitCode: 1,
        } as any);

      mockedExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128);

      // Verify localhost rules
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-o', 'lo',
        '-j', 'ACCEPT',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-d', '127.0.0.0/8',
        '-j', 'ACCEPT',
      ]);
    });

    it('should block multicast and link-local traffic', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({
          stdout: 'fw-bridge',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock chain existence check
        .mockResolvedValueOnce({
          exitCode: 1,
        } as any);

      mockedExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128);

      // Verify multicast block
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-m', 'addrtype', '--dst-type', 'MULTICAST',
        '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
      ]);

      // Verify link-local block (169.254.0.0/16)
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-d', '169.254.0.0/16',
        '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
      ]);

      // Verify multicast range block (224.0.0.0/4)
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-d', '224.0.0.0/4',
        '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
      ]);
    });

    it('should log and block all UDP traffic (DNS to non-whitelisted servers gets blocked)', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({
          stdout: 'fw-bridge',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock chain existence check
        .mockResolvedValueOnce({
          exitCode: 1,
        } as any);

      mockedExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128);

      // Verify UDP logging (all UDP, DNS to whitelisted servers is allowed earlier in chain)
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp',
        '-j', 'LOG', '--log-prefix', '[FW_BLOCKED_UDP] ', '--log-level', '4',
      ]);

      // Verify UDP rejection
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp',
        '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
      ]);
    });

    it('should not create IPv6 chain (no DNS-specific rules in simplified model)', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({
          stdout: 'fw-bridge',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
        } as any)
        // Mock chain existence check (IPv4 chain doesn't exist)
        .mockResolvedValueOnce({
          exitCode: 1,
        } as any);

      mockedExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128);

      // Verify no DNS-specific rules and no IPv6 chain
      expect(mockedExeca).not.toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining(['--dport', '53']));
    });

    it('should disable IPv6 via sysctl when ip6tables unavailable', async () => {
      // Make ip6tables unavailable
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // iptables -L DOCKER-USER permission check
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // chain existence check (doesn't exist)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      // All subsequent calls succeed (except ip6tables)
      mockedExeca.mockImplementation(((cmd: string, _args: string[]) => {
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128);

      // Verify sysctl was called to disable IPv6
      expect(mockedExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=1']);
      expect(mockedExeca).toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=1']);
    });

    it('should not disable IPv6 via sysctl when ip6tables is available', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // Mock chain existence check (doesn't exist)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

      await setupHostIptables('172.30.0.10', 3128);

      // Verify sysctl was NOT called to disable IPv6
      expect(mockedExeca).not.toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=1']);
      expect(mockedExeca).not.toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=1']);
    });

  });

  describe('cleanupHostIptables', () => {
    it('should flush and delete both FW_WRAPPER and FW_WRAPPER_V6 chains', async () => {
      mockedExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

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
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      // Make ip6tables unavailable to trigger sysctl disable
      mockedExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128);

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

    it('should not throw on errors (best-effort cleanup)', async () => {
      mockedExeca.mockRejectedValue(new Error('iptables error'));

      // Should not throw
      await expect(cleanupHostIptables()).resolves.not.toThrow();
    });
  });

  describe('setupHostIptables with DoH proxy', () => {
    it('should add HTTPS ACCEPT rule for DoH proxy when dohProxyIp is provided', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // Mock chain existence check (doesn't exist)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      // Mock all subsequent iptables calls
      mockedExeca.mockResolvedValue({
        stdout: 'Chain DOCKER-USER\nChain FW_WRAPPER',
        stderr: '',
        exitCode: 0,
      } as any);

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
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockResolvedValue({
        stdout: 'Chain DOCKER-USER\nChain FW_WRAPPER',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Verify no DoH proxy rules were added
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '-s', '172.30.0.40',
      ]));
    });
  });

  describe('cleanupFirewallNetwork', () => {
    it('should remove the firewall network', async () => {
      mockedExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      await cleanupFirewallNetwork();

      expect(mockedExeca).toHaveBeenCalledWith('docker', ['network', 'rm', 'awf-net'], { reject: false });
    });

    it('should not throw on errors (best-effort cleanup)', async () => {
      mockedExeca.mockRejectedValue(new Error('network removal error'));

      // Should not throw
      await expect(cleanupFirewallNetwork()).resolves.not.toThrow();
    });
  });
});
