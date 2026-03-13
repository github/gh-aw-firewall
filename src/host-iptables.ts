import execa from 'execa';
import { logger } from './logger';
import { API_PROXY_PORTS } from './types';

const NETWORK_NAME = 'awf-net';
const CHAIN_NAME = 'FW_WRAPPER';
const CHAIN_NAME_V6 = 'FW_WRAPPER_V6';
const NETWORK_SUBNET = '172.30.0.0/24';

// Cache for ip6tables availability check (only checked once per run)
let ip6tablesAvailableCache: boolean | null = null;

// Track whether IPv6 was disabled via sysctl (so we can re-enable on cleanup)
let ipv6DisabledViaSysctl = false;

/**
 * Resets internal IPv6 state (for testing only).
 */
export function _resetIpv6State(): void {
  ip6tablesAvailableCache = null;
  ipv6DisabledViaSysctl = false;
}

/**
 * Gets the bridge interface name for the firewall network
 */
async function getNetworkBridgeName(): Promise<string | null> {
  try {
    const { stdout } = await execa('docker', [
      'network',
      'inspect',
      NETWORK_NAME,
      '-f',
      '{{index .Options "com.docker.network.bridge.name"}}',
    ]);
    const bridgeName = stdout.trim();
    return bridgeName || null;
  } catch (error) {
    logger.debug('Failed to get network bridge name:', error);
    return null;
  }
}

/**
 * Checks if ip6tables is available and functional.
 * The result is cached to avoid redundant system calls.
 */
async function isIp6tablesAvailable(): Promise<boolean> {
  // Return cached result if available
  if (ip6tablesAvailableCache !== null) {
    return ip6tablesAvailableCache;
  }

  try {
    await execa('ip6tables', ['-L', '-n'], { timeout: 5000 });
    ip6tablesAvailableCache = true;
    return true;
  } catch (error) {
    logger.debug('ip6tables not available:', error);
    ip6tablesAvailableCache = false;
    return false;
  }
}

/**
 * Disables IPv6 via sysctl when ip6tables is unavailable.
 * This prevents IPv6 from becoming an unfiltered bypass path.
 */
async function disableIpv6ViaSysctl(): Promise<void> {
  try {
    await execa('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=1']);
    await execa('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=1']);
    ipv6DisabledViaSysctl = true;
    logger.info('IPv6 disabled via sysctl (ip6tables unavailable)');
  } catch (error) {
    logger.warn('Failed to disable IPv6 via sysctl:', error);
  }
}

/**
 * Re-enables IPv6 via sysctl if it was previously disabled.
 */
async function enableIpv6ViaSysctl(): Promise<void> {
  if (!ipv6DisabledViaSysctl) {
    return;
  }
  try {
    await execa('sysctl', ['-w', 'net.ipv6.conf.all.disable_ipv6=0']);
    await execa('sysctl', ['-w', 'net.ipv6.conf.default.disable_ipv6=0']);
    ipv6DisabledViaSysctl = false;
    logger.debug('IPv6 re-enabled via sysctl');
  } catch (error) {
    logger.debug('Failed to re-enable IPv6 via sysctl:', error);
  }
}

/**
 * Creates the dedicated firewall network if it doesn't exist
 * Returns the Squid and agent IPs
 */
export async function ensureFirewallNetwork(): Promise<{
  subnet: string;
  squidIp: string;
  agentIp: string;
  proxyIp: string;
}> {
  logger.debug(`Ensuring firewall network '${NETWORK_NAME}' exists...`);

  // Check if network already exists
  let networkExists = false;
  try {
    await execa('docker', ['network', 'inspect', NETWORK_NAME]);
    networkExists = true;
    logger.debug(`Network '${NETWORK_NAME}' already exists`);
  } catch {
    // Network doesn't exist
  }

  if (!networkExists) {
    // Network doesn't exist, create it with explicit bridge name
    logger.debug(`Creating network '${NETWORK_NAME}' with subnet ${NETWORK_SUBNET}...`);
    await execa('docker', [
      'network',
      'create',
      NETWORK_NAME,
      '--subnet',
      NETWORK_SUBNET,
      '--opt',
      'com.docker.network.bridge.name=fw-bridge',
    ]);
    logger.success(`Created network '${NETWORK_NAME}' with bridge 'fw-bridge'`);
  }

  return {
    subnet: NETWORK_SUBNET,
    squidIp: '172.30.0.10',
    agentIp: '172.30.0.20',
    proxyIp: '172.30.0.30',
  };
}

/**
 * Sets up host-level iptables rules using DOCKER-USER chain
 * This ensures ALL containers on the firewall network are subject to egress filtering.
 *
 * Simplified security model: only localhost, Squid proxy, and DNS forwarding are allowed.
 * Containers use Docker's embedded DNS (127.0.0.11) as their only nameserver.
 * Docker's DNS proxy forwards queries to upstream servers configured via docker-compose dns: field.
 * These forwarded queries traverse the Docker bridge and must be allowed in DOCKER-USER.
 * Squid resolves DNS internally for all HTTP/HTTPS traffic.
 *
 * @param squidIp - IP address of the Squid proxy
 * @param squidPort - Port number of the Squid proxy
 * @param apiProxyIp - Optional IP address of the API proxy sidecar
 * @param dnsServers - Upstream DNS servers that Docker embedded DNS forwards to
 */
export async function setupHostIptables(squidIp: string, squidPort: number, dnsServers: string[], apiProxyIp?: string, dohProxyIp?: string): Promise<void> {
  logger.info('Setting up host-level iptables rules...');

  // Get the bridge interface name
  const bridgeName = await getNetworkBridgeName();
  if (!bridgeName) {
    throw new Error(`Failed to get bridge name for network '${NETWORK_NAME}'`);
  }

  logger.debug(`Bridge interface: ${bridgeName}`);

  // Check if we have permission to run iptables commands
  try {
    await execa('iptables', ['-t', 'filter', '-L', 'DOCKER-USER', '-n'], { timeout: 5000 });
  } catch (error: any) {
    if (error.stderr && error.stderr.includes('Permission denied')) {
      throw new Error(
        'Permission denied: iptables commands require root privileges. ' +
        'Please run this command with sudo.'
      );
    }
    // DOCKER-USER chain doesn't exist (shouldn't happen, but handle it)
    logger.warn('DOCKER-USER chain does not exist, which is unexpected. Attempting to create it...');
    try {
      await execa('iptables', ['-t', 'filter', '-N', 'DOCKER-USER']);
    } catch {
      throw new Error(
        'Failed to create DOCKER-USER chain. This may indicate a permission or Docker installation issue.'
      );
    }
  }

  // Create dedicated chains for our rules to make cleanup easier
  // Use CHAIN_NAME for IPv4 and CHAIN_NAME_V6 for IPv6
  logger.debug(`Creating dedicated chain '${CHAIN_NAME}'...`);

  // Remove chain if it exists (cleanup from previous runs)
  try {
    // Check if chain exists first
    const { exitCode } = await execa('iptables', ['-t', 'filter', '-L', CHAIN_NAME, '-n'], { reject: false });
    if (exitCode === 0) {
      logger.debug(`Chain '${CHAIN_NAME}' already exists, cleaning up...`);

      // First, remove any references from DOCKER-USER
      const { stdout } = await execa('iptables', [
        '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
      ], { reject: false });

      const lines = stdout.split('\n');
      const lineNumbers: number[] = [];
      for (const line of lines) {
        if (line.includes(CHAIN_NAME)) {
          const match = line.match(/^(\d+)/);
          if (match) {
            lineNumbers.push(parseInt(match[1], 10));
          }
        }
      }

      // Delete rules in reverse order
      for (const lineNum of lineNumbers.reverse()) {
        logger.debug(`Removing reference to ${CHAIN_NAME} from DOCKER-USER line ${lineNum}`);
        await execa('iptables', [
          '-t', 'filter', '-D', 'DOCKER-USER', lineNum.toString(),
        ], { reject: false });
      }

      // Then flush and delete the chain
      await execa('iptables', ['-t', 'filter', '-F', CHAIN_NAME], { reject: false });
      await execa('iptables', ['-t', 'filter', '-X', CHAIN_NAME], { reject: false });
    }
  } catch (error) {
    // Ignore errors
    logger.debug('Error during chain cleanup:', error);
  }

  // Create the chain
  await execa('iptables', ['-t', 'filter', '-N', CHAIN_NAME]);

  // Build rules in our dedicated chain
  // 1. Allow all traffic FROM the Squid proxy (it needs unrestricted outbound access)
  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-s', squidIp,
    '-j', 'ACCEPT',
  ]);

  // 1b. Allow HTTPS traffic FROM the DoH proxy (it needs to reach the DoH resolver directly)
  if (dohProxyIp) {
    logger.debug(`Allowing HTTPS traffic from DoH proxy at ${dohProxyIp}`);
    await execa('iptables', [
      '-t', 'filter', '-A', CHAIN_NAME,
      '-s', dohProxyIp, '-p', 'tcp', '--dport', '443',
      '-j', 'ACCEPT',
    ]);
  }

  // Note: API proxy sidecar (when enabled) does NOT get a firewall exemption.
  // It routes through Squid via HTTP_PROXY/HTTPS_PROXY environment variables,
  // ensuring domain whitelisting is enforced by Squid ACLs.

  // 2. Allow established and related connections (return traffic)
  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED',
    '-j', 'ACCEPT',
  ]);

  // 3. Allow localhost traffic
  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-o', 'lo',
    '-j', 'ACCEPT',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-d', '127.0.0.0/8',
    '-j', 'ACCEPT',
  ]);

  // 4. Check ip6tables availability and disable IPv6 if unavailable
  const ip6tablesAvailable = await isIp6tablesAvailable();
  if (!ip6tablesAvailable) {
    logger.warn('ip6tables is not available, disabling IPv6 via sysctl to prevent unfiltered bypass');
    await disableIpv6ViaSysctl();
  }

  // 4b. Allow DNS forwarding to upstream servers
  // Docker's embedded DNS (127.0.0.11) proxies queries to upstream servers configured
  // via docker-compose dns: field. These forwarded queries traverse the Docker bridge
  // and need to be allowed here. Only the configured upstream servers are permitted.
  const upstreamDns = dnsServers && dnsServers.length > 0 ? dnsServers : ['8.8.8.8', '8.8.4.4'];
  logger.debug(`Allowing DNS forwarding to upstream servers: ${upstreamDns.join(', ')}`);

  // Create IPv6 chain if needed (only when IPv6 DNS servers are configured)
  const hasIpv6Dns = upstreamDns.some(s => s.includes(':'));
  if (hasIpv6Dns && ip6tablesAvailable) {
    logger.debug(`Creating dedicated IPv6 chain '${CHAIN_NAME_V6}' for IPv6 DNS rules...`);
    try {
      const { exitCode: v6ChainExists } = await execa('ip6tables', ['-t', 'filter', '-L', CHAIN_NAME_V6, '-n'], { reject: false });
      if (v6ChainExists === 0) {
        logger.debug(`Chain '${CHAIN_NAME_V6}' already exists, cleaning up...`);
        await execa('ip6tables', ['-t', 'filter', '-F', CHAIN_NAME_V6], { reject: false });
        await execa('ip6tables', ['-t', 'filter', '-X', CHAIN_NAME_V6], { reject: false });
      }
    } catch (error) {
      logger.debug('Error during IPv6 chain cleanup:', error);
    }
    await execa('ip6tables', ['-t', 'filter', '-N', CHAIN_NAME_V6]);
  }

  for (const dnsServer of upstreamDns) {
    // IPv6 DNS servers must use ip6tables, IPv4 uses iptables
    const isV6 = dnsServer.includes(':');
    if (isV6) {
      if (ip6tablesAvailable) {
        await execa('ip6tables', [
          '-t', 'filter', '-A', CHAIN_NAME_V6,
          '-p', 'udp', '-d', dnsServer, '--dport', '53',
          '-j', 'ACCEPT',
        ]);
        await execa('ip6tables', [
          '-t', 'filter', '-A', CHAIN_NAME_V6,
          '-p', 'tcp', '-d', dnsServer, '--dport', '53',
          '-j', 'ACCEPT',
        ]);
      }
    } else {
      await execa('iptables', [
        '-t', 'filter', '-A', CHAIN_NAME,
        '-p', 'udp', '-d', dnsServer, '--dport', '53',
        '-j', 'ACCEPT',
      ]);
      await execa('iptables', [
        '-t', 'filter', '-A', CHAIN_NAME,
        '-p', 'tcp', '-d', dnsServer, '--dport', '53',
        '-j', 'ACCEPT',
      ]);
    }
  }

  // 5. Allow traffic to Squid proxy
  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-p', 'tcp', '-d', squidIp, '--dport', squidPort.toString(),
    '-j', 'ACCEPT',
  ]);

  // 5a. Allow DNS traffic to DoH proxy sidecar (when enabled)
  if (dohProxyIp) {
    logger.debug(`Allowing DNS traffic to DoH proxy sidecar at ${dohProxyIp}:53`);
    await execa('iptables', [
      '-t', 'filter', '-A', CHAIN_NAME,
      '-p', 'udp', '-d', dohProxyIp, '--dport', '53',
      '-j', 'ACCEPT',
    ]);
    await execa('iptables', [
      '-t', 'filter', '-A', CHAIN_NAME,
      '-p', 'tcp', '-d', dohProxyIp, '--dport', '53',
      '-j', 'ACCEPT',
    ]);
  }

  // 5b. Allow traffic to API proxy sidecar (when enabled)
  // Allow all API proxy ports (OpenAI, Anthropic, GitHub Copilot, OpenCode).
  // The sidecar itself routes through Squid, so domain whitelisting is still enforced.
  if (apiProxyIp) {
    const allPorts = Object.values(API_PROXY_PORTS);
    const minPort = Math.min(...allPorts);
    const maxPort = Math.max(...allPorts);
    logger.debug(`Allowing traffic to API proxy sidecar at ${apiProxyIp}:${minPort}-${maxPort}`);
    await execa('iptables', [
      '-t', 'filter', '-A', CHAIN_NAME,
      '-p', 'tcp', '-d', apiProxyIp, '--dport', `${minPort}:${maxPort}`,
      '-j', 'ACCEPT',
    ]);
  }

  // 6. Block multicast and link-local traffic
  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-m', 'addrtype', '--dst-type', 'MULTICAST',
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-d', '169.254.0.0/16',
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-d', '224.0.0.0/4',
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);

  // 7. Block all other UDP traffic (DNS to whitelisted servers already allowed above)
  // This catches DNS exfiltration attempts to unauthorized servers
  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-p', 'udp',
    '-j', 'LOG', '--log-prefix', '[FW_BLOCKED_UDP] ', '--log-level', '4',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-p', 'udp',
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);

  // 8. Default deny all other traffic
  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-j', 'LOG', '--log-prefix', '[FW_BLOCKED_OTHER] ', '--log-level', '4',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', CHAIN_NAME,
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);

  // Now insert a rule in DOCKER-USER that jumps to our chain for traffic FROM the firewall bridge
  // Note: We use -i (input interface) to match egress traffic FROM containers on the bridge
  // Check if rule already exists
  const { stdout: existingRules } = await execa('iptables', [
    '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
  ]);

  if (!existingRules.includes(`-i ${bridgeName}`)) {
    logger.debug(`Inserting rule in DOCKER-USER to jump to ${CHAIN_NAME} for bridge ${bridgeName}...`);
    await execa('iptables', [
      '-t', 'filter', '-I', 'DOCKER-USER', '1',
      '-i', bridgeName,
      '-j', CHAIN_NAME,
    ]);
  } else {
    logger.debug(`Rule for bridge ${bridgeName} already exists in DOCKER-USER`);
  }

  logger.success('Host-level iptables rules configured successfully');

  // Show the rules for debugging
  logger.debug('DOCKER-USER chain:');
  const { stdout: dockerUserRules } = await execa('iptables', [
    '-t', 'filter', '-L', 'DOCKER-USER', '-n', '-v',
  ]);
  logger.debug(dockerUserRules);

  logger.debug(`${CHAIN_NAME} chain:`);
  const { stdout: fwWrapperRules } = await execa('iptables', [
    '-t', 'filter', '-L', CHAIN_NAME, '-n', '-v',
  ]);
  logger.debug(fwWrapperRules);
}

/**
 * Cleans up host-level iptables rules (both IPv4 and IPv6)
 */
export async function cleanupHostIptables(): Promise<void> {
  logger.debug('Cleaning up host-level iptables rules...');

  try {
    // Get the bridge name
    const bridgeName = await getNetworkBridgeName();

    // Clean up IPv4 rules
    if (bridgeName) {
      // Find and remove the rule that jumps to our chain
      const { stdout } = await execa('iptables', [
        '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
      ], { reject: false });

      // Parse line numbers for rules that reference our bridge
      const lines = stdout.split('\n');
      const lineNumbers: number[] = [];
      for (const line of lines) {
        if ((line.includes(`-i ${bridgeName}`) || line.includes(`-o ${bridgeName}`)) && line.includes(CHAIN_NAME)) {
          const match = line.match(/^(\d+)/);
          if (match) {
            lineNumbers.push(parseInt(match[1], 10));
          }
        }
      }

      // Delete rules in reverse order (to maintain line numbers)
      for (const lineNum of lineNumbers.reverse()) {
        logger.debug(`Removing rule ${lineNum} from DOCKER-USER (IPv4)`);
        await execa('iptables', [
          '-t', 'filter', '-D', 'DOCKER-USER', lineNum.toString(),
        ], { reject: false });
      }
    }

    // Flush and delete our custom IPv4 chain
    await execa('iptables', ['-t', 'filter', '-F', CHAIN_NAME], { reject: false });
    await execa('iptables', ['-t', 'filter', '-X', CHAIN_NAME], { reject: false });

    logger.debug('IPv4 iptables rules cleaned up');

    // Clean up IPv6 rules (only if ip6tables is available)
    const ip6tablesAvailable = await isIp6tablesAvailable();
    if (ip6tablesAvailable) {
      if (bridgeName) {
        const { stdout: stdout6 } = await execa('ip6tables', [
          '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
        ], { reject: false });

        const lines6 = stdout6.split('\n');
        const lineNumbers6: number[] = [];
        for (const line of lines6) {
          if (line.includes(CHAIN_NAME_V6)) {
            const match = line.match(/^(\d+)/);
            if (match) {
              lineNumbers6.push(parseInt(match[1], 10));
            }
          }
        }

        for (const lineNum of lineNumbers6.reverse()) {
          logger.debug(`Removing rule ${lineNum} from DOCKER-USER (IPv6)`);
          await execa('ip6tables', [
            '-t', 'filter', '-D', 'DOCKER-USER', lineNum.toString(),
          ], { reject: false });
        }
      }

      // Flush and delete our custom IPv6 chain
      await execa('ip6tables', ['-t', 'filter', '-F', CHAIN_NAME_V6], { reject: false });
      await execa('ip6tables', ['-t', 'filter', '-X', CHAIN_NAME_V6], { reject: false });

      logger.debug('IPv6 ip6tables rules cleaned up');
    } else {
      logger.debug('ip6tables not available, skipping IPv6 cleanup');
    }

    // Re-enable IPv6 if it was disabled via sysctl
    await enableIpv6ViaSysctl();

    logger.debug('Host-level iptables rules cleaned up');
  } catch (error) {
    logger.debug('Error cleaning up iptables rules:', error);
    // Don't throw - cleanup should be best-effort
  }
}

/**
 * Removes the firewall network
 */
export async function cleanupFirewallNetwork(): Promise<void> {
  logger.debug(`Removing firewall network '${NETWORK_NAME}'...`);

  try {
    await execa('docker', ['network', 'rm', NETWORK_NAME], { reject: false });
    logger.debug('Firewall network removed');
  } catch (error) {
    logger.debug('Error removing firewall network:', error);
    // Don't throw - cleanup should be best-effort
  }
}
