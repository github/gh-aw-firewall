import execa from 'execa';
import { logger } from './logger';
import { API_PROXY_PORTS } from './types';
import { DEFAULT_DNS_SERVERS } from './dns-resolver';
import {
  AWF_NETWORK_GATEWAY,
  CHAIN_NAME,
  CHAIN_NAME_V6,
  NETWORK_NAME,
  addDnsRules,
  cleanupChain,
  disableIpv6ViaSysctl,
  getDockerBridgeGateway,
  getNetworkBridgeName,
  isIp6tablesAvailable,
} from './host-iptables-shared';

/**
 * Configuration for host access rules in the FW_WRAPPER chain.
 * When enabled, allows container traffic to reach the Docker host gateway
 * (needed for Playwright localhost testing, MCP servers, etc.).
 */
export interface HostAccessConfig {
  enabled: boolean;
  allowHostPorts?: string;
  allowHostServicePorts?: string;
}

/**
 * Configuration for the CLI proxy's connection to an external DIFC proxy on the host.
 */
export interface CliProxyHostConfig {
  /** CLI proxy container IP on awf-net (e.g., 172.30.0.50) */
  ip: string;
  /** DIFC proxy port on the host (e.g., 18443) */
  difcProxyPort: number;
}

/**
 * Validates a port specification string.
 * Accepts a single port (1-65535) or a port range ("N-M" where both are valid ports and N <= M).
 */
function isValidPortSpec(spec: string): boolean {
  const rangeMatch = spec.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (String(start) !== rangeMatch[1] || String(end) !== rangeMatch[2]) return false;
    return start >= 1 && start <= 65535 && end >= 1 && end <= 65535 && start <= end;
  }
  const port = parseInt(spec, 10);
  return !isNaN(port) && String(port) === spec && port >= 1 && port <= 65535;
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const iptablesRulesTestHelpers = { isValidPortSpec };

function parseValidPortSpecs(input: string | undefined, label: string): string[] {
  if (!input) {
    return [];
  }

  const validSpecs: string[] = [];
  for (const entry of input.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (!isValidPortSpec(trimmed)) {
      logger.warn(`Skipping invalid ${label}: ${trimmed}`);
      continue;
    }
    validSpecs.push(trimmed);
  }

  return validSpecs;
}

async function checkPermissionsAndSetupChain(chain: string): Promise<void> {
  // Check if we have permission to run iptables commands
  try {
    await execa('iptables', ['-t', 'filter', '-L', 'DOCKER-USER', '-n'], { timeout: 5000 });
  } catch (error: unknown) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr
      : '';
    if (stderr.includes('Permission denied')) {
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
  logger.debug(`Creating dedicated chain '${chain}'...`);

  // Remove chain if it exists (cleanup from previous runs)
  try {
    const { exitCode } = await execa('iptables', ['-t', 'filter', '-L', chain, '-n'], { reject: false });
    if (exitCode === 0) {
      logger.debug(`Chain '${chain}' already exists, cleaning up...`);
      await cleanupChain('iptables', chain);
    }
  } catch (error) {
    logger.debug('Error during chain cleanup:', error);
  }

  await execa('iptables', ['-t', 'filter', '-N', chain]);
}

async function addProxySourceAcceptRules(chain: string, squidIp: string, dohProxyIp?: string): Promise<void> {
  // 1. Allow all traffic FROM the Squid proxy (it needs unrestricted outbound access)
  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-s', squidIp,
    '-j', 'ACCEPT',
  ]);

  // 1b. Allow HTTPS traffic FROM the DoH proxy (it needs to reach the DoH resolver directly)
  if (dohProxyIp) {
    logger.debug(`Allowing HTTPS traffic from DoH proxy at ${dohProxyIp}`);
    await execa('iptables', [
      '-t', 'filter', '-A', chain,
      '-s', dohProxyIp, '-p', 'tcp', '--dport', '443',
      '-j', 'ACCEPT',
    ]);
  }
}

async function addConnectionTrackingRules(chain: string): Promise<void> {
  // 2. Allow established and related connections (return traffic)
  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED',
    '-j', 'ACCEPT',
  ]);

  // 3. Allow localhost traffic
  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-o', 'lo',
    '-j', 'ACCEPT',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-d', '127.0.0.0/8',
    '-j', 'ACCEPT',
  ]);
}

async function addIpv6DnsRules(chain: string, dnsServers: string[]): Promise<{ ipv6ChainName: string | null }> {
  // 4. Check ip6tables availability and disable IPv6 if unavailable
  const ip6tablesAvailable = await isIp6tablesAvailable();
  if (!ip6tablesAvailable) {
    logger.warn('ip6tables is not available, disabling IPv6 via sysctl to prevent unfiltered bypass');
    await disableIpv6ViaSysctl();
  }

  // 4b. Allow DNS forwarding to upstream servers
  const upstreamDns = dnsServers && dnsServers.length > 0 ? dnsServers : DEFAULT_DNS_SERVERS;
  logger.debug(`Allowing DNS forwarding to upstream servers: ${upstreamDns.join(', ')}`);

  const hasIpv6Dns = upstreamDns.some(s => s.includes(':'));
  let ipv6ChainName: string | null = null;
  if (hasIpv6Dns && ip6tablesAvailable) {
    ipv6ChainName = CHAIN_NAME_V6;
    logger.debug(`Creating dedicated IPv6 chain '${ipv6ChainName}' for IPv6 DNS rules...`);
    try {
      const { exitCode: v6ChainExists } = await execa('ip6tables', ['-t', 'filter', '-L', ipv6ChainName, '-n'], { reject: false });
      if (v6ChainExists === 0) {
        logger.debug(`Chain '${ipv6ChainName}' already exists, cleaning up...`);
        await execa('ip6tables', ['-t', 'filter', '-F', ipv6ChainName], { reject: false });
        await execa('ip6tables', ['-t', 'filter', '-X', ipv6ChainName], { reject: false });
      }
    } catch (error) {
      logger.debug('Error during IPv6 chain cleanup:', error);
    }
    await execa('ip6tables', ['-t', 'filter', '-N', ipv6ChainName]);
  }

  for (const dnsServer of upstreamDns) {
    const isV6 = dnsServer.includes(':');
    if (isV6) {
      if (ipv6ChainName) {
        await addDnsRules('ip6tables', ipv6ChainName, dnsServer);
      }
    } else {
      await addDnsRules('iptables', chain, dnsServer);
    }
  }

  return { ipv6ChainName };
}

interface ProxyDestinationRuleOptions {
  squidPort: number;
  apiProxyIp?: string;
  dohProxyIp?: string;
  hostAccess?: HostAccessConfig;
  cliProxyConfig?: CliProxyHostConfig;
}

async function addProxyDestinationAcceptRules(
  chain: string,
  squidIp: string,
  {
    squidPort,
    apiProxyIp,
    dohProxyIp,
    hostAccess,
    cliProxyConfig,
  }: ProxyDestinationRuleOptions,
): Promise<void> {
  // 5. Allow traffic to Squid proxy
  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-p', 'tcp', '-d', squidIp, '--dport', squidPort.toString(),
    '-j', 'ACCEPT',
  ]);

  // 5a. Allow DNS traffic to DoH proxy sidecar (when enabled)
  if (dohProxyIp) {
    logger.debug(`Allowing DNS traffic to DoH proxy sidecar at ${dohProxyIp}:53`);
    await addDnsRules('iptables', chain, dohProxyIp);
  }

  // 5b. Allow traffic to API proxy sidecar (when enabled)
  // Allow all API proxy ports declared in API_PROXY_PORTS.
  // The sidecar itself routes through Squid, so domain whitelisting is still enforced.
  if (apiProxyIp) {
    const allPorts = Object.values(API_PROXY_PORTS);
    const minPort = Math.min(...allPorts);
    const maxPort = Math.max(...allPorts);
    const apiProxyPortRange = [minPort, maxPort].join(':');
    logger.debug(`Allowing traffic to API proxy sidecar at ${apiProxyIp}:${minPort}-${maxPort}`);
    await execa('iptables', [
      '-t', 'filter', '-A', chain,
      '-p', 'tcp', '-d', apiProxyIp, '--dport', apiProxyPortRange,
      '-j', 'ACCEPT',
    ]);
  }

  const needsGatewayIps = !!cliProxyConfig || !!hostAccess?.enabled;
  const dockerBridgeGateway = needsGatewayIps ? await getDockerBridgeGateway() : null;
  const gatewayIps = [AWF_NETWORK_GATEWAY];
  if (dockerBridgeGateway) {
    gatewayIps.push(dockerBridgeGateway);
  }

  // 5b2. Allow CLI proxy container to reach host DIFC proxy (when enabled)
  if (cliProxyConfig) {
    const { ip: cliProxyIp, difcProxyPort } = cliProxyConfig;
    for (const gwIp of gatewayIps) {
      logger.debug(`Allowing CLI proxy (${cliProxyIp}) → host gateway (${gwIp}):${difcProxyPort}`);
      await execa('iptables', [
        '-t', 'filter', '-A', chain,
        '-p', 'tcp', '-s', cliProxyIp, '-d', gwIp, '--dport', difcProxyPort.toString(),
        '-j', 'ACCEPT',
      ]);
    }
    logger.info(`CLI proxy host access enabled: ${cliProxyIp} → host gateway:${difcProxyPort}`);
  }

  // 5c. Allow traffic to host gateway when host access is enabled
  if (hostAccess?.enabled) {
    const defaultPorts = ['80', '443'];
    const customPorts = [
      ...parseValidPortSpecs(hostAccess.allowHostPorts, 'port spec'),
      ...parseValidPortSpecs(hostAccess.allowHostServicePorts, 'host service port spec'),
    ];
    const allPorts = [...new Set([...defaultPorts, ...customPorts])];

    for (const gwIp of gatewayIps) {
      for (const port of allPorts) {
        logger.debug(`Allowing host gateway traffic: ${gwIp}:${port}`);
        await execa('iptables', [
          '-t', 'filter', '-A', chain,
          '-p', 'tcp', '-d', gwIp, '--dport', port,
          '-j', 'ACCEPT',
        ]);
      }
    }
    logger.info(`Host access enabled: allowing traffic to gateway IPs ${gatewayIps.join(', ')} on ports ${allPorts.join(', ')}`);
  }
}

async function addBlockRules(chain: string, _ipv6ChainName: string | null): Promise<void> {
  // 6. Block multicast and link-local traffic
  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-m', 'addrtype', '--dst-type', 'MULTICAST',
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-d', '169.254.0.0/16',
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-d', '224.0.0.0/4',
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);

  // 7. Block all other UDP traffic (DNS to whitelisted servers already allowed above)
  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-p', 'udp',
    '-j', 'LOG', '--log-prefix', '[FW_BLOCKED_UDP] ', '--log-level', '4',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-p', 'udp',
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);

  // 8. Default deny all other traffic
  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-j', 'LOG', '--log-prefix', '[FW_BLOCKED_OTHER] ', '--log-level', '4',
  ]);

  await execa('iptables', [
    '-t', 'filter', '-A', chain,
    '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable',
  ]);
}

async function insertDockerUserJumpRule(chain: string, bridgeName: string): Promise<void> {
  const { stdout: existingRules } = await execa('iptables', [
    '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
  ]);

  if (!existingRules.includes(`-i ${bridgeName}`)) {
    logger.debug(`Inserting rule in DOCKER-USER to jump to ${chain} for bridge ${bridgeName}...`);
    await execa('iptables', [
      '-t', 'filter', '-I', 'DOCKER-USER', '1',
      '-i', bridgeName,
      '-j', chain,
    ]);
  } else {
    logger.debug(`Rule for bridge ${bridgeName} already exists in DOCKER-USER`);
  }
}

async function logChainDebugOutput(chain: string): Promise<void> {
  logger.debug('DOCKER-USER chain:');
  const { stdout: dockerUserRules } = await execa('iptables', [
    '-t', 'filter', '-L', 'DOCKER-USER', '-n', '-v',
  ]);
  logger.debug(dockerUserRules);

  logger.debug(`${chain} chain:`);
  const { stdout: chainRules } = await execa('iptables', [
    '-t', 'filter', '-L', chain, '-n', '-v',
  ]);
  logger.debug(chainRules);
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
 * @param hostAccess - Optional host access configuration for localhost/Playwright support
 * @param cliProxyConfig - Optional CLI proxy config for DIFC proxy host access
 */
export async function setupHostIptables(squidIp: string, squidPort: number, dnsServers: string[], apiProxyIp?: string, dohProxyIp?: string, hostAccess?: HostAccessConfig, cliProxyConfig?: CliProxyHostConfig): Promise<void> {
  logger.info('Setting up host-level iptables rules...');

  // Get the bridge interface name
  const bridgeName = await getNetworkBridgeName();
  if (!bridgeName) {
    throw new Error(`Failed to get bridge name for network '${NETWORK_NAME}'`);
  }

  logger.debug(`Bridge interface: ${bridgeName}`);

  await checkPermissionsAndSetupChain(CHAIN_NAME);
  await addProxySourceAcceptRules(CHAIN_NAME, squidIp, dohProxyIp);

  // Note: API proxy sidecar (when enabled) does NOT get a firewall exemption.
  // It routes through Squid via HTTP_PROXY/HTTPS_PROXY environment variables,
  // ensuring domain whitelisting is enforced by Squid ACLs.

  await addConnectionTrackingRules(CHAIN_NAME);
  const { ipv6ChainName } = await addIpv6DnsRules(CHAIN_NAME, dnsServers);
  await addProxyDestinationAcceptRules(CHAIN_NAME, squidIp, {
    squidPort,
    apiProxyIp,
    dohProxyIp,
    hostAccess,
    cliProxyConfig,
  });
  await addBlockRules(CHAIN_NAME, ipv6ChainName);
  await insertDockerUserJumpRule(CHAIN_NAME, bridgeName);

  logger.success('Host-level iptables rules configured successfully');
  await logChainDebugOutput(CHAIN_NAME);
}
