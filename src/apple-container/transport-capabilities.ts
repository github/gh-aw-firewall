/**
 * The AWF capability transport contract for no-NIC Apple Container guests.
 *
 * An Apple Container agent VM is launched with `--network none`, so it has
 * **zero network interfaces** other than loopback. Direct IP egress, DNS, DoH,
 * IPv6, raw sockets, the cloud metadata address, and every host network path
 * are unreachable by construction rather than by rule. Apple Container has no
 * daemon-side forced-proxy setting, so an advisory `HTTP_PROXY` alone would not
 * confine anything; the confinement here comes from the missing NIC.
 *
 * The guest still needs to reach a small, fixed set of AWF services that keep
 * running under Docker Compose (Squid, the API proxy, the CLI proxy, the
 * enclave MCP gateway). The only capability transport Apple Container offers a
 * NIC-less VM is `--publish-socket host_path:container_path`, which exposes one
 * host Unix socket at one guest path. This module is the single source of truth
 * for *which* sockets may be published and what they map to:
 *
 * ```
 *  host TCP service   <-- AWF host relay --  Unix socket  --publish-socket-->
 *  guest Unix socket  <-- AWF guest relay --  127.0.0.1:<fixed port>  --> workload
 * ```
 *
 * Three properties make this an allowlist rather than a tunnel:
 *
 * 1. **Closed set.** {@link APPLE_CONTAINER_TRANSPORT_CAPABILITIES} is the
 *    complete list. There is no "custom capability" escape hatch, no generic
 *    host-network capability, and no Docker socket capability. A caller can
 *    only select a subset of these entries; it cannot invent one.
 * 2. **Fixed guest shape.** Both the guest socket path and the guest loopback
 *    port are compiled into the contract on both sides, so the host and the
 *    guest agree without any dynamic configuration channel crossing the VM
 *    boundary at boot.
 * 3. **Constrained upstreams.** Each capability is bound to a host TCP endpoint
 *    that must be an IP literal on loopback or a private range. Hostnames are
 *    rejected outright, so the relay never performs a DNS lookup and cannot be
 *    steered at a public or link-local address (including 169.254.169.254).
 *
 * Credentials never appear here. The API proxy capabilities carry *no* auth
 * material: the guest speaks to an unauthenticated relay, and the real key is
 * injected by the host-side API proxy sidecar, exactly as in the Docker
 * topology.
 */

import { apiProxyPorts, CLI_PROXY_PORT, SQUID_PORT } from '../config/network-policy';
import { ENCLAVE_MCP_CONTROL_PORT } from '../enclave/network';
import { compareAppleContainerVersions } from './preflight';

/**
 * Version of the host/guest transport contract.
 *
 * Bumped whenever the guest directory layout, the socket naming scheme, or the
 * capability-to-port mapping changes. The version is embedded in the guest
 * directory path so a host and a guest init image that disagree cannot silently
 * half-work: the guest simply finds no sockets where it expects them.
 */
export const APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION = 1;

/**
 * Directory inside the guest that holds every published capability socket.
 *
 * `/run` is a tmpfs in the guest, so this stays writable for vminitd even when
 * the workload rootfs is mounted read-only.
 */
export const APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY =
  `/run/awf/transport/v${APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION}`;

/**
 * Apple Container / containerization releases this contract is pinned against.
 *
 * `--publish-socket` and `--init-image` are the two load-bearing features and
 * both are only guaranteed from this release line onward. The upper bound is
 * exclusive and deliberately conservative: a major version bump may change the
 * init image layout (where the real `vminitd` lives), which would silently
 * break the guest handoff rather than fail loudly.
 */
export const APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION = '0.4.0';
export const APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE = '1.0.0';

/**
 * Where Apple's containerization runtime executes the init binary from inside
 * the init image. The AWF init image installs the guest relay shim here.
 */
export const APPLE_CONTAINER_INIT_ENTRYPOINT = '/sbin/vminitd';

/**
 * Apple's unmodified `vminitd`, relocated at init-image build time.
 *
 * The shim execs this once the relay is confirmed listening, so Apple's own
 * init keeps PID 1 and its reaping, signal, and lifecycle semantics are exactly
 * what Apple shipped.
 */
export const APPLE_CONTAINER_VMINITD_PATH = '/sbin/vminitd.apple';

/**
 * Fails closed when the installed `container` CLI is outside the version range
 * this init-image contract was validated against.
 *
 * The guest relay execs Apple's real `vminitd` from a path inside the init
 * image. A release outside this window may move that binary or change how the
 * init image is consumed, which would turn into a mysterious boot failure — or,
 * worse, a container that starts without the relay and therefore without any
 * capability at all. Refusing up front is the only safe answer.
 */
export function assertAppleContainerTransportCliVersion(version: string): string {
  if (compareAppleContainerVersions(version, APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION) < 0) {
    throw new Error(
      `Apple Container transport contract v${APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION} ` +
      `requires container CLI ${APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION} or newer; ` +
      `found ${version}`,
    );
  }
  if (
    compareAppleContainerVersions(version, APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE) >= 0
  ) {
    throw new Error(
      `Apple Container transport contract v${APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION} has ` +
      `not been validated against container CLI ${version}; the supported range is ` +
      `>=${APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION} ` +
      `<${APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE}`,
    );
  }
  return version;
}

/** Every capability AWF is willing to bridge into a NIC-less guest. */
export type AppleContainerCapabilityId =
  | 'squid'
  | 'api-proxy-openai'
  | 'api-proxy-anthropic'
  | 'api-proxy-copilot'
  | 'api-proxy-gemini'
  | 'cli-proxy'
  | 'mcp-gateway';

export interface AppleContainerCapabilityDefinition {
  readonly id: AppleContainerCapabilityId;
  /** Basename of the published socket, within the versioned guest directory. */
  readonly socketName: string;
  /** Loopback TCP port the guest relay serves for this capability. */
  readonly guestPort: number;
  /**
   * Environment variable through which the workload learns the guest endpoint.
   * Provider-specific aliasing (for example `ANTHROPIC_BASE_URL`) is deliberately
   * left to the layer that owns agent environment policy.
   */
  readonly endpointEnvName: string;
  readonly description: string;
}

function define(
  id: AppleContainerCapabilityId,
  guestPort: number,
  description: string,
): AppleContainerCapabilityDefinition {
  return {
    id,
    socketName: `${id}.sock`,
    guestPort,
    endpointEnvName: `AWF_APPLE_TRANSPORT_${id.toUpperCase().replace(/-/g, '_')}_URL`,
    description,
  };
}

/**
 * The complete capability allowlist.
 *
 * Guest ports intentionally mirror the Docker-topology ports so the agent
 * environment differs only in host (127.0.0.1 instead of a sidecar IP). The API
 * proxy set is the four discrete provider ports AWF publishes today (10000
 * OpenAI, 10001 Anthropic, 10002 Copilot, 10003 Gemini); no port range is ever
 * bridged, only these exact endpoints.
 */
export const APPLE_CONTAINER_TRANSPORT_CAPABILITIES: readonly AppleContainerCapabilityDefinition[] =
  Object.freeze([
    define('squid', SQUID_PORT, 'Squid forward proxy (sole HTTP/HTTPS egress path)'),
    define('api-proxy-openai', apiProxyPorts().openai, 'API proxy: OpenAI provider'),
    define('api-proxy-anthropic', apiProxyPorts().anthropic, 'API proxy: Anthropic provider'),
    define('api-proxy-copilot', apiProxyPorts().copilot, 'API proxy: Copilot provider'),
    define('api-proxy-gemini', apiProxyPorts().gemini, 'API proxy: Gemini provider'),
    define('cli-proxy', CLI_PROXY_PORT, 'CLI proxy (DIFC-mediated safe outputs)'),
    define('mcp-gateway', ENCLAVE_MCP_CONTROL_PORT, 'Enclave MCP gateway streamable HTTP endpoint'),
  ].map((capability) => Object.freeze(capability)));

const CAPABILITIES_BY_ID = new Map<string, AppleContainerCapabilityDefinition>(
  APPLE_CONTAINER_TRANSPORT_CAPABILITIES.map((capability) => [capability.id, capability]),
);

/**
 * Resolves a capability by id.
 *
 * @throws when the id is not in the allowlist. There is no permissive fallback:
 * an unknown capability must never resolve to a usable socket.
 */
export function getAppleContainerCapability(id: string): AppleContainerCapabilityDefinition {
  const capability = CAPABILITIES_BY_ID.get(id);
  if (!capability) {
    throw new Error(
      `Apple Container transport capability "${id}" is not in the allowlist ` +
      `(${APPLE_CONTAINER_TRANSPORT_CAPABILITIES.map((entry) => entry.id).join(', ')})`,
    );
  }
  return capability;
}

/** Type guard form of {@link getAppleContainerCapability}. */
export function isAppleContainerCapabilityId(value: string): value is AppleContainerCapabilityId {
  return CAPABILITIES_BY_ID.has(value);
}

/** Absolute guest path a capability's socket is published at. */
export function appleContainerGuestSocketPath(id: AppleContainerCapabilityId): string {
  return `${APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY}/${getAppleContainerCapability(id).socketName}`;
}

/** URL the workload uses to reach a capability from inside the guest. */
export function appleContainerGuestEndpointUrl(id: AppleContainerCapabilityId): string {
  return `http://127.0.0.1:${getAppleContainerCapability(id).guestPort}`;
}

/** A host TCP service a capability relays to. */
export interface AppleContainerUpstreamEndpoint {
  readonly host: string;
  readonly port: number;
}

const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(host: string): readonly number[] | undefined {
  const match = IPV4_LITERAL.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1, 5).map(Number);
  // Reject `010.0.0.1`-style octal-looking octets and out-of-range values; both
  // are parsed inconsistently across resolvers and are a classic SSRF vector.
  for (let index = 0; index < 4; index += 1) {
    const text = match[index + 1];
    if (text.length > 1 && text.startsWith('0')) return undefined;
    if (octets[index] > 255) return undefined;
  }
  return octets;
}

/** IPv6 loopback and unique-local addresses, the only IPv6 forms accepted. */
function isAllowedIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === '::1') return true;
  // fc00::/7 (unique local). Everything else — including fe80::/10 link-local
  // and any global unicast address — is rejected.
  return /^f[cd][0-9a-f]{2}:/.test(normalized);
}

/**
 * Validates a relay upstream.
 *
 * Only IP literals are accepted, so the relay performs no name resolution and
 * an attacker-controlled DNS answer cannot repoint a capability. The address
 * must be loopback or private; link-local (and therefore the 169.254.169.254
 * metadata address), multicast, and public addresses are refused.
 */
export function assertAppleContainerUpstreamEndpoint(
  endpoint: AppleContainerUpstreamEndpoint,
  label: string,
): AppleContainerUpstreamEndpoint {
  const { host, port } = endpoint;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Apple Container transport ${label} port must be in 1..65535; got ${port}`);
  }
  if (typeof host !== 'string' || host.length === 0 || host.length > 45) {
    throw new Error(`Apple Container transport ${label} host must be an IP literal`);
  }

  const octets = ipv4Octets(host);
  if (octets) {
    const [a, b] = octets;
    const loopback = a === 127;
    const privateRange = a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
    if (!loopback && !privateRange) {
      throw new Error(
        `Apple Container transport ${label} upstream ${host} is not a loopback or private ` +
        'address; only AWF-owned host services may be bridged into a NIC-less guest',
      );
    }
    return { host, port };
  }

  if (host.includes(':')) {
    if (!isAllowedIpv6(host)) {
      throw new Error(
        `Apple Container transport ${label} upstream ${host} is not an IPv6 loopback or ` +
        'unique-local address',
      );
    }
    return { host, port };
  }

  throw new Error(
    `Apple Container transport ${label} upstream host must be an IP literal, not a name: ${host}`,
  );
}
