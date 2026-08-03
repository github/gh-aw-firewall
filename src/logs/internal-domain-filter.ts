/**
 * Utilities for identifying AWF-internal hostnames and IPs that should be
 * excluded from user-facing blocked-domain reports and firewall warnings.
 *
 * Background: Squid logs every denied CONNECT attempt, including traffic to
 * Docker-internal addresses (e.g. the MCP Gateway sidecar `awmg-mcpg`) that
 * are unreachable from the public internet. These are not missing external
 * dependencies — they are container-to-container connections that were blocked
 * because the agent bypassed NO_PROXY or because a non-topology-mode run did
 * not add them to the Squid ACL. Surfacing them as "blocked external domains"
 * in warnings and summaries is spurious noise on every run.
 */

import { NETWORK_SUBNET } from '../config/network-policy';

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Parses an IPv4 CIDR string into a numeric network/mask pair. */
function parseCidr(cidr: string): { net: number; mask: number } {
  const [addr, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const parts = addr.split('.').map(Number);
  const net = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return { net: net & mask, mask };
}

/** IPv4 numeric value of a dotted-decimal IP string. */
function ipv4ToNum(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const AWF_NETWORK = parseCidr(NETWORK_SUBNET);

/**
 * Returns `true` if `domain` is an AWF-internal destination that should be
 * excluded from user-facing blocked-domain warnings and statistics.
 *
 * Three categories are filtered:
 *
 * 1. **IPv4 addresses on the AWF Docker network** (`172.30.0.0/24`): IPs in
 *    this subnet belong to AWF sidecars (Squid, api-proxy, cli-proxy, etc.) or
 *    to externally-attached peers (e.g. the MCP Gateway). A Squid denial for a
 *    `172.30.0.x` IP is never a missing external dependency.
 *
 * 2. **Configured topology peers** (`knownTopologyPeers`): when the caller has
 *    access to the policy manifest, it passes the resolved `topologyPeers` list.
 *    Peer names are matched exactly (case-insensitive). This handles peers with
 *    dots (e.g. `mcp.gateway-01`) that the single-label heuristic below misses.
 *
 * 3. **Single-label hostnames** (no dots): Docker assigns container-scoped DNS
 *    names that contain no dots (e.g. `awmgmcpg`, `awmg-mcpg`). Every valid
 *    public internet hostname has at least one dot. A denial for a dot-free name
 *    is always Docker container-to-container traffic, not an external dependency.
 *
 * @param domain - Hostname or IP from a Squid log entry.
 * @param knownTopologyPeers - Optional set of topology-peer hostnames from the
 *   policy manifest (populated when the manifest is available). Allows filtering
 *   multi-label peer names such as `mcp.gateway-01`.
 */
export function isInternalAwfDomain(
  domain: string,
  knownTopologyPeers?: ReadonlySet<string>
): boolean {
  // Category 1: IPv4 address on the AWF Docker network
  if (IPV4_RE.test(domain)) {
    const parts = domain.split('.').map(Number);
    if (parts.every(p => p >= 0 && p <= 255)) {
      const ip = ipv4ToNum(domain);
      if ((ip & AWF_NETWORK.mask) === AWF_NETWORK.net) {
        return true;
      }
    }
  }

  // Category 2: Explicitly configured topology peer hostname.
  // Topology peers can have dots (e.g. mcp.gateway-01), so the single-label
  // heuristic below is not sufficient for them. When the caller has resolved
  // the peer list from the policy manifest, check against it directly.
  if (knownTopologyPeers && knownTopologyPeers.size > 0) {
    if (knownTopologyPeers.has(domain.toLowerCase())) {
      return true;
    }
  }

  // Category 3: Single-label hostname — no dots means a Docker container name,
  // never a valid public internet domain.
  // Exclusions:
  //   '-'  — Squid's placeholder for an unknown/missing host; not a hostname.
  //   IPv6 — bracketed ("[::1]") or bare ("::1") addresses contain colons or
  //           brackets and have no dots, but are not Docker container names.
  if (
    domain.length > 0 &&
    domain !== '-' &&
    !domain.includes('.') &&
    !domain.includes(':') &&
    !domain.startsWith('[')
  ) {
    return true;
  }

  return false;
}
