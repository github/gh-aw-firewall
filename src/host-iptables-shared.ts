import execa from 'execa';
import { logger } from './logger';
import { getLocalDockerEnv } from './docker-host';

export const NETWORK_NAME = 'awf-net';
export const CHAIN_NAME = 'FW_WRAPPER';
export const CHAIN_NAME_V6 = 'FW_WRAPPER_V6';
export const NETWORK_SUBNET = '172.30.0.0/24';
export const AWF_NETWORK_GATEWAY = '172.30.0.1';
export const SQUID_IP = '172.30.0.10';
export const AGENT_IP = '172.30.0.20';
export const API_PROXY_IP = '172.30.0.30';
export const DOH_PROXY_IP = '172.30.0.40';
export const CLI_PROXY_IP = '172.30.0.50';

// Cache for ip6tables availability check (only checked once per run)
let ip6tablesAvailableCache: boolean | null = null;

// Track whether IPv6 was disabled via sysctl (so we can re-enable on cleanup)
let ipv6DisabledViaSysctl = false;

/**
 * Resets internal IPv6 state (for testing only).
 */
function resetIpv6State(): void {
  ip6tablesAvailableCache = null;
  ipv6DisabledViaSysctl = false;
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const iptablesSharedTestHelpers = { resetIpv6State };

/**
 * Gets the bridge interface name for the firewall network
 */
export async function getNetworkBridgeName(): Promise<string | null> {
  try {
    const { stdout } = await execa('docker', [
      'network',
      'inspect',
      NETWORK_NAME,
      '-f',
      '{{index .Options "com.docker.network.bridge.name"}}',
    ], { env: getLocalDockerEnv() });
    const bridgeName = stdout.trim();
    return bridgeName || null;
  } catch (error) {
    logger.debug('Failed to get network bridge name:', error);
    return null;
  }
}

/**
 * Gets the Docker default bridge gateway IP (e.g., 172.17.0.1).
 * This is the IP that host.docker.internal resolves to inside containers.
 */
export async function getDockerBridgeGateway(): Promise<string | null> {
  try {
    const { stdout } = await execa('docker', [
      'network', 'inspect', 'bridge',
      '-f', '{{(index .IPAM.Config 0).Gateway}}',
    ], { env: getLocalDockerEnv() });
    const gateway = stdout.trim();
    if (!gateway) return null;
    // Validate IPv4 format before using in iptables rules
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Regex.test(gateway)) {
      logger.warn(`Docker bridge gateway returned invalid IPv4: ${gateway}, skipping`);
      return null;
    }
    return gateway;
  } catch (error) {
    logger.debug('Failed to get Docker bridge gateway:', error);
    return null;
  }
}

/**
 * Checks if ip6tables is available and functional.
 * The result is cached to avoid redundant system calls.
 */
export async function isIp6tablesAvailable(): Promise<boolean> {
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
export async function disableIpv6ViaSysctl(): Promise<void> {
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
 * Adds both UDP and TCP ACCEPT rules on port 53 for the given destination to a chain.
 * This helper keeps DNS allowlist rules as a consistent pair by rolling back any
 * successfully-added rule if a later add fails.
 */
export async function addDnsRules(
  cmd: 'iptables' | 'ip6tables',
  chain: string,
  destination: string,
): Promise<void> {
  const addedProtos: Array<'udp' | 'tcp'> = [];

  try {
    for (const proto of ['udp', 'tcp'] as const) {
      await execa(cmd, [
        '-t', 'filter', '-A', chain,
        '-p', proto, '-d', destination, '--dport', '53',
        '-j', 'ACCEPT',
      ]);
      addedProtos.push(proto);
    }
  } catch (error) {
    for (const proto of addedProtos.reverse()) {
      try {
        await execa(cmd, [
          '-t', 'filter', '-D', chain,
          '-p', proto, '-d', destination, '--dport', '53',
          '-j', 'ACCEPT',
        ]);
      } catch (rollbackError) {
        logger.warn(`Failed to roll back ${cmd} DNS ${proto} rule for ${destination}:`, rollbackError);
      }
    }

    throw error;
  }
}

/**
 * Removes references to a chain from DOCKER-USER, then flushes and deletes the chain.
 */
export async function cleanupChain(
  cmd: 'iptables' | 'ip6tables',
  chainName: string,
  options: {
    removeDockerUserReferences?: boolean;
    matchPredicate?: (line: string) => boolean;
  } = {},
): Promise<void> {
  const { removeDockerUserReferences = true, matchPredicate } = options;

  if (removeDockerUserReferences) {
    const { stdout } = await execa(cmd, [
      '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
    ], { reject: false });

    const lineNumbers: number[] = [];
    for (const line of stdout.split('\n')) {
      const shouldDelete = matchPredicate ? matchPredicate(line) : line.includes(chainName);
      if (shouldDelete) {
        const match = line.match(/^(\d+)/);
        if (match) {
          lineNumbers.push(parseInt(match[1], 10));
        }
      }
    }

    for (const lineNum of lineNumbers.reverse()) {
      await execa(cmd, ['-t', 'filter', '-D', 'DOCKER-USER', lineNum.toString()], { reject: false });
    }
  }

  await execa(cmd, ['-t', 'filter', '-F', chainName], { reject: false });
  await execa(cmd, ['-t', 'filter', '-X', chainName], { reject: false });
}

/**
 * Re-enables IPv6 via sysctl if it was previously disabled.
 */
export async function enableIpv6ViaSysctl(): Promise<void> {
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
