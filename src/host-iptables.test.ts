import { ensureFirewallNetwork, setupHostIptables, cleanupHostIptables, cleanupFirewallNetwork, _resetIpv6State, HostAccessConfig, isValidPortSpec } from './host-iptables';
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

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'])).rejects.toThrow(
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

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

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

      // Verify DNS forwarding rules for default upstream servers
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

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
        // Mock DOCKER-USER list with existing references - include a header line
        // that contains 'FW_WRAPPER' but doesn't start with a digit (tests the
        // else path of `if (match)` at line 265)
        .mockResolvedValueOnce({
          stdout: 'Chain FORWARD (policy ACCEPT)\nnum  target     prot opt source               destination\nChain FW_WRAPPER (1 references)\n1    FW_WRAPPER  all  --  *      *       0.0.0.0/0            0.0.0.0/0\n',
          stderr: '',
          exitCode: 0,
        } as any);

      // Mock all subsequent calls
      mockedExeca.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

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

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

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

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

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

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

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

    it('should add API proxy sidecar rules when apiProxyIp is provided', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // Mock chain existence check (doesn't exist)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], '172.30.0.30');

      // Verify API proxy sidecar rule was added with port range
      expect(mockedExeca).toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.30',
      ]));
    });

    it('should throw error when bridge name is not found', async () => {
      // Mock getNetworkBridgeName returning empty/null
      mockedExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'])).rejects.toThrow(
        "Failed to get bridge name for network 'awf-net'"
      );
    });

    it('should create DOCKER-USER chain when it does not exist', async () => {
      const noChainError: any = new Error('No chain/target/match by that name');
      noChainError.stderr = 'No chain/target/match by that name';

      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // Mock iptables -L DOCKER-USER (chain doesn't exist)
        .mockRejectedValueOnce(noChainError)
        // Mock iptables -N DOCKER-USER (create chain)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // Mock chain existence check (FW_WRAPPER doesn't exist)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      // Mock all subsequent calls
      mockedExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Verify DOCKER-USER chain was created
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-N', 'DOCKER-USER']);
    });

    it('should skip inserting DOCKER-USER jump rule if it already exists', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // Mock chain existence check (doesn't exist)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      // Default mock: all calls succeed, and DOCKER-USER listing includes bridge rule
      mockedExeca.mockResolvedValue({
        stdout: '1    FW_WRAPPER  all  --  -i fw-bridge  0.0.0.0/0            0.0.0.0/0',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Should NOT insert a new rule since it already exists
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-I', 'DOCKER-USER', '1',
        '-i', 'fw-bridge',
        '-j', 'FW_WRAPPER',
      ]);
    });

    it('should not create IPv6 chain but should add DNS forwarding rules', async () => {
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

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Verify no IPv6 chain
      expect(mockedExeca).not.toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);
      // DNS forwarding rules should exist for default upstream servers (8.8.8.8, 8.8.4.4)
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.4.4', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
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

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

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

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Verify sysctl was NOT called to disable IPv6
      expect(mockedExeca).not.toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=1']);
      expect(mockedExeca).not.toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=1']);
    });

    it('should not throw when sysctl fails while disabling IPv6', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        if (cmd === 'sysctl') {
          return Promise.reject(new Error('sysctl: Operation not permitted'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      // Should not throw - disableIpv6ViaSysctl catches sysctl errors
      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'])).resolves.not.toThrow();
    });

    it('should throw when DOCKER-USER chain creation fails after chain not found', async () => {
      const noChainError: any = new Error('No chain/target/match by that name');
      noChainError.stderr = 'No chain/target/match by that name';
      const createChainError: any = new Error('Operation not permitted');

      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockRejectedValueOnce(noChainError)
        .mockRejectedValueOnce(createChainError);

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'])).rejects.toThrow(
        'Failed to create DOCKER-USER chain'
      );
    });

    it('should silently recover when FW_WRAPPER chain cleanup throws an error', async () => {
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // FW_WRAPPER chain exists
        .mockResolvedValueOnce({ exitCode: 0 } as any)
        // DOCKER-USER listing for existing references
        .mockResolvedValueOnce({
          stdout: '1    FW_WRAPPER  all  --  *      *       0.0.0.0/0            0.0.0.0/0\n',
          stderr: '',
          exitCode: 0,
        } as any)
        // Delete rule from DOCKER-USER
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // Flush FW_WRAPPER - throws!
        .mockRejectedValueOnce(new Error('iptables: Chain flush failed'));

      // After the error in chain cleanup, the outer try-catch should handle it;
      // but then creating FW_WRAPPER chain will be attempted and also succeed
      mockedExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

      // Should not throw - error during cleanup is caught and logged
      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'])).resolves.not.toThrow();
    });

  });

  describe('setupHostIptables with host access', () => {
    it('should add gateway ACCEPT rules when hostAccess is enabled', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // Mock chain existence check (doesn't exist)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      // Default mock for all subsequent calls; getDockerBridgeGateway returns 172.17.0.1
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args.includes('bridge')) {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        if (cmd === 'ip6tables') {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

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
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '80',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '443',
        '-j', 'ACCEPT',
      ]);
    });

    it('should not add gateway rules when hostAccess is undefined', async () => {
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

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
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args.includes('bridge')) {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

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
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        // Make getDockerBridgeGateway return null (docker network inspect bridge fails)
        if (cmd === 'docker' && args.includes('bridge')) {
          return Promise.reject(new Error('network bridge not found'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

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
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args.includes('bridge')) {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      const hostAccess: HostAccessConfig = { enabled: true, allowHostPorts: '' };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, undefined, hostAccess);

      // Verify default port 80 rules exist
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '80',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '443',
        '-j', 'ACCEPT',
      ]);
    });

    it('should support port ranges in allowHostPorts', async () => {
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args.includes('bridge')) {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

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

    it('should skip invalid ports in allowHostPorts', async () => {
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args.includes('bridge')) {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

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
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '80',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '443',
        '-j', 'ACCEPT',
      ]);
    });

    it('should deduplicate ports when custom ports overlap with defaults', async () => {
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args.includes('bridge')) {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

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
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args.includes('bridge')) {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

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

    it('should deduplicate service ports with regular host ports', async () => {
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args.includes('bridge')) {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

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

  describe('isValidPortSpec', () => {
    it('should accept valid single ports', () => {
      expect(isValidPortSpec('1')).toBe(true);
      expect(isValidPortSpec('80')).toBe(true);
      expect(isValidPortSpec('443')).toBe(true);
      expect(isValidPortSpec('65535')).toBe(true);
    });

    it('should accept valid port ranges', () => {
      expect(isValidPortSpec('3000-3010')).toBe(true);
      expect(isValidPortSpec('1-65535')).toBe(true);
      expect(isValidPortSpec('80-80')).toBe(true);
    });

    it('should reject invalid port specs', () => {
      expect(isValidPortSpec('abc')).toBe(false);
      expect(isValidPortSpec('0')).toBe(false);
      expect(isValidPortSpec('65536')).toBe(false);
      expect(isValidPortSpec('-1')).toBe(false);
      expect(isValidPortSpec('99999')).toBe(false);
      expect(isValidPortSpec('3010-3000')).toBe(false); // reversed range
      expect(isValidPortSpec('')).toBe(false);
      expect(isValidPortSpec('080-090')).toBe(false); // leading zeros in range
      expect(isValidPortSpec('01-100')).toBe(false); // leading zero in start
      expect(isValidPortSpec('1-0100')).toBe(false); // leading zero in end
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

    it('should skip DOCKER-USER lines that contain chain name but have no leading line number', async () => {
      // ip6tables available
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[0] === 'network') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'ip6tables' && args[0] === '-L' && !args.includes('DOCKER-USER')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        // IPv4 DOCKER-USER listing: contains FW_WRAPPER header line (no leading number)
        if (cmd === 'iptables' && args.includes('DOCKER-USER') && args.includes('--line-numbers')) {
          return Promise.resolve({
            stdout: 'Chain DOCKER-USER (2 references)\nnum  target     prot opt in     out     source               destination\nChain FW_WRAPPER (1 references)\n',
            stderr: '',
            exitCode: 0,
          } as any);
        }
        // IPv6 DOCKER-USER listing: contains FW_WRAPPER_V6 header line (no leading number)
        if (cmd === 'ip6tables' && args.includes('DOCKER-USER') && args.includes('--line-numbers')) {
          return Promise.resolve({
            stdout: 'Chain DOCKER-USER (2 references)\nnum  target     prot opt in     out     source               destination\nChain FW_WRAPPER_V6 (1 references)\n',
            stderr: '',
            exitCode: 0,
          } as any);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      // Should not throw - header lines with no numbers are silently skipped
      await expect(cleanupHostIptables()).resolves.not.toThrow();

      // No delete rules should have been attempted (no valid line numbers found)
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-D', 'DOCKER-USER', expect.any(String),
      ], { reject: false });
    });

    it('should not throw when sysctl fails while re-enabling IPv6 on cleanup', async () => {
      // First: setup with ip6tables unavailable and sysctl succeeds → ipv6DisabledViaSysctl = true
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        // sysctl succeeds during setup → ipv6DisabledViaSysctl = true
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8']);

      // Now cleanup where sysctl fails when re-enabling IPv6
      jest.clearAllMocks();
      mockedExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        if (cmd === 'sysctl') {
          return Promise.reject(new Error('sysctl: Operation not permitted'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      // Should not throw - enableIpv6ViaSysctl catches sysctl errors
      await expect(cleanupHostIptables()).resolves.not.toThrow();
    });

    it('should not throw when IPv6 chain cleanup throws an error', async () => {
      // ip6tables available but chain flush throws
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[0] === 'network') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'ip6tables' && args[0] === '-L') {
          // ip6tables availability check passes
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'ip6tables' && args[2] === '-L' && args[3] === 'FW_WRAPPER_V6') {
          // Chain exists
          return Promise.resolve({ exitCode: 0 } as any);
        }
        if (cmd === 'ip6tables' && args[2] === '-F') {
          // Flush fails
          return Promise.reject(new Error('ip6tables: Flush failed'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      // Should not throw - error during IPv6 chain cleanup is caught and logged
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

  describe('setupHostIptables with empty or default DNS servers', () => {
    it('should use DEFAULT_DNS_SERVERS when dnsServers array is empty', async () => {
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

      await setupHostIptables('172.30.0.10', 3128, []);

      // Should have added DNS rules for Google DNS (default) instead of nothing
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.4.4', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
    });
  });

  describe('setupHostIptables with IPv6 DNS servers', () => {
    it('should create FW_WRAPPER_V6 chain and add IPv6 DNS rules when ip6tables is available', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        if (cmd === 'ip6tables' && args[0] === '-L' && !args.includes('FW_WRAPPER_V6')) {
          // ip6tables availability check
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'ip6tables' && args[2] === '-L' && args[3] === 'FW_WRAPPER_V6') {
          // IPv6 chain does not exist
          return Promise.resolve({ exitCode: 1 } as any);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // FW_WRAPPER_V6 chain should be created
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);

      // IPv6 DNS UDP rule
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'udp', '-d', '2001:4860:4860::8888', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      // IPv6 DNS TCP rule
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'tcp', '-d', '2001:4860:4860::8888', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      // IPv4 DNS rules should still be added for the IPv4 server
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
    });

    it('should flush and delete existing FW_WRAPPER_V6 chain before recreating it', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        if (cmd === 'ip6tables' && args[0] === '-L' && !args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'ip6tables' && args[2] === '-L' && args[3] === 'FW_WRAPPER_V6') {
          // IPv6 chain already exists
          return Promise.resolve({ exitCode: 0 } as any);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // Existing chain should be flushed and deleted before recreating
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-F', 'FW_WRAPPER_V6'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-X', 'FW_WRAPPER_V6'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);
    });

    it('should not create FW_WRAPPER_V6 chain when ip6tables is unavailable even with IPv6 DNS servers', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // IPv6 chain should NOT be created when ip6tables is unavailable
      expect(mockedExeca).not.toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);
    });

    it('should silently recover when IPv6 chain cleanup throws during setup', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        if (cmd === 'ip6tables' && args[0] === '-L' && !args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'ip6tables' && args[2] === '-L' && args[3] === 'FW_WRAPPER_V6') {
          // Chain exists
          return Promise.resolve({ exitCode: 0 } as any);
        }
        if (cmd === 'ip6tables' && args[2] === '-F') {
          // Flush throws an actual error (not just non-zero exit)
          return Promise.reject(new Error('ip6tables: internal error during flush'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      // Should not throw - the error during IPv6 chain cleanup is caught and logged
      await expect(
        setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888'])
      ).resolves.not.toThrow();
    });
  });

  describe('setupHostIptables with host access - gateway edge cases', () => {
    it('should use only AWF gateway when Docker bridge returns empty stdout', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'docker' && args[2] === 'bridge') {
          // Empty stdout → getDockerBridgeGateway returns null
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      const hostAccess: HostAccessConfig = { enabled: true };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'], undefined, undefined, hostAccess);

      // AWF gateway rules should still be added
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '80',
        '-j', 'ACCEPT',
      ]);

      // Only the AWF gateway (172.30.0.1) should get port 80/443 rules - not any Docker bridge IP
      // When Docker bridge returns empty stdout, getDockerBridgeGateway returns null,
      // so the gateway rules should only be for the AWF network gateway (172.30.0.1).
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '-d', '172.17.0.1', '--dport', '80',
      ]));
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '-d', '172.17.0.1', '--dport', '443',
      ]));
    });

    it('should use only AWF gateway when Docker bridge returns non-IPv4 gateway', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'docker' && args[2] === 'bridge') {
          // Returns a non-IPv4 value → getDockerBridgeGateway should warn and return null
          return Promise.resolve({ stdout: 'invalid-gateway-hostname', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      const hostAccess: HostAccessConfig = { enabled: true };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'], undefined, undefined, hostAccess);

      // AWF gateway rules should be present
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '80',
        '-j', 'ACCEPT',
      ]);

      // The invalid gateway hostname should NOT appear in any iptables rule
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '-d', 'invalid-gateway-hostname',
      ]));
    });

    it('should skip empty entries in allowHostPorts', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'docker' && args[2] === 'bridge') {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      // Ports with empty entries from splitting (e.g. "3000,,8080")
      const hostAccess: HostAccessConfig = { enabled: true, allowHostPorts: '3000,,8080' };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'], undefined, undefined, hostAccess);

      // Valid ports should be added
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

    it('should skip invalid ports in allowHostServicePorts', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'docker' && args[2] === 'bridge') {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      const hostAccess: HostAccessConfig = {
        enabled: true,
        allowHostServicePorts: 'bad-port,5432,99999',
      };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'], undefined, undefined, hostAccess);

      // Valid service port should be added
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.1', '--dport', '5432',
        '-j', 'ACCEPT',
      ]);

      // Invalid ports should NOT be added
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '--dport', 'bad-port',
      ]));
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '--dport', '99999',
      ]));
    });

    it('should skip empty entries in allowHostServicePorts', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'docker' && args[1] === 'inspect' && args[2] === 'awf-net') {
          return Promise.resolve({ stdout: 'fw-bridge', stderr: '', exitCode: 0 });
        }
        if (cmd === 'docker' && args[2] === 'bridge') {
          return Promise.resolve({ stdout: '172.17.0.1', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'DOCKER-USER' && !args.includes('--line-numbers')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        }
        if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
          return Promise.resolve({ exitCode: 1 } as any);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      // Empty entries from splitting (e.g. "5432,,6379")
      const hostAccess: HostAccessConfig = {
        enabled: true,
        allowHostServicePorts: '5432,,6379',
      };
      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'], undefined, undefined, hostAccess);

      // Valid ports should be added
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
    });
  });
});
