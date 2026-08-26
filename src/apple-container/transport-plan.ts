/**
 * Turns a set of allowlisted capabilities into the exact launch surface an
 * Apple Container agent needs, and merges it into a layer-1
 * {@link AppleContainerRunSpec} without ever weakening the isolation the run
 * spec already guarantees.
 *
 * The plan is the only place that decides:
 *
 * - which `--publish-socket host:guest` pairs exist (one per capability, no
 *   generic host-network or Docker-socket mount is representable);
 * - which environment variables tell the workload where the guest-side loopback
 *   endpoints are;
 * - which capabilities are dropped from the workload;
 * - which pinned init image supplies the guest relay;
 * - that networking stays `{ kind: 'none' }`.
 *
 * The merge is intentionally hostile to its caller. It refuses a run spec that
 * asks for a network, that adds a forbidden capability, that publishes a
 * conflicting socket, or that sets one of the transport environment variables
 * to a different value. A caller cannot end up with a launch that looks planned
 * but silently differs from the plan.
 *
 * No credential ever appears in this module. API proxy capabilities are
 * unauthenticated from the guest's point of view; the real key is injected by
 * the host-side API proxy sidecar and never enters guest env, argv, files, or
 * logs.
 */

import type {
  AppleContainerRunSpec,
  AppleContainerSocketMount,
} from './run-args';
import type {
  AppleContainerCapabilityDefinition,
  AppleContainerCapabilityId,
  AppleContainerUpstreamEndpoint,
} from './transport-capabilities';
import {
  APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION,
  APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY,
  appleContainerGuestEndpointUrl,
  appleContainerGuestSocketPath,
  assertAppleContainerUpstreamEndpoint,
  getAppleContainerCapability,
} from './transport-capabilities';
import {
  appleContainerHostSocketPath,
  type AppleContainerSocketDirectoryHandle,
} from './transport-socket-dir';
import { assertAppleContainerImageReference } from './validation';

/**
 * Capabilities the workload must never hold.
 *
 * `NET_RAW` and `NET_ADMIN` would let the workload craft link-layer traffic or
 * bring up an interface; `SYS_ADMIN`, `SYS_MODULE`, and `SYS_RAWIO` are generic
 * escape primitives. They are dropped unconditionally, and adding any of them —
 * or the `ALL` wildcard — is refused rather than silently overridden.
 */
export const APPLE_CONTAINER_REQUIRED_CAP_DROPS: readonly string[] = Object.freeze([
  'NET_ADMIN',
  'NET_RAW',
  'SYS_ADMIN',
  'SYS_MODULE',
  'SYS_RAWIO',
]);

const FORBIDDEN_CAP_ADDS = new Set([
  'ALL',
  'NET_ADMIN',
  'NET_RAW',
  'SYS_ADMIN',
  'SYS_MODULE',
  'SYS_RAWIO',
]);

/** Squid is the guest's only egress path, so a plan without it is not viable. */
const REQUIRED_CAPABILITY: AppleContainerCapabilityId = 'squid';

/** Destinations the workload must reach directly rather than through Squid. */
const GUEST_NO_PROXY = '127.0.0.1,localhost,::1';

export interface AppleContainerTransportEntry {
  readonly capability: AppleContainerCapabilityDefinition;
  readonly hostSocketPath: string;
  readonly guestSocketPath: string;
  readonly guestPort: number;
  readonly upstream: AppleContainerUpstreamEndpoint;
}

export interface AppleContainerTransportCapabilityRequest {
  readonly id: string;
  readonly upstream: AppleContainerUpstreamEndpoint;
}

export interface AppleContainerTransportPlanInput {
  readonly directory: AppleContainerSocketDirectoryHandle;
  readonly capabilities: readonly AppleContainerTransportCapabilityRequest[];
  /** Pinned AWF init image carrying the guest relay and Apple's real vminitd. */
  readonly initImage: string;
  /**
   * Whether the guest rootfs is mounted read-only. Defaults to `true`: the
   * transport itself needs nothing writable, and `/run` stays a tmpfs, so the
   * published sockets are unaffected.
   */
  readonly readOnlyRootfs?: boolean;
}

export interface AppleContainerTransportPlan {
  readonly contractVersion: number;
  readonly guestDirectory: string;
  readonly initImage: string;
  readonly readOnlyRootfs: boolean;
  readonly entries: readonly AppleContainerTransportEntry[];
  readonly socketMounts: readonly AppleContainerSocketMount[];
  readonly env: Readonly<Record<string, string>>;
  readonly capDrop: readonly string[];
}

/**
 * Builds the transport plan.
 *
 * @throws when a capability is unknown or duplicated, when Squid is absent,
 * when an upstream is not an AWF-owned loopback/private endpoint, or when a
 * socket path would not fit in `sun_path`.
 */
export function planAppleContainerTransport(
  input: AppleContainerTransportPlanInput,
): AppleContainerTransportPlan {
  if (input.capabilities.length === 0) {
    throw new Error('Apple Container transport plan requires at least one capability');
  }

  const seen = new Set<string>();
  const entries: AppleContainerTransportEntry[] = [];
  for (const request of input.capabilities) {
    const capability = getAppleContainerCapability(request.id);
    if (seen.has(capability.id)) {
      throw new Error(`Apple Container transport capability "${capability.id}" is duplicated`);
    }
    seen.add(capability.id);
    entries.push({
      capability,
      hostSocketPath: appleContainerHostSocketPath(input.directory, capability.socketName),
      guestSocketPath: appleContainerGuestSocketPath(capability.id),
      guestPort: capability.guestPort,
      upstream: assertAppleContainerUpstreamEndpoint(
        request.upstream,
        `capability ${capability.id}`,
      ),
    });
  }

  if (!seen.has(REQUIRED_CAPABILITY)) {
    throw new Error(
      `Apple Container transport plan must include the "${REQUIRED_CAPABILITY}" capability; ` +
      'a NIC-less guest has no other egress path',
    );
  }

  const squid = entries.find((entry) => entry.capability.id === REQUIRED_CAPABILITY)!;
  const squidUrl = appleContainerGuestEndpointUrl(REQUIRED_CAPABILITY);

  const env: Record<string, string> = {
    AWF_APPLE_TRANSPORT_CONTRACT_VERSION: String(APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION),
    HTTP_PROXY: squidUrl,
    HTTPS_PROXY: squidUrl,
    // Unlike the Docker topology there is no iptables DNAT fallback here: with
    // no NIC, an unproxied HTTP request has nowhere to go, so the lowercase
    // forms are set too rather than relying on interception.
    http_proxy: squidUrl,
    https_proxy: squidUrl,
    NO_PROXY: GUEST_NO_PROXY,
    no_proxy: GUEST_NO_PROXY,
    SQUID_PROXY_HOST: '127.0.0.1',
    SQUID_PROXY_PORT: String(squid.guestPort),
  };
  for (const entry of entries) {
    env[entry.capability.endpointEnvName] = appleContainerGuestEndpointUrl(entry.capability.id);
  }

  return Object.freeze({
    contractVersion: APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION,
    guestDirectory: APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY,
    initImage: assertAppleContainerImageReference(input.initImage),
    readOnlyRootfs: input.readOnlyRootfs ?? true,
    entries: Object.freeze(entries),
    socketMounts: Object.freeze(entries.map((entry) => Object.freeze({
      hostPath: entry.hostSocketPath,
      containerPath: entry.guestSocketPath,
    }))),
    env: Object.freeze(env),
    capDrop: APPLE_CONTAINER_REQUIRED_CAP_DROPS,
  });
}

/**
 * Merges a transport plan into a run spec.
 *
 * Returns a new spec; the input is never mutated.
 *
 * @throws when the spec would weaken isolation (any network other than `none`,
 * a forbidden `capAdd`, a conflicting socket publication, a conflicting init
 * image, or a conflicting transport environment variable).
 */
export function applyAppleContainerTransportToRunSpec(
  spec: AppleContainerRunSpec,
  plan: AppleContainerTransportPlan,
): AppleContainerRunSpec {
  if (spec.network !== undefined && spec.network.kind !== 'none') {
    throw new Error(
      'Apple Container transport requires an isolated guest; a run spec attaching a network ' +
      'cannot be combined with the capability transport',
    );
  }

  for (const capability of spec.capAdd ?? []) {
    if (FORBIDDEN_CAP_ADDS.has(normalizeCapability(capability))) {
      throw new Error(
        `Apple Container transport refuses capAdd "${capability}"; the workload must never ` +
        'hold ALL, NET_ADMIN, NET_RAW, SYS_ADMIN, SYS_MODULE, or SYS_RAWIO',
      );
    }
  }

  if (spec.initImage !== undefined && spec.initImage !== plan.initImage) {
    throw new Error(
      `Apple Container transport requires init image ${plan.initImage}; run spec asked for ` +
      `${spec.initImage}`,
    );
  }

  const env: Record<string, string> = { ...(spec.env ?? {}) };
  for (const [name, value] of Object.entries(plan.env)) {
    const existing = env[name];
    if (existing !== undefined && existing !== value) {
      throw new Error(
        `Apple Container transport environment variable ${name} is already set to a different ` +
        'value; refusing to launch with an endpoint the transport does not serve',
      );
    }
    env[name] = value;
  }

  // The plan is the *sole* source of published sockets. A caller-supplied entry
  // is accepted only when it is byte-identical to a planned one; anything else
  // — a Docker socket, an arbitrary host socket, a rebound capability path — is
  // refused. Merging caller entries through would make the capability allowlist
  // advisory, and publishing `/var/run/docker.sock` into the guest is a direct
  // escape to host root that every other guarantee here would survive.
  for (const mount of spec.socketMounts ?? []) {
    const planned = plan.socketMounts.find(
      (entry) => entry.hostPath === mount.hostPath && entry.containerPath === mount.containerPath,
    );
    if (!planned) {
      throw new Error(
        `Apple Container transport refuses to publish ${mount.hostPath}:${mount.containerPath}; ` +
        'only allowlisted capability sockets may cross the VM boundary',
      );
    }
  }
  const socketMounts: AppleContainerSocketMount[] = [...plan.socketMounts];

  // A bind mount over the transport directory would shadow the published
  // sockets and silently disable every capability.
  for (const mount of spec.mounts ?? []) {
    if (
      mount.target === plan.guestDirectory
      || mount.target.startsWith(`${plan.guestDirectory}/`)
    ) {
      throw new Error(
        `Apple Container transport refuses a bind mount at ${mount.target}, which would shadow ` +
        'the published capability sockets',
      );
    }
  }

  const capDrop = mergeCapDrops(spec.capDrop ?? [], plan.capDrop);

  return {
    ...spec,
    env,
    socketMounts,
    capDrop,
    initImage: plan.initImage,
    readOnlyRootfs: spec.readOnlyRootfs ?? plan.readOnlyRootfs,
    network: { kind: 'none' },
  };
}

function mergeCapDrops(
  existing: readonly string[],
  required: readonly string[],
): readonly string[] {
  const merged = [...existing];
  const present = new Set(existing.map(normalizeCapability));
  for (const capability of required) {
    if (!present.has(capability)) {
      present.add(capability);
      merged.push(capability);
    }
  }
  return merged;
}

function normalizeCapability(value: string): string {
  return value.toUpperCase().replace(/^CAP_/, '');
}
