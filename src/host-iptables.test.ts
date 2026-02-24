import { ensureFirewallNetwork, setupHostIptables, cleanupHostIptables, cleanupFirewallNetwork } from './host-iptables';
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

      // Verify DNS query logging rules (LOG before ACCEPT for audit trail)
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'LOG', '--log-prefix', '[FW_DNS_QUERY] ', '--log-level', '4',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'LOG', '--log-prefix', '[FW_DNS_QUERY] ', '--log-level', '4',
      ]);

      // Verify DNS rules for trusted servers only
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

      // Verify DNS query logging rules for second DNS server
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.4.4', '--dport', '53',
        '-j', 'LOG', '--log-prefix', '[FW_DNS_QUERY] ', '--log-level', '4',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '8.8.4.4', '--dport', '53',
        '-j', 'LOG', '--log-prefix', '[FW_DNS_QUERY] ', '--log-level', '4',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.4.4', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '8.8.4.4', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      // Verify Docker embedded DNS is allowed
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '127.0.0.11', '--dport', '53',
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

    it('should use ip6tables for IPv6 DNS servers', async () => {
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

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // Verify IPv4 DNS rule uses iptables
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      // Verify IPv6 DNS query logging rules (LOG before ACCEPT)
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'udp', '-d', '2001:4860:4860::8888', '--dport', '53',
        '-j', 'LOG', '--log-prefix', '[FW_DNS_QUERY] ', '--log-level', '4',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'tcp', '-d', '2001:4860:4860::8888', '--dport', '53',
        '-j', 'LOG', '--log-prefix', '[FW_DNS_QUERY] ', '--log-level', '4',
      ]);

      // Verify IPv6 DNS rule uses ip6tables
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'udp', '-d', '2001:4860:4860::8888', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'tcp', '-d', '2001:4860:4860::8888', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      // Verify IPv6 chain was created
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);

      // Verify IPv6 UDP block rules
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'udp',
        '-j', 'LOG', '--log-prefix', '[FW_BLOCKED_UDP6] ', '--log-level', '4',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-A', 'FW_WRAPPER_V6',
        '-p', 'udp',
        '-j', 'REJECT', '--reject-with', 'icmp6-port-unreachable',
      ]);
    });

    it('should not create IPv6 chain when no IPv6 DNS servers', async () => {
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

      // Verify IPv6 chain was NOT created
      expect(mockedExeca).not.toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);
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

    it('should not throw on errors (best-effort cleanup)', async () => {
      mockedExeca.mockRejectedValue(new Error('iptables error'));

      // Should not throw
      await expect(cleanupHostIptables()).resolves.not.toThrow();
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

  describe('setupHostIptables - uncovered branches', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should throw error when bridge name cannot be determined', async () => {
      // getNetworkBridgeName returns empty string → null bridge
      mockedExeca.mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        exitCode: 0,
      } as any);

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'])).rejects.toThrow(
        "Failed to get bridge name for network 'awf-net'"
      );
    });

    it('should allow traffic to API proxy sidecar when apiProxyIp is configured', async () => {
      mockedExeca
        // getNetworkBridgeName
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // FW_WRAPPER chain check → doesn't exist
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'], '172.30.0.30');

      // Ports: OPENAI=10000, ANTHROPIC=10001, COPILOT=10002 → range 10000:10002
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.30', '--dport', '10000:10002',
        '-j', 'ACCEPT',
      ]);
    });

    it('should not insert duplicate DOCKER-USER rule when bridge rule already exists', async () => {
      mockedExeca.mockImplementation(async (cmd: string, args: string[]) => {
        // getNetworkBridgeName
        if (cmd === 'docker' && args[3] === '-f') {
          return { stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any;
        }
        // DOCKER-USER listing with line-numbers → return rules that already contain bridge jump
        if (cmd === 'iptables' && args.includes('DOCKER-USER') && args.includes('--line-numbers')) {
          return {
            stdout: '1  FW_WRAPPER all -- fw-bridge * 0.0.0.0/0 0.0.0.0/0 -i fw-bridge -j FW_WRAPPER',
            stderr: '',
            exitCode: 0,
          } as any;
        }
        // FW_WRAPPER existence check → doesn't exist
        if (cmd === 'iptables' && args[3] === 'FW_WRAPPER' && args[2] === '-L') {
          return { exitCode: 1 } as any;
        }
        return { stdout: '', stderr: '', exitCode: 0 } as any;
      });

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8']);

      // Should NOT insert the jump rule since '-i fw-bridge' is already present
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-I', 'DOCKER-USER', '1',
        '-i', 'fw-bridge',
        '-j', 'FW_WRAPPER',
      ]);
    });

    it('should attempt to create DOCKER-USER chain when it does not exist (non-permission error)', async () => {
      const nonPermissionError: any = new Error('No chain');
      nonPermissionError.stderr = 'iptables: No chain/target/match by that name.';

      let callNum = 0;
      mockedExeca.mockImplementation(async (cmd: string, args: string[]) => {
        callNum++;
        // Call 1: getNetworkBridgeName
        if (callNum === 1) {
          return { stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any;
        }
        // Call 2: iptables -L DOCKER-USER permission check → fail (non-permission)
        if (callNum === 2) {
          throw nonPermissionError;
        }
        // FW_WRAPPER existence check → doesn't exist (so cleanup is skipped)
        if (cmd === 'iptables' && args[3] === 'FW_WRAPPER' && args[2] === '-L') {
          return { exitCode: 1 } as any;
        }
        return { stdout: '', stderr: '', exitCode: 0 } as any;
      });

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8']);

      // Should have tried to create DOCKER-USER chain
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-N', 'DOCKER-USER']);
    });

    it('should throw when DOCKER-USER chain cannot be created', async () => {
      const nonPermissionError: any = new Error('No chain');
      nonPermissionError.stderr = 'iptables: No chain/target/match by that name.';

      mockedExeca
        // getNetworkBridgeName
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // iptables -L DOCKER-USER permission check → fail (non-permission)
        .mockRejectedValueOnce(nonPermissionError)
        // iptables -N DOCKER-USER → also fail
        .mockRejectedValueOnce(new Error('Cannot create chain'));

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'])).rejects.toThrow(
        'Failed to create DOCKER-USER chain'
      );
    });
  });

  describe('cleanupHostIptables - bridge name null', () => {
    it('should still flush IPv4 chain when bridge name is null', async () => {
      mockedExeca.mockImplementation(async (cmd: string, args: string[]) => {
        // getNetworkBridgeName returns empty string → null bridge
        if (cmd === 'docker' && args[1] === 'inspect') {
          return { stdout: '', stderr: '', exitCode: 0 } as any;
        }
        return { stdout: '', stderr: '', exitCode: 0 } as any;
      });

      await cleanupHostIptables();

      // IPv4 chain flush and delete should still happen regardless of bridge
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-F', 'FW_WRAPPER'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-X', 'FW_WRAPPER'], { reject: false });

      // DOCKER-USER rule lookup should NOT happen since bridge is null
      expect(mockedExeca).not.toHaveBeenCalledWith(
        'iptables',
        ['-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers'],
        { reject: false }
      );
    });
  });

  describe('ip6tables availability handling', () => {
    it('should warn and skip IPv6 setup when ip6tables is not available', async () => {
      await jest.isolateModulesAsync(async () => {
        const { setupHostIptables: setupFresh } = await import('./host-iptables');
        const execaModule = await import('execa');
        const execaMockedFresh = execaModule.default as jest.MockedFunction<typeof execa>;
        const loggerModule = await import('./logger');
        const loggerMockedFresh = loggerModule.logger as jest.Mocked<typeof loggerModule.logger>;

        execaMockedFresh.mockImplementation(async (cmd: string, args: string[]) => {
          // ip6tables availability check → fails (not available)
          if (cmd === 'ip6tables' && args[0] === '-L' && args[1] === '-n') {
            throw new Error('ip6tables: command not found');
          }
          // getNetworkBridgeName
          if (cmd === 'docker' && args[3] === '-f') {
            return { stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any;
          }
          // FW_WRAPPER existence check → doesn't exist
          if (cmd === 'iptables' && args[2] === '-L' && args[3] === 'FW_WRAPPER') {
            return { exitCode: 1 } as any;
          }
          return { stdout: '', stderr: '', exitCode: 0 } as any;
        });

        await setupFresh('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

        expect(loggerMockedFresh.warn).toHaveBeenCalledWith(
          'ip6tables is not available, IPv6 DNS servers will not be configured at the host level'
        );
        // IPv6 chain should NOT have been created
        expect(execaMockedFresh).not.toHaveBeenCalledWith(
          'ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']
        );
      });
    });

    it('should skip IPv6 cleanup when ip6tables is not available', async () => {
      await jest.isolateModulesAsync(async () => {
        const { cleanupHostIptables: cleanupFresh } = await import('./host-iptables');
        const execaModule = await import('execa');
        const execaMockedFresh = execaModule.default as jest.MockedFunction<typeof execa>;

        execaMockedFresh.mockImplementation(async (cmd: string, args: string[]) => {
          // ip6tables availability check → fails (not available)
          if (cmd === 'ip6tables' && args[0] === '-L' && args[1] === '-n') {
            throw new Error('ip6tables: command not found');
          }
          // getNetworkBridgeName
          if (cmd === 'docker' && args[1] === 'inspect') {
            return { stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any;
          }
          return { stdout: '', stderr: '', exitCode: 0 } as any;
        });

        await cleanupFresh();

        // IPv6 chain flush and delete should NOT happen
        expect(execaMockedFresh).not.toHaveBeenCalledWith(
          'ip6tables', ['-t', 'filter', '-F', 'FW_WRAPPER_V6'], { reject: false }
        );
        expect(execaMockedFresh).not.toHaveBeenCalledWith(
          'ip6tables', ['-t', 'filter', '-X', 'FW_WRAPPER_V6'], { reject: false }
        );
      });
    });
  });
});
