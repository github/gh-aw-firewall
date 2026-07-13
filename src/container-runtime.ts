/**
 * Container runtime resolution and capability detection.
 *
 * Centralises three concerns:
 *
 * 1. **Name translation** – user-facing runtime names (e.g. `"gvisor"`) are
 *    mapped to Docker OCI runtime identifiers (e.g. `"runsc"`).  Unknown names
 *    are passed through unchanged so callers can also use raw Docker names.
 *
 * 2. **Capability flags** – each runtime can declare behavioural quirks that
 *    AWF must compensate for.  Current flags:
 *    - `needsStaticDns` – runtime cannot reach Docker's embedded DNS at
 *      127.0.0.11, so AWF must inject `/etc/hosts` entries for every service.
 *
 * 3. **Execution model** – describes how the agent is launched:
 *    - `compose` – agent is a Docker Compose service alongside Squid/api-proxy
 *      (default; used by runc and gVisor).  The agent container may use a
 *      non-default OCI runtime but is still orchestrated by `docker compose`.
 *    - `microvm` – agent runs in a hypervisor-isolated microVM (e.g. Docker
 *      sbx).  Infrastructure services (Squid, api-proxy) stay in Docker Compose
 *      on the host; only the agent crosses the hypervisor boundary.  The sbx
 *      proxy chains upstream through AWF's host-side Squid for domain filtering,
 *      and through the api-proxy for token logging/model routing/credential
 *      injection.
 *
 * ## Adding a new OCI runtime
 *
 * Add an entry to {@link RUNTIME_REGISTRY} with `executionModel: 'compose'`,
 * the Docker runtime name, and capability flags.  All consumers (agent-service,
 * cli-workflow, topology) pick up the new runtime automatically via the
 * capability query functions.
 *
 * ## Adding a microVM backend (e.g. Docker sbx)
 *
 * Add an entry with `executionModel: 'microvm'`.  Callers use
 * {@link runtimeUsesComposeAgent} to decide whether to include the agent
 * service in docker-compose.yml and whether to use `docker logs/wait` or
 * the microVM CLI for agent lifecycle management.  Infrastructure services
 * (Squid, api-proxy) are generated regardless of execution model.
 */

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * How the agent process is launched and managed.
 *
 * - `compose` – agent is a Docker Compose service (default runc, gVisor, kata, etc.)
 * - `microvm` – agent runs in a hypervisor-isolated microVM (Docker sbx, etc.)
 */
type ExecutionModel = 'compose' | 'microvm';

/** Behavioural capabilities / quirks for a container runtime. */
interface RuntimeCapabilities {
  /** How the agent is launched.  Determines whether the agent appears as a
   *  Docker Compose service or is managed by an external tool. */
  readonly executionModel: ExecutionModel;

  /**
   * Docker OCI runtime identifier (set on docker-compose `runtime:` key).
   * Only meaningful when `executionModel` is `'compose'`.  Undefined for
   * microVM backends that don't use Docker's runtime field.
   */
  readonly dockerRuntime?: string;

  /**
   * When `true`, Docker's embedded DNS (127.0.0.11) is unreachable from inside
   * the agent environment.  AWF compensates by injecting static `/etc/hosts`
   * entries for all compose-internal services and topology peers.
   *
   * gVisor requires this because its userspace netstack has an isolated sandbox
   * loopback that is disconnected from the host netns iptables DNAT rules that
   * Docker uses to intercept DNS traffic.
   *
   * @see https://github.com/google/gvisor/issues/7469
   */
  readonly needsStaticDns: boolean;
}

/**
 * Registry of known runtimes.  Each key is the user-facing name accepted in
 * `container.containerRuntime`.  Add new runtimes here — the rest of AWF
 * picks up the capabilities automatically.
 */
const RUNTIME_REGISTRY: Readonly<Record<string, RuntimeCapabilities>> = {
  gvisor: {
    executionModel: 'compose',
    dockerRuntime: 'runsc',
    needsStaticDns: true,
  },
  // Future: Docker sbx microVM backend
  sbx: {
    executionModel: 'microvm',
    dockerRuntime: undefined,
    needsStaticDns: false,   // sbx manages its own DNS
  },
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Translates a user-facing container runtime name (e.g. `"gvisor"`) into the
 * Docker OCI runtime identifier (e.g. `"runsc"`).  Values that don't appear in
 * the registry are passed through unchanged (assumed to be raw Docker runtime
 * names).  Returns `undefined` for microVM backends that don't use Docker's
 * runtime field.
 */
export function resolveDockerRuntime(runtime: string): string | undefined {
  const entry = RUNTIME_REGISTRY[runtime];
  if (entry) return entry.dockerRuntime;
  // Unknown name — pass through as a raw Docker runtime identifier
  return runtime;
}

/**
 * Returns `true` when the configured runtime requires static DNS entries
 * (extra_hosts + chroot hosts patching) because Docker's embedded DNS is
 * unreachable from inside the agent environment.
 *
 * Returns `false` for unknown runtimes (passthrough names) — they are assumed
 * to work with Docker's standard DNS.
 */
export function runtimeNeedsStaticDns(runtime: string | undefined): boolean {
  if (!runtime) return false;
  return RUNTIME_REGISTRY[runtime]?.needsStaticDns ?? false;
}

/**
 * Returns `true` when the agent should be included as a Docker Compose service
 * (the default for runc, gVisor, and other OCI runtimes).
 *
 * Returns `false` when the agent is managed by an external tool (e.g. Docker
 * sbx microVM) and should NOT appear in docker-compose.yml.  Infrastructure
 * services (Squid, api-proxy) are always generated regardless.
 *
 * When no runtime is configured (undefined), defaults to `true` (compose mode).
 */
export function runtimeUsesComposeAgent(runtime: string | undefined): boolean {
  if (!runtime) return true;
  const entry = RUNTIME_REGISTRY[runtime];
  if (!entry) return true; // unknown runtime → assume compose
  return entry.executionModel === 'compose';
}
