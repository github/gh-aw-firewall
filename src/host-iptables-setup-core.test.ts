import { API_PROXY_PORTS } from './types';
import {
  execaError,
  execaMissingCommandError,
  execaResult,
  mockedExeca,
  setupDefaultIptablesMocks,
  setupHostIptablesTestSuite,
} from './test-helpers/host-iptables-test-setup';
import { setupHostIptables } from './host-iptables';
import { iptablesSharedTestHelpers } from './host-iptables-shared.test-utils';

// setupHostIptables intentionally allows the inclusive min:max API proxy port window.
const apiProxyPortRange = `${Math.min(...Object.values(API_PROXY_PORTS))}:${Math.max(...Object.values(API_PROXY_PORTS))}`;

describe('host-iptables (setup) — core chain installation', () => {
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
});
