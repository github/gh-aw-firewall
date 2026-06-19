import { API_PROXY_PORTS } from './types';
import {
  execaError,
  execaMissingCommandError,
  execaResult,
  mockedExeca,
  setupDefaultIptablesMocks,
  setupDockerBridgeMock,
  setupHostIptablesTestSuite,
} from './test-helpers/host-iptables-test-setup';
import { iptablesRulesTestHelpers } from './host-iptables-rules.test-utils';
import { setupHostIptables } from './host-iptables';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

// setupHostIptables intentionally allows the inclusive min:max API proxy port window.
const apiProxyPortRange = `${Math.min(...Object.values(API_PROXY_PORTS))}:${Math.max(...Object.values(API_PROXY_PORTS))}`;

describe('host-iptables (setup)', () => {
  setupHostIptablesTestSuite(iptablesSharedTestHelpers.resetIpv6State);

  describe('setupHostIptables', () => {
    it('should throw error if iptables permission denied', async () => {
      const permissionError = execaError('Permission denied', 'iptables: Permission denied');

      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce(execaResult({
          stdout: 'fw-bridge',
          stderr: '',
          exitCode: 0,
        }))
        // Mock iptables --version
        .mockResolvedValueOnce(execaResult())
        // Mock iptables -L DOCKER-USER (permission check)
        .mockRejectedValueOnce(permissionError);

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'])).rejects.toThrow(
        'Permission denied: iptables commands require root privileges'
      );
    });

    it('should throw a clear error if iptables is not installed', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', stderr: '', exitCode: 0 }))
        // Mock iptables --version (missing binary)
        .mockRejectedValueOnce(execaMissingCommandError());

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'])).rejects.toThrow(
        'iptables is required but was not found'
      );

      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', ['-t', 'filter', '-L', 'DOCKER-USER', '-n'], { timeout: 5000 });
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', ['-t', 'filter', '-N', 'DOCKER-USER']);
    });

    it('should create FW_WRAPPER chain and add rules', async () => {
      setupDefaultIptablesMocks({ catchAllStdout: 'Chain DOCKER-USER\nChain FW_WRAPPER' });

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
      setupDefaultIptablesMocks({ chainExists: true });
      mockedExeca.mockResolvedValueOnce(execaResult({
        stdout: '1    FW_WRAPPER  all  --  *      *       0.0.0.0/0            0.0.0.0/0\n',
      }));

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
      setupDefaultIptablesMocks();

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
      setupDefaultIptablesMocks();

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
      setupDefaultIptablesMocks();

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
      setupDefaultIptablesMocks();

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], '172.30.0.30');

      // Verify API proxy sidecar rule was added with port range
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.30', '--dport', apiProxyPortRange,
        '-j', 'ACCEPT',
      ]);
    });

    it('should throw error when bridge name is not found', async () => {
      // Mock getNetworkBridgeName returning empty/null
      mockedExeca.mockResolvedValueOnce(execaResult({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'])).rejects.toThrow(
        "Failed to get bridge name for network 'awf-net'"
      );
    });

    it('should create DOCKER-USER chain when it does not exist', async () => {
      const noChainError = execaError('No chain/target/match by that name');

      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', stderr: '', exitCode: 0 }))
        // Mock iptables --version
        .mockResolvedValueOnce(execaResult())
        // Mock iptables -L DOCKER-USER (chain doesn't exist)
        .mockRejectedValueOnce(noChainError)
        // Mock iptables -N DOCKER-USER (create chain)
        .mockResolvedValueOnce(execaResult({ stdout: '', stderr: '', exitCode: 0 }))
        // Mock chain existence check (FW_WRAPPER doesn't exist)
        .mockResolvedValueOnce(execaResult({ exitCode: 1 }));

      // Mock all subsequent calls
      mockedExeca.mockResolvedValue(execaResult({ stdout: '', stderr: '', exitCode: 0 }));

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Verify DOCKER-USER chain was created
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-N', 'DOCKER-USER']);
    });

    it('should skip inserting DOCKER-USER jump rule if it already exists', async () => {
      // Simulate rule already present: iptables -C returns exit code 0
      setupDefaultIptablesMocks({ dockerUserJumpRuleExists: true });

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Should NOT insert a new rule since it already exists
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-I', 'DOCKER-USER', '1',
        '-i', 'fw-bridge',
        '-j', 'FW_WRAPPER',
      ]);
    });

    it('should not create IPv6 chain but should add DNS forwarding rules', async () => {
      setupDefaultIptablesMocks();

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
      setupDefaultIptablesMocks();

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
      setupDefaultIptablesMocks();

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Verify sysctl was NOT called to disable IPv6
      expect(mockedExeca).not.toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=1']);
      expect(mockedExeca).not.toHaveBeenCalledWith('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=1']);
    });

  });

  describe('isValidPortSpec', () => {
    it('should accept valid single ports', () => {
      expect(iptablesRulesTestHelpers.isValidPortSpec('1')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('80')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('443')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('65535')).toBe(true);
    });

    it('should accept valid port ranges', () => {
      expect(iptablesRulesTestHelpers.isValidPortSpec('3000-3010')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('1-65535')).toBe(true);
      expect(iptablesRulesTestHelpers.isValidPortSpec('80-80')).toBe(true);
    });

    it('should reject invalid port specs', () => {
      expect(iptablesRulesTestHelpers.isValidPortSpec('abc')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('0')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('65536')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('-1')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('99999')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('3010-3000')).toBe(false); // reversed range
      expect(iptablesRulesTestHelpers.isValidPortSpec('')).toBe(false);
      expect(iptablesRulesTestHelpers.isValidPortSpec('080-090')).toBe(false); // leading zeros in range
      expect(iptablesRulesTestHelpers.isValidPortSpec('01-100')).toBe(false); // leading zero in start
      expect(iptablesRulesTestHelpers.isValidPortSpec('1-0100')).toBe(false); // leading zero in end
    });
  });

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

  describe('setupHostIptables with IPv6 DNS servers', () => {
    it('should create FW_WRAPPER_V6 chain and add IPv6 DNS rules when ip6tables is available', async () => {
      setupDefaultIptablesMocks();

      // ip6tables available; FW_WRAPPER_V6 does not exist
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // Verify IPv6 chain creation
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);

      // Verify IPv6 DNS allow rules
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

      // IPv4 DNS rule should still be added via iptables
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '8.8.8.8', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
    });

    it('should flush existing FW_WRAPPER_V6 chain if it already exists', async () => {
      setupDefaultIptablesMocks();

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        // ip6tables availability check (-L -n without chain name)
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('-n') && !args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        // FW_WRAPPER_V6 chain already exists
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // Should flush and delete existing chain
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-F', 'FW_WRAPPER_V6'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-X', 'FW_WRAPPER_V6'], { reject: false });
      // Then recreate
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);
    });

    it('should skip IPv6 DNS rules (not create chain) when ip6tables is unavailable', async () => {
      setupDefaultIptablesMocks();

      mockedExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'ip6tables') {
          return Promise.reject(new Error('ip6tables not found'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']);

      // Should NOT create IPv6 chain
      expect(mockedExeca).not.toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-N', 'FW_WRAPPER_V6']);
    });
  });

  describe('setupHostIptables DOCKER-USER chain creation failure', () => {
    it('should throw when DOCKER-USER chain does not exist and creation fails', async () => {
      const noChainError = execaError('No chain by that name');

      mockedExeca
        // getNetworkBridgeName
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', stderr: '', exitCode: 0 }))
        // iptables --version
        .mockResolvedValueOnce(execaResult())
        // iptables -L DOCKER-USER (chain doesn't exist)
        .mockRejectedValueOnce(noChainError)
        // iptables -N DOCKER-USER (creation fails)
        .mockRejectedValueOnce(new Error('Failed to create chain'));

      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'])).rejects.toThrow(
        'Failed to create DOCKER-USER chain'
      );
    });
  });

  describe('setupHostIptables with empty entries in allowHostPorts', () => {
    it('should skip empty entries in allowHostPorts (covers parseValidPortSpecs empty-entry branch)', async () => {
      setupDefaultIptablesMocks();

      setupDockerBridgeMock({ gateway: '', exitCode: 1 });

      // "80,,443,8080" contains an empty entry between the two commas; 8080 is a non-default port
      await setupHostIptables(
        '172.30.0.10', 3128, ['8.8.8.8'],
        undefined, undefined,
        { enabled: true, allowHostPorts: '80,,443,8080' },
      );

      // Non-default port should be added; empty entry should be silently skipped
      expect(mockedExeca).toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '--dport', '8080',
      ]));
    });
  });

  describe('setupHostIptables chain cleanup error handling', () => {
    it('should continue setup when existing FW_WRAPPER chain cleanup throws', async () => {
      // chain exists (exitCode 0) but cleanupChain throws — should be swallowed and setup continues
      mockedExeca
        // getNetworkBridgeName
        .mockResolvedValueOnce(execaResult({ stdout: 'fw-bridge', exitCode: 0 }))
        // iptables --version
        .mockResolvedValueOnce(execaResult({ exitCode: 0, stdout: '' }))
        // iptables -L DOCKER-USER (permission check) — success
        .mockResolvedValueOnce(execaResult({ exitCode: 0, stdout: '' }))
        // iptables -L FW_WRAPPER (check if chain exists) — exists
        .mockResolvedValueOnce(execaResult({ exitCode: 0 }));

      // cleanupChain calls: list DOCKER-USER --line-numbers (throw here)
      mockedExeca.mockRejectedValueOnce(new Error('unexpected cleanup error'));

      // remaining calls succeed
      mockedExeca.mockResolvedValue(execaResult({ stdout: '', exitCode: 0 }));

      // should NOT throw — the catch block swallows the error
      await expect(setupHostIptables('172.30.0.10', 3128, ['8.8.8.8'])).resolves.toBeUndefined();
    });

    it('should continue setup when IPv6 chain cleanup throws', async () => {
      setupDefaultIptablesMocks();

      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        // ip6tables availability check — available
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('-n') && !args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        // FW_WRAPPER_V6 check — exists
        if (cmd === 'ip6tables' && args.includes('-L') && args.includes('FW_WRAPPER_V6')) {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        // ip6tables -F (flush) — throw to exercise line 213 catch
        if (cmd === 'ip6tables' && args.includes('-F')) {
          throw new Error('flush failed unexpectedly');
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      }) as any);

      // Should NOT throw — the catch block at line 213 swallows the error
      await expect(
        setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '2001:4860:4860::8888']),
      ).resolves.toBeUndefined();
    });
  });
});
