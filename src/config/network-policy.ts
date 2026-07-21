import rawPolicy from './sandbox-network-policy.json';

/**
 * Central, declarative NETWORK policy shared by every runtime.
 *
 * The data lives in {@link ./sandbox-network-policy.json} so the network
 * topology (network name, subnet, static sidecar IPs), proxy ports, DNS
 * configuration, and the legacy iptables deny lists have a single source of
 * truth and cannot drift between the CLI, the compose generators, the Squid
 * config, the host-iptables backend, and the container NAT script.
 *
 * The PRIMARY, default path is network-isolation (topology) mode, where the
 * agent runs on an `internal` Docker network whose only egress is the
 * dual-homed Squid proxy — no iptables, host or container. The values consumed
 * by that path live under {@link NetworkPolicy.topology}, {@link
 * NetworkPolicy.proxies}, and {@link NetworkPolicy.dns}. The {@link
 * NetworkPolicy.legacyIptables} section is consumed only by the uncommon
 * `--legacy-security` / `--enable-host-access` path.
 *
 * Every value here is a logical Docker network address (subnet, static IP,
 * port, network name) resolved by the daemon — none carries a host-filesystem
 * assumption, so the policy is ARC/DinD safe and needs no
 * `--docker-host-path-prefix` translation.
 *
 * The JSON is imported statically (via `resolveJsonModule`) so it is emitted to
 * `dist/` by `tsc` and inlined by the esbuild release bundle — no runtime file
 * read or extra packaging step is required.
 */

/** Role of a static host on the internal topology network (documentation only). */
export type NetworkHostRole =
  | 'egress-proxy'
  | 'workload'
  | 'credential-proxy'
  | 'dns-proxy'
  | 'difc-proxy';

/** A single static host assigned a fixed IP on the internal topology network. */
export interface NetworkHost {
  /** Fixed IPv4 address on the internal `awf-net` network. */
  readonly ip: string;
  /** Human-readable role of the host (documentation only). */
  readonly role: NetworkHostRole;
  /** Whether this host is always present (Squid, agent) or optional (sidecars). */
  readonly required: boolean;
  /** Whether the host is dual-homed onto the external bridge (Squid only). */
  readonly dualHomed?: boolean;
}

/** A blocked TCP port in the legacy iptables deny list. */
export interface BlockedPort {
  readonly port: number;
  readonly reason: string;
}

/** A blocked destination CIDR in the legacy iptables deny list. */
export interface BlockedCidr {
  readonly cidr: string;
  readonly reason: string;
}

/** The fully-typed, validated network policy. */
export interface NetworkPolicy {
  readonly topology: {
    readonly networkName: string;
    readonly externalBridgeName: string;
    readonly subnet: string;
    readonly hosts: {
      readonly squid: NetworkHost;
      readonly agent: NetworkHost;
      readonly apiProxy: NetworkHost;
      readonly dohProxy: NetworkHost;
      readonly cliProxy: NetworkHost;
    };
  };
  readonly proxies: {
    readonly squid: { readonly port: number };
    readonly apiProxy: {
      readonly ports: {
        readonly openai: number;
        readonly anthropic: number;
        readonly copilot: number;
        readonly gemini: number;
        readonly vertex: number;
      };
      readonly healthPort: number;
    };
    readonly cliProxy: { readonly port: number };
    readonly dohProxy: { readonly upstreamPort: number };
  };
  readonly dns: {
    readonly embeddedResolver: string;
    readonly defaultUpstreamServers: readonly string[];
    readonly port: number;
  };
  readonly legacyIptables: {
    readonly hostGateway: string;
    readonly blockedPorts: readonly BlockedPort[];
    readonly blockedCidrs: readonly BlockedCidr[];
  };
}

function fail(message: string): never {
  throw new Error(`Invalid sandbox-network-policy.json: ${message}`);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

/** Validates a TCP/UDP port: an integer in the range 1–65535. */
function assertPort(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`${label} must be an integer port in 1-65535`);
  }
  return value;
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const CIDR_RE = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:\d|[12]\d|3[0-2])$/;

function assertIpv4(value: unknown, label: string): string {
  const s = assertString(value, label);
  if (!IPV4_RE.test(s) || s.split('.').some((o) => Number(o) > 255)) {
    fail(`${label} must be a valid IPv4 address: ${s}`);
  }
  return s;
}

function assertCidr(value: unknown, label: string): string {
  const s = assertString(value, label);
  const [addr] = s.split('/');
  if (!CIDR_RE.test(s) || addr.split('.').some((o) => Number(o) > 255)) {
    fail(`${label} must be a valid IPv4 CIDR: ${s}`);
  }
  return s;
}

const VALID_ROLES: ReadonlySet<string> = new Set<NetworkHostRole>([
  'egress-proxy',
  'workload',
  'credential-proxy',
  'dns-proxy',
  'difc-proxy',
]);

function parseHost(value: unknown, label: string): NetworkHost {
  const h = asObject(value, label);
  const ip = assertIpv4(h.ip, `${label}.ip`);
  const role = assertString(h.role, `${label}.role`);
  if (!VALID_ROLES.has(role)) {
    fail(`${label}.role is not a recognized role: ${role}`);
  }
  if (typeof h.required !== 'boolean') {
    fail(`${label}.required must be a boolean`);
  }
  if (h.dualHomed !== undefined && typeof h.dualHomed !== 'boolean') {
    fail(`${label}.dualHomed must be a boolean when present`);
  }
  return {
    ip,
    role: role as NetworkHostRole,
    required: h.required,
    ...(h.dualHomed !== undefined && { dualHomed: h.dualHomed }),
  };
}

function parseHosts(value: unknown): NetworkPolicy['topology']['hosts'] {
  const h = asObject(value, 'topology.hosts');
  const hosts = {
    squid: parseHost(h.squid, 'topology.hosts.squid'),
    agent: parseHost(h.agent, 'topology.hosts.agent'),
    apiProxy: parseHost(h.apiProxy, 'topology.hosts.apiProxy'),
    dohProxy: parseHost(h.dohProxy, 'topology.hosts.dohProxy'),
    cliProxy: parseHost(h.cliProxy, 'topology.hosts.cliProxy'),
  };

  const seen = new Set<string>();
  for (const [name, host] of Object.entries(hosts)) {
    if (seen.has(host.ip)) {
      fail(`topology.hosts.${name}.ip is a duplicate address: ${host.ip}`);
    }
    seen.add(host.ip);
  }
  return hosts;
}

function parseTopology(value: unknown): NetworkPolicy['topology'] {
  const t = asObject(value, 'topology');
  return {
    networkName: assertString(t.networkName, 'topology.networkName'),
    externalBridgeName: assertString(t.externalBridgeName, 'topology.externalBridgeName'),
    subnet: assertCidr(t.subnet, 'topology.subnet'),
    hosts: parseHosts(t.hosts),
  };
}

function parseProxies(value: unknown): NetworkPolicy['proxies'] {
  const p = asObject(value, 'proxies');
  const squid = asObject(p.squid, 'proxies.squid');
  const apiProxy = asObject(p.apiProxy, 'proxies.apiProxy');
  const apiPorts = asObject(apiProxy.ports, 'proxies.apiProxy.ports');
  const cliProxy = asObject(p.cliProxy, 'proxies.cliProxy');
  const dohProxy = asObject(p.dohProxy, 'proxies.dohProxy');
  return {
    squid: { port: assertPort(squid.port, 'proxies.squid.port') },
    apiProxy: {
      ports: {
        openai: assertPort(apiPorts.openai, 'proxies.apiProxy.ports.openai'),
        anthropic: assertPort(apiPorts.anthropic, 'proxies.apiProxy.ports.anthropic'),
        copilot: assertPort(apiPorts.copilot, 'proxies.apiProxy.ports.copilot'),
        gemini: assertPort(apiPorts.gemini, 'proxies.apiProxy.ports.gemini'),
        vertex: assertPort(apiPorts.vertex, 'proxies.apiProxy.ports.vertex'),
      },
      healthPort: assertPort(apiProxy.healthPort, 'proxies.apiProxy.healthPort'),
    },
    cliProxy: { port: assertPort(cliProxy.port, 'proxies.cliProxy.port') },
    dohProxy: { upstreamPort: assertPort(dohProxy.upstreamPort, 'proxies.dohProxy.upstreamPort') },
  };
}

function parseDns(value: unknown): NetworkPolicy['dns'] {
  const d = asObject(value, 'dns');
  const servers = d.defaultUpstreamServers;
  if (!Array.isArray(servers) || servers.length === 0) {
    fail('dns.defaultUpstreamServers must be a non-empty array');
  }
  const upstream = servers.map((s, i) => assertIpv4(s, `dns.defaultUpstreamServers[${i}]`));
  return {
    embeddedResolver: assertIpv4(d.embeddedResolver, 'dns.embeddedResolver'),
    defaultUpstreamServers: upstream,
    port: assertPort(d.port, 'dns.port'),
  };
}

function parseLegacyIptables(value: unknown): NetworkPolicy['legacyIptables'] {
  const l = asObject(value, 'legacyIptables');

  const rawPorts = l.blockedPorts;
  if (!Array.isArray(rawPorts) || rawPorts.length === 0) {
    fail('legacyIptables.blockedPorts must be a non-empty array');
  }
  const seenPorts = new Set<number>();
  const blockedPorts = rawPorts.map((entry, i) => {
    const e = asObject(entry, `legacyIptables.blockedPorts[${i}]`);
    const port = assertPort(e.port, `legacyIptables.blockedPorts[${i}].port`);
    if (seenPorts.has(port)) {
      fail(`legacyIptables.blockedPorts has duplicate port: ${port}`);
    }
    seenPorts.add(port);
    return { port, reason: assertString(e.reason, `legacyIptables.blockedPorts[${i}].reason`) };
  });

  const rawCidrs = l.blockedCidrs;
  if (!Array.isArray(rawCidrs) || rawCidrs.length === 0) {
    fail('legacyIptables.blockedCidrs must be a non-empty array');
  }
  const seenCidrs = new Set<string>();
  const blockedCidrs = rawCidrs.map((entry, i) => {
    const e = asObject(entry, `legacyIptables.blockedCidrs[${i}]`);
    const cidr = assertCidr(e.cidr, `legacyIptables.blockedCidrs[${i}].cidr`);
    if (seenCidrs.has(cidr)) {
      fail(`legacyIptables.blockedCidrs has duplicate cidr: ${cidr}`);
    }
    seenCidrs.add(cidr);
    return { cidr, reason: assertString(e.reason, `legacyIptables.blockedCidrs[${i}].reason`) };
  });

  return {
    hostGateway: assertIpv4(l.hostGateway, 'legacyIptables.hostGateway'),
    blockedPorts,
    blockedCidrs,
  };
}

function validate(input: unknown): NetworkPolicy {
  const p = asObject(input, 'root');
  return {
    topology: parseTopology(p.topology),
    proxies: parseProxies(p.proxies),
    dns: parseDns(p.dns),
    legacyIptables: parseLegacyIptables(p.legacyIptables),
  };
}

/**
 * Recursively freezes an object tree so the exported policy is immutable at
 * runtime, not just in the type system (`readonly` is erased by `tsc`). This
 * guarantees live accessors like {@link apiProxyPorts} can never diverge from
 * constants captured during module initialization.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** The validated, deeply-frozen network policy loaded from the JSON config. */
export const networkPolicy: NetworkPolicy = deepFreeze(validate(rawPolicy));

// ---------------------------------------------------------------------------
// CORE accessors — consumed by the default network-isolation (topology) path.
// ---------------------------------------------------------------------------

/** Name of the internal Docker network the agent and sidecars share. */
export const NETWORK_NAME: string = networkPolicy.topology.networkName;

/** Name of the external bridge network Squid is dual-homed onto (sole egress). */
export const EXTERNAL_BRIDGE_NAME: string = networkPolicy.topology.externalBridgeName;

/** IPv4 subnet (CIDR) of the internal topology network, shared by all runtimes. */
export const NETWORK_SUBNET: string = networkPolicy.topology.subnet;

/** Fixed IP of the Squid egress proxy on the internal network. */
export const SQUID_IP: string = networkPolicy.topology.hosts.squid.ip;

/** Fixed IP of the agent workload container on the internal network. */
export const AGENT_IP: string = networkPolicy.topology.hosts.agent.ip;

/** Fixed IP of the optional credential-injecting API proxy sidecar. */
export const API_PROXY_IP: string = networkPolicy.topology.hosts.apiProxy.ip;

/** Fixed IP of the optional DNS-over-HTTPS proxy sidecar. */
export const DOH_PROXY_IP: string = networkPolicy.topology.hosts.dohProxy.ip;

/** Fixed IP of the optional DIFC/CLI proxy sidecar. */
export const CLI_PROXY_IP: string = networkPolicy.topology.hosts.cliProxy.ip;

/** Port the Squid forward proxy listens on. */
export const SQUID_PORT: number = networkPolicy.proxies.squid.port;

/** Port the CLI proxy sidecar listens on. */
export const CLI_PROXY_PORT: number = networkPolicy.proxies.cliProxy.port;

/** Upstream port the DoH proxy dials (HTTPS). */
// ts-prune-ignore-next -- part of the policy surface; wired in the step-2 legacy consolidation.
export const DOH_UPSTREAM_PORT: number = networkPolicy.proxies.dohProxy.upstreamPort;

/** Docker embedded DNS resolver address used by the agent in topology mode. */
export const EMBEDDED_DNS_RESOLVER: string = networkPolicy.dns.embeddedResolver;

/**
 * Fallback upstream DNS servers when no `--dns-servers` are provided.
 * Returned as a fresh mutable array to match the historical `string[]` type
 * that callers pass into APIs expecting a mutable list.
 */
export const DEFAULT_DNS_SERVERS: string[] = [...networkPolicy.dns.defaultUpstreamServers];

/** The sole permitted DNS port. */
// ts-prune-ignore-next -- part of the policy surface; wired in the step-2 legacy consolidation.
export const DNS_PORT: number = networkPolicy.dns.port;

/** Per-provider API proxy listen ports. */
export function apiProxyPorts(): NetworkPolicy['proxies']['apiProxy']['ports'] {
  return networkPolicy.proxies.apiProxy.ports;
}

/** Health-check port for the API proxy sidecar. */
export const API_PROXY_HEALTH_PORT: number = networkPolicy.proxies.apiProxy.healthPort;

// ---------------------------------------------------------------------------
// LEGACY accessors — consumed only by the uncommon host/container iptables path.
// ---------------------------------------------------------------------------

/** Gateway IP of the internal network (host-iptables path only). */
// ts-prune-ignore-next -- consumed via host-iptables-shared's AWF_NETWORK_GATEWAY alias.
export const HOST_GATEWAY: string = networkPolicy.legacyIptables.hostGateway;

/** Blocked TCP port numbers enforced by the iptables backends. */
// ts-prune-ignore-next -- part of the policy surface; wired in the step-2 legacy consolidation.
export function blockedPortNumbers(): number[] {
  return networkPolicy.legacyIptables.blockedPorts.map((p) => p.port);
}

/** Blocked destination CIDRs enforced by the iptables backends. */
// ts-prune-ignore-next -- part of the policy surface; wired in the step-2 legacy consolidation.
export function blockedCidrs(): string[] {
  return networkPolicy.legacyIptables.blockedCidrs.map((c) => c.cidr);
}
