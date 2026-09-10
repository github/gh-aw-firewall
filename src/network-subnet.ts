import * as fs from 'fs';
import {
  AGENT_IP,
  API_PROXY_IP,
  CLI_PROXY_IP,
  DOH_PROXY_IP,
  HOST_GATEWAY,
  NETWORK_SUBNET,
  SQUID_IP,
} from './config/network-policy';

/**
 * Resolution and collision detection for the `awf-net` subnet.
 *
 * The default subnet (`172.30.0.0/24`, from sandbox-network-policy.json) is not
 * universally free: on OpenShift/ARO it is inside the default service CIDR
 * (`172.30.0.0/16`) and the CoreDNS ClusterIP is exactly `172.30.0.10` — the
 * address AWF assigns to Squid. Squid then sends its DNS queries to itself and
 * every CONNECT fails with `503 HIER_NONE`.
 *
 * This module lets operators relocate the network with `--network-subnet`
 * (config key `network.subnet`) and turns an otherwise silent DNS breakage into
 * a loud, actionable startup error.
 */

/** Fixed addresses AWF assigns on the `awf-net` network. */
export interface NetworkAddressing {
  /** IPv4 CIDR of the `awf-net` network. */
  subnet: string;
  /** Gateway address of the network (legacy host-iptables path). */
  gatewayIp: string;
  squidIp: string;
  agentIp: string;
  proxyIp: string;
  dohProxyIp: string;
  cliProxyIp: string;
}

/**
 * Narrowest override accepted. AWF assigns host offsets up to `.50`, so the
 * block must contain at least 64 addresses.
 */
const MAX_PREFIX_LENGTH = 26;
/** Widest override accepted — wider blocks needlessly claim host address space. */
const MIN_PREFIX_LENGTH = 16;

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

interface ParsedCidr {
  networkAddress: number;
  prefixLength: number;
}

/**
 * Parses an IPv4 CIDR without validating its prefix range.
 * Returns `undefined` when the value is not a syntactically valid CIDR.
 */
function parseCidr(cidr: string): ParsedCidr | undefined {
  const match = CIDR_RE.exec(cidr.trim());
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  const prefixLength = Number(match[5]);
  if (prefixLength > 32) return undefined;
  const address = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return { networkAddress: (address & mask) >>> 0, prefixLength };
}

/** Returns true when `ip` (dotted-quad) falls inside `cidr`. */
function isIpInCidr(ip: string, cidr: ParsedCidr): boolean {
  const value = ipToInt(ip);
  const mask = cidr.prefixLength === 0 ? 0 : (0xffffffff << (32 - cidr.prefixLength)) >>> 0;
  return ((value & mask) >>> 0) === cidr.networkAddress;
}

/** Returns true when the two CIDR blocks overlap in either direction. */
function cidrsOverlap(a: ParsedCidr, b: ParsedCidr): boolean {
  const shortest = Math.min(a.prefixLength, b.prefixLength);
  const mask = shortest === 0 ? 0 : (0xffffffff << (32 - shortest)) >>> 0;
  return ((a.networkAddress & mask) >>> 0) === ((b.networkAddress & mask) >>> 0);
}

/**
 * Validates a `--network-subnet` value and returns it in canonical
 * network-address form (host bits cleared).
 *
 * @throws Error with an actionable message when the value is unusable.
 */
export function parseNetworkSubnet(value: string): string {
  const parsed = parseCidr(value);
  if (!parsed) {
    throw new Error(
      `Invalid network subnet "${value}": expected an IPv4 CIDR such as 10.88.0.0/24`,
    );
  }
  if (parsed.prefixLength < MIN_PREFIX_LENGTH || parsed.prefixLength > MAX_PREFIX_LENGTH) {
    throw new Error(
      `Invalid network subnet "${value}": prefix length must be between ` +
      `/${MIN_PREFIX_LENGTH} and /${MAX_PREFIX_LENGTH}`,
    );
  }
  return `${intToIp(parsed.networkAddress)}/${parsed.prefixLength}`;
}

/** Host offsets of the fixed AWF addresses relative to the network address. */
function defaultOffsets(): Record<keyof Omit<NetworkAddressing, 'subnet'>, number> {
  const base = parseCidr(NETWORK_SUBNET)!.networkAddress;
  return {
    gatewayIp: ipToInt(HOST_GATEWAY) - base,
    squidIp: ipToInt(SQUID_IP) - base,
    agentIp: ipToInt(AGENT_IP) - base,
    proxyIp: ipToInt(API_PROXY_IP) - base,
    dohProxyIp: ipToInt(DOH_PROXY_IP) - base,
    cliProxyIp: ipToInt(CLI_PROXY_IP) - base,
  };
}

/**
 * Resolves the effective `awf-net` addressing.
 *
 * Without an override this returns the policy defaults verbatim. With an
 * override every fixed address keeps its policy host offset (`.1` gateway,
 * `.10` Squid, `.20` agent, …) inside the relocated block, so all consumers
 * stay consistent.
 */
export function resolveNetworkAddressing(subnetOverride?: string): NetworkAddressing {
  if (!subnetOverride) {
    return {
      subnet: NETWORK_SUBNET,
      gatewayIp: HOST_GATEWAY,
      squidIp: SQUID_IP,
      agentIp: AGENT_IP,
      proxyIp: API_PROXY_IP,
      dohProxyIp: DOH_PROXY_IP,
      cliProxyIp: CLI_PROXY_IP,
    };
  }

  const subnet = parseNetworkSubnet(subnetOverride);
  const base = parseCidr(subnet)!.networkAddress;
  const offsets = defaultOffsets();
  return {
    subnet,
    gatewayIp: intToIp(base + offsets.gatewayIp),
    squidIp: intToIp(base + offsets.squidIp),
    agentIp: intToIp(base + offsets.agentIp),
    proxyIp: intToIp(base + offsets.proxyIp),
    dohProxyIp: intToIp(base + offsets.dohProxyIp),
    cliProxyIp: intToIp(base + offsets.cliProxyIp),
  };
}

/** Paths inspected for host resolvers, mirroring {@link ./dns-resolver}. */
const RESOLV_CONF_PATHS = ['/run/systemd/resolve/resolv.conf', '/etc/resolv.conf'];

/** Kernel IPv4 route table, used to spot subnets already routed on this host. */
const PROC_NET_ROUTE = '/proc/net/route';

/**
 * Interfaces whose routes are ignored by the collision check because they are
 * created by Docker (including AWF's own `awf-net` bridge from a previous or
 * concurrent run), not by the host/pod network.
 */
const DOCKER_MANAGED_INTERFACE_RE = /^(br-|docker|fw-bridge|veth|awf)/;

function readNameserversFromResolvConf(readFile: (p: string) => string): string[] {
  const servers: string[] = [];
  for (const filePath of RESOLV_CONF_PATHS) {
    let content: unknown;
    try {
      content = readFile(filePath);
    } catch {
      continue;
    }
    if (typeof content !== 'string') continue;
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*nameserver\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$/);
      if (match) servers.push(match[1]);
    }
  }
  return servers;
}

/**
 * Parses `/proc/net/route` into `{ iface, cidr }` entries.
 * Addresses and masks are little-endian hex, per the kernel format.
 */
function readHostRoutes(readFile: (p: string) => string): { iface: string; cidr: ParsedCidr }[] {
  let content: unknown;
  try {
    content = readFile(PROC_NET_ROUTE);
  } catch {
    return [];
  }
  if (typeof content !== 'string') return [];
  const routes: { iface: string; cidr: ParsedCidr }[] = [];
  for (const line of content.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const [iface, destinationHex, , , , , , maskHex] = fields;
    const destination = Number.parseInt(destinationHex, 16);
    const mask = Number.parseInt(maskHex, 16);
    if (!Number.isFinite(destination) || !Number.isFinite(mask)) continue;
    // Little-endian → host order.
    const networkAddress = swapEndian(destination);
    const prefixLength = maskToPrefixLength(swapEndian(mask));
    if (prefixLength === undefined || prefixLength === 0) continue; // skip default route
    routes.push({ iface, cidr: { networkAddress, prefixLength } });
  }
  return routes;
}

function swapEndian(value: number): number {
  return (
    (((value & 0xff) << 24) |
      ((value & 0xff00) << 8) |
      ((value >>> 8) & 0xff00) |
      ((value >>> 24) & 0xff)) >>> 0
  );
}

/** Converts a contiguous netmask to a prefix length; `undefined` if invalid. */
function maskToPrefixLength(mask: number): number | undefined {
  let prefixLength = 0;
  let seenZero = false;
  for (let bit = 31; bit >= 0; bit--) {
    if ((mask >>> bit) & 1) {
      if (seenZero) return undefined;
      prefixLength++;
    } else {
      seenZero = true;
    }
  }
  return prefixLength;
}

/** Injection points for {@link assertNetworkSubnetUsable}, used by tests. */
export interface SubnetCollisionSources {
  /** Resolver addresses already known to AWF (e.g. detected `--dns-servers`). */
  dnsServers?: string[];
  /** File reader; defaults to UTF-8 `fs.readFileSync`. */
  readFile?: (filePath: string) => string;
}

/**
 * Fails loudly when the chosen `awf-net` subnet collides with the host/pod
 * network, instead of silently producing a broken Squid resolver path.
 *
 * Two independent signals are checked:
 *
 * 1. **DNS resolvers** — a nameserver inside the subnet (the OpenShift CoreDNS
 *    `172.30.0.10` case) means Squid would resolve names against one of its own
 *    peer addresses.
 * 2. **Routing table** — a non-Docker host route overlapping the subnet means
 *    the block is already in use by the host or cluster network.
 *
 * @throws Error describing the collision and the `--network-subnet` remedy.
 */
export function assertNetworkSubnetUsable(
  subnet: string,
  sources: SubnetCollisionSources = {},
): void {
  const parsed = parseCidr(subnet);
  if (!parsed) return;
  const readFile = sources.readFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf-8'));

  const nameservers = [
    ...(sources.dnsServers ?? []),
    ...readNameserversFromResolvConf(readFile),
    // parseCidr validates the octet range, so IPv6 and malformed entries drop out.
  ].filter((ip) => parseCidr(`${ip}/32`) !== undefined);

  const collidingNameservers = [...new Set(nameservers.filter((ip) => isIpInCidr(ip, parsed)))];
  if (collidingNameservers.length > 0) {
    throw new Error(
      `The awf-net subnet ${subnet} contains the DNS resolver(s) ` +
      `${collidingNameservers.join(', ')}. Squid would send its DNS queries to an address ` +
      'inside its own Docker network, so every request would fail with "503 HIER_NONE". ' +
      'Relocate the network with --network-subnet (config key network.subnet), for example ' +
      '--network-subnet 10.88.0.0/24.',
    );
  }

  const collidingRoutes = readHostRoutes(readFile).filter(
    (route) =>
      !DOCKER_MANAGED_INTERFACE_RE.test(route.iface) && cidrsOverlap(route.cidr, parsed),
  );
  if (collidingRoutes.length > 0) {
    const described = [
      ...new Set(
        collidingRoutes.map(
          (route) => `${intToIp(route.cidr.networkAddress)}/${route.cidr.prefixLength} via ${route.iface}`,
        ),
      ),
    ];
    throw new Error(
      `The awf-net subnet ${subnet} overlaps existing host route(s): ${described.join(', ')}. ` +
      'Relocate the network with --network-subnet (config key network.subnet), for example ' +
      '--network-subnet 10.88.0.0/24.',
    );
  }
}

/** @internal Exported for unit tests only. */
// ts-prune-ignore-next
export const testHelpers = { parseCidr, cidrsOverlap, maskToPrefixLength };
