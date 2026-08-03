import * as fs from 'fs';
import { isIP } from 'net';
import { logger as defaultLogger } from './logger';
import { DEFAULT_DNS_SERVERS } from './config/network-policy';

type Logger = typeof defaultLogger;

/**
 * Fallback when no usable resolvers are detected on the host.
 * Centralized in src/config/sandbox-network-policy.json and re-exported here so
 * existing import sites keep working unchanged.
 */
export { DEFAULT_DNS_SERVERS };

/**
 * DNS servers that are reachable only via host-specific network paths which
 * may be disrupted by VPN tools like Tailscale that modify host routing after
 * AWF starts.
 *
 * - Azure DHCP DNS (168.63.129.16): intercepted by Azure hypervisor; unreachable
 *   outside Azure VNet or when policy-routing routes 0.0.0.0/0 via a Tailscale
 *   exit node or accepted subnet route.
 * - Tailscale Magic DNS (100.100.100.100): only reachable via the tailscale0
 *   interface; Docker bridge containers cannot reach it.
 */
const AZURE_DHCP_DNS = '168.63.129.16';
const TAILSCALE_MAGIC_DNS = '100.100.100.100';

/**
 * Returns true for DNS servers that are host-specific and may become unreachable
 * from Docker bridge containers when the host's routing is modified by tools
 * like Tailscale (e.g. when an exit node or accepted subnet route captures the
 * default route or the path to these servers).
 *
 * Non-portable servers include:
 * - Azure DHCP DNS (168.63.129.16)
 * - Tailscale Magic DNS (100.100.100.100)
 * - Link-local addresses (169.254.x.x / RFC 3927) — not routable over bridges
 */
export function isNonPortableDns(ip: string): boolean {
  if (ip === AZURE_DHCP_DNS) return true;
  if (ip === TAILSCALE_MAGIC_DNS) return true;
  if (ip.startsWith('169.254.')) return true;
  return false;
}

/**
 * Filters DNS servers for use in network-isolation (topology) mode.
 *
 * In isolation mode the Squid proxy container is dual-homed: it has a static IP
 * on the internal `awf-net` network and an auto-assigned IP on the external
 * `awf-ext` Docker bridge. All DNS queries and upstream TCP connections leave
 * through `awf-ext`. When the host's routing is later modified by a VPN tool
 * such as Tailscale (e.g. via an accepted exit-node or subnet-route that covers
 * `0.0.0.0/0` or the specific DNS server address), DNS queries from the Docker
 * bridge to host-specific servers like Azure DNS (168.63.129.16) or Tailscale
 * Magic DNS (100.100.100.100) can be black-holed, causing every Squid lookup to
 * fail with `TCP_TUNNEL:HIER_NONE 503`.
 *
 * This function removes non-portable servers from the list. If no portable
 * servers remain, it falls back to DEFAULT_DNS_SERVERS (8.8.8.8, 8.8.4.4),
 * which are publicly routable and independent of host-specific network paths.
 *
 * @param servers - The resolved DNS server list (from --dns-servers or auto-detection).
 * @param logger  - Optional logger for diagnostic output.
 * @returns A filtered list of DNS servers safe for use from a Docker bridge.
 */
export function filterForNetworkIsolation(servers: string[], logger?: Logger): string[] {
  const log = logger ?? defaultLogger;

  const nonPortable = servers.filter(isNonPortableDns);
  const portable = servers.filter(s => !isNonPortableDns(s));

  if (nonPortable.length > 0) {
    log.warn(
      `Network-isolation: removing ${nonPortable.length} non-portable DNS server(s) ` +
      `that may become unreachable from Docker bridge containers when host routing ` +
      `is modified by tools like Tailscale: ${nonPortable.join(', ')}`
    );
  }

  if (portable.length > 0) {
    return portable;
  }

  // All detected servers are non-portable — fall back to public DNS.
  log.warn(
    `Network-isolation: no portable DNS servers remain after filtering; ` +
    `falling back to ${DEFAULT_DNS_SERVERS.join(', ')}. ` +
    `If your environment requires specific DNS, use --dns-servers to override.`
  );
  return [...DEFAULT_DNS_SERVERS];
}

/**
 * Paths to try for resolv.conf, in priority order.
 * systemd-resolved's upstream config first (has real upstream servers),
 * then the standard resolv.conf (may contain 127.0.0.53 stub).
 */
const RESOLV_CONF_PATHS = ['/run/systemd/resolve/resolv.conf', '/etc/resolv.conf'];

function isValidIp(ip: string): boolean {
  return isIP(ip) !== 0;
}

function isLoopback(ip: string): boolean {
  // 127.0.0.0/8 for IPv4
  if (ip.startsWith('127.')) return true;
  // ::1 for IPv6
  if (ip === '::1') return true;
  return false;
}

/**
 * Parse nameserver entries from resolv.conf content.
 * Pure function — no I/O.
 */
function parseResolvConf(content: string): string[] {
  const servers: string[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*nameserver\s+(\S+)/);
    if (match) {
      const ip = match[1];
      if (isValidIp(ip)) {
        servers.push(ip);
      }
    }
  }
  return servers;
}

/**
 * Detect usable DNS servers from the host's resolv.conf files.
 * Filters out loopback addresses (127.0.0.0/8, ::1) since those point to
 * local stub resolvers that won't be reachable from inside a container.
 * Falls back to DEFAULT_DNS_SERVERS if no usable servers are found.
 */
export function detectHostDnsServers(logger?: Logger): string[] {
  const log = logger ?? defaultLogger;

  for (const filePath of RESOLV_CONF_PATHS) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      log.debug(`DNS auto-detect: could not read ${filePath}, trying next`);
      continue;
    }

    const allServers = parseResolvConf(content);
    const usable = allServers.filter(ip => !isLoopback(ip));

    if (usable.length > 0) {
      log.info(`Auto-detected DNS servers from ${filePath}: ${usable.join(', ')}`);
      return usable;
    }

    log.debug(`DNS auto-detect: ${filePath} had no usable servers after filtering loopback addresses`);
  }

  log.warn(`Could not detect host DNS servers; falling back to ${DEFAULT_DNS_SERVERS.join(', ')}`);
  return DEFAULT_DNS_SERVERS;
}
