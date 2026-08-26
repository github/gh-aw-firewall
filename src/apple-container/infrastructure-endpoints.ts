/**
 * Bridges AWF's Docker Compose infrastructure to the Apple Container guest.
 *
 * The agent VM has no NIC, and on macOS the Compose sidecars live inside the
 * Docker Desktop VM, so their `172.30.0.x` addresses are unreachable from the
 * macOS host as well. Two hops are therefore required, and this module owns the
 * first one:
 *
 * ```
 *   sidecar container  --(docker publish 127.0.0.1:P)-->  macOS loopback
 *   macOS loopback     --(layer-2 relay + --publish-socket)-->  guest 127.0.0.1:P
 * ```
 *
 * Three properties matter:
 *
 * 1. **Loopback only.** Every publication is bound to `127.0.0.1` explicitly.
 *    Docker's default (`"3128:3128"`) binds `0.0.0.0`, which would expose an
 *    open forward proxy and unauthenticated credential-injecting endpoints to
 *    the entire network the runner sits on. This module rewrites those, it does
 *    not merely add to them.
 * 2. **Exactly the required ports.** The publication set is derived from the
 *    same configuration that derives the capability set, so a port is published
 *    if and only if an AWF-owned capability relays to it. In particular the
 *    Vertex provider port is never published, because no capability can carry
 *    it. Capabilities are a superset of publications rather than a mirror of
 *    them: a capability may instead front an *externally* started host loopback
 *    listener (the ordinary gh-aw MCP gateway), which AWF relays to but never
 *    publishes, because it is not an AWF Compose service.
 * 3. **Validated before use.** {@link appleContainerLoopbackPortConflicts}
 *    proves the fixed ports are free before Compose is started, so a port that
 *    is already in use fails with an actionable message instead of producing a
 *    relay that silently fronts somebody else's listener.
 */

import * as net from 'net';

import { apiProxyPorts, CLI_PROXY_PORT, SQUID_PORT } from '../config/network-policy';
import type { WrapperConfig } from '../types';
import type { AppleContainerCapabilityId } from './transport-capabilities';
import { assertAppleContainerUpstreamEndpoint } from './transport-capabilities';
import type { AppleContainerTransportCapabilityRequest } from './transport-plan';

/**
 * Address every AWF infrastructure port is published on, and the address every
 * relay dials. A literal, so the relay never resolves a name.
 */
export const APPLE_CONTAINER_LOOPBACK_HOST = '127.0.0.1';

/** Compose service key whose published ports back a capability. */
export type AppleContainerInfrastructureService = 'squid-proxy' | 'api-proxy' | 'cli-proxy';

export interface AppleContainerPortPublication {
  readonly service: AppleContainerInfrastructureService;
  /** Port inside the sidecar container. */
  readonly containerPort: number;
  /** Port on macOS loopback. Fixed to `containerPort` (see module comment). */
  readonly hostPort: number;
  readonly capability: AppleContainerCapabilityId;
}

/**
 * A capability backed by a host listener AWF neither starts nor publishes.
 *
 * gh-aw launches its ordinary MCP gateway (`awmg-mcpg`) with a plain
 * `docker run` outside the AWF Compose project and binds it to macOS loopback
 * itself. AWF therefore has no Compose service to rewrite and no port to
 * publish — it only relays. Such a capability appears in
 * {@link AppleContainerInfrastructurePlan.capabilities} but deliberately never
 * in `publications` or `services`, so
 * {@link applyAppleContainerLoopbackPublishing} never searches for a Compose
 * service that does not exist and {@link appleContainerLoopbackPortConflicts}
 * never reports the externally owned listener as a conflict — its port being
 * occupied is the normal case, not an error.
 */
export interface AppleContainerExternalUpstream {
  readonly capability: AppleContainerCapabilityId;
  readonly hostPort: number;
}

export interface AppleContainerInfrastructurePlan {
  readonly publications: readonly AppleContainerPortPublication[];
  readonly capabilities: readonly AppleContainerTransportCapabilityRequest[];
  /** Compose services that must publish at least one loopback port. */
  readonly services: readonly AppleContainerInfrastructureService[];
  /** Capabilities relayed to externally owned host loopback listeners. */
  readonly externalUpstreams: readonly AppleContainerExternalUpstream[];
}

/** Provider ports the transport allowlist covers, in capability order. */
function apiProxyPublications(): readonly Omit<AppleContainerPortPublication, 'hostPort'>[] {
  const ports = apiProxyPorts();
  return [
    { service: 'api-proxy', containerPort: ports.openai, capability: 'api-proxy-openai' },
    { service: 'api-proxy', containerPort: ports.anthropic, capability: 'api-proxy-anthropic' },
    { service: 'api-proxy', containerPort: ports.copilot, capability: 'api-proxy-copilot' },
    { service: 'api-proxy', containerPort: ports.gemini, capability: 'api-proxy-gemini' },
    // `ports.vertex` (10004) is deliberately absent: there is no Vertex entry in
    // APPLE_CONTAINER_TRANSPORT_CAPABILITIES, so it could not be relayed even if
    // it were published. runtime-validation rejects a Vertex configuration up
    // front rather than letting it reach here and silently lose its endpoint.
  ];
}

/**
 * Derives the infrastructure publication and capability sets from the config.
 *
 * Squid is unconditional: it is the guest's only egress path, and layer 2
 * refuses a plan without it.
 *
 * Capabilities are *not* 1:1 with publications. A publication always implies a
 * capability, but a capability may instead name an externally owned loopback
 * listener (see {@link AppleContainerExternalUpstream}), in which case AWF
 * relays to it without publishing anything and without requiring a Compose
 * service.
 */
export function planAppleContainerInfrastructure(
  config: WrapperConfig,
): AppleContainerInfrastructurePlan {
  const planned: Omit<AppleContainerPortPublication, 'hostPort'>[] = [
    { service: 'squid-proxy', containerPort: SQUID_PORT, capability: 'squid' },
  ];

  if (config.enableApiProxy) {
    planned.push(...apiProxyPublications());
  }
  if (config.difcProxyHost) {
    planned.push({
      service: 'cli-proxy',
      containerPort: CLI_PROXY_PORT,
      capability: 'cli-proxy',
    });
  }

  const publications = planned.map((entry) => Object.freeze({ ...entry, hostPort: entry.containerPort }));
  const services = [...new Set(publications.map((entry) => entry.service))];
  const externalUpstreams = planExternalUpstreams(config);

  const capabilities = [
    ...publications.map((entry) => ({ id: entry.capability, hostPort: entry.hostPort })),
    ...externalUpstreams.map((entry) => ({ id: entry.capability, hostPort: entry.hostPort })),
  ].map((entry) => Object.freeze({
    id: entry.id,
    upstream: Object.freeze({ host: APPLE_CONTAINER_LOOPBACK_HOST, port: entry.hostPort }),
  }));

  return Object.freeze({
    publications: Object.freeze(publications),
    capabilities: Object.freeze(capabilities),
    services: Object.freeze(services),
    externalUpstreams: Object.freeze(externalUpstreams),
  });
}

/**
 * Resolves capabilities that relay to host listeners AWF does not own.
 *
 * Today the only entry is the ordinary MCP gateway gh-aw starts outside the AWF
 * Compose project. Two guards apply beyond the parse-time port check:
 *
 * 1. The port is re-validated through the same allowlist predicate every other
 *    upstream passes, so a value that reached here from a non-CLI path (config
 *    file, programmatic caller) cannot skip validation.
 * 2. Any port AWF reserves for its own infrastructure is refused. Accepting one
 *    could front an AWF sidecar — Squid or a credential-injecting API proxy
 *    port — on the guest's MCP gateway endpoint instead of the gateway the
 *    operator meant. The comparison is against the fixed reserved set rather
 *    than this run's publications, so the guard does not depend on which
 *    sidecars this particular configuration happens to enable.
 */
function planExternalUpstreams(config: WrapperConfig): AppleContainerExternalUpstream[] {
  const port = config.appleContainer?.mcpGatewayUpstreamPort;
  if (port === undefined) return [];

  assertAppleContainerUpstreamEndpoint(
    { host: APPLE_CONTAINER_LOOPBACK_HOST, port },
    'capability mcp-gateway',
  );

  if (reservedAwfLoopbackPorts().has(port)) {
    throw new Error(
      `Apple Container mcpGatewayUpstreamPort ${port} is reserved for AWF infrastructure; the ` +
      'external MCP gateway must listen on its own host loopback port',
    );
  }

  return [Object.freeze({ capability: 'mcp-gateway' as const, hostPort: port })];
}

/**
 * Every loopback port AWF may publish for its own sidecars, regardless of the
 * current configuration.
 *
 * Includes the Vertex provider port even though no capability can carry it: it
 * is still a port an AWF sidecar can bind, so it must not be relayed to either.
 */
function reservedAwfLoopbackPorts(): ReadonlySet<number> {
  return new Set<number>([SQUID_PORT, CLI_PROXY_PORT, ...Object.values(apiProxyPorts())]);
}

/** Compose `ports:` entry that binds the publication to loopback only. */
export function appleContainerPortMapping(publication: AppleContainerPortPublication): string {
  return `${APPLE_CONTAINER_LOOPBACK_HOST}:${publication.hostPort}:${publication.containerPort}`;
}

interface ComposeServiceLike {
  ports?: unknown;
  [key: string]: unknown;
}

/**
 * Replaces each backing service's `ports` with the loopback-only publication
 * set for this run.
 *
 * Replacement rather than merging is the point: `buildSquidService` publishes
 * `3128:3128` on all interfaces for the Docker topology, and leaving that entry
 * in place would keep an open forward proxy listening on every host interface
 * while the loopback entry sat harmlessly beside it.
 *
 * Only AWF-owned Compose services are touched. `plan.services` is derived from
 * `plan.publications` alone, so an externally owned upstream (gh-aw's
 * `awmg-mcpg`) is never looked up here and this function can never demand a
 * Compose service AWF does not generate.
 *
 * @throws when a service the plan needs is missing from the Compose output,
 * which would otherwise surface as an unreachable capability inside the VM.
 */
export function applyAppleContainerLoopbackPublishing(
  services: Record<string, unknown>,
  plan: AppleContainerInfrastructurePlan,
): void {
  for (const service of plan.services) {
    const target = services[service] as ComposeServiceLike | undefined;
    if (!target || typeof target !== 'object') {
      throw new Error(
        `Apple Container infrastructure requires the "${service}" Compose service, which was ` +
        'not generated for this configuration',
      );
    }
    target.ports = plan.publications
      .filter((publication) => publication.service === service)
      .map(appleContainerPortMapping);
  }
}

/** Probes one loopback TCP port for an existing listener. */
async function isPortInUse(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: APPLE_CONTAINER_LOOPBACK_HOST, port });
    let settled = false;
    const finish = (inUse: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(inUse);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    // A completed connect means something is already listening. Any error —
    // ECONNREFUSED being the expected one — means the port is free for Docker
    // to bind. Treating a timeout as "free" is the safe direction here: Docker
    // itself fails loudly if the bind is actually taken.
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export interface AppleContainerPortProbeDependencies {
  isPortInUse(port: number, timeoutMs: number): Promise<boolean>;
}

/**
 * Returns the planned host ports that already have a listener.
 *
 * Called before Compose starts so a collision (a second concurrent AWF run, a
 * stray local Squid) is reported as a named conflict rather than as a Docker
 * bind error buried in Compose output.
 *
 * Only `plan.publications` is probed. An externally owned upstream is expected
 * to already have a listener — that is precisely why AWF relays to it instead
 * of publishing it — so probing it would turn the normal case into an error.
 * Its actual reachability is proven later, by the transport manager's upstream
 * health probe, which refuses to start the agent if the gateway is not up.
 */
export async function appleContainerLoopbackPortConflicts(
  plan: AppleContainerInfrastructurePlan,
  dependencies: AppleContainerPortProbeDependencies = { isPortInUse },
  timeoutMs = 500,
): Promise<readonly AppleContainerPortPublication[]> {
  const conflicts: AppleContainerPortPublication[] = [];
  for (const publication of plan.publications) {
    if (await dependencies.isPortInUse(publication.hostPort, timeoutMs)) {
      conflicts.push(publication);
    }
  }
  return conflicts;
}
