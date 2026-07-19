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

  /**
   * When `true`, AWF sets up egress control via the `awf-iptables-init` container,
   * which applies host-netns iptables DNAT/RETURN rules inside the agent's network
   * namespace (redirect port 80/443 → Squid, and bypass Squid for the MCP gateway).
   *
   * When `false`, those rules cannot govern the agent's traffic — e.g. gVisor's
   * userspace netstack is isolated from the host network namespace, so the
   * iptables-init container is skipped entirely and egress relies solely on the
   * `HTTP_PROXY`/`HTTPS_PROXY` env vars plus `NO_PROXY` (the MCP gateway is reached
   * directly instead of via an iptables bypass).
   *
   * @see https://github.com/google/gvisor/issues/7469
   */
  readonly usesIptables: boolean;
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
    // gVisor's isolated netstack can't be governed by host-netns iptables rules,
    // so skip the iptables-init container and route egress via proxy env vars.
    usesIptables: false,
  },
  // Future: Docker sbx microVM backend
  sbx: {
    executionModel: 'microvm',
    dockerRuntime: undefined,
    needsStaticDns: false,   // sbx manages its own DNS
    usesIptables: false,     // microVM manages its own network egress
  },
};

/**
 * Aliases for runtime names that should resolve to the same capabilities as a
 * canonical registry entry.  This lets users pass either the friendly name
 * (`gvisor`) or the raw Docker OCI runtime name (`runsc`) and get identical
 * behavior — without an alias, `runsc` would fall through to the unknown-runtime
 * defaults (iptables-capable), reintroducing the gVisor egress bug.
 */
const RUNTIME_ALIASES: Readonly<Record<string, string>> = {
  runsc: 'gvisor',
};

/**
 * Canonicalizes a user-facing runtime name to its registry key, following the
 * alias table.  Unknown names are returned unchanged.
 */
function canonicalRuntime(runtime: string): string {
  return RUNTIME_ALIASES[runtime] ?? runtime;
}

/**
 * Looks up the capabilities for a runtime name, following aliases.  Returns
 * `undefined` for unknown names (raw Docker runtime identifiers / default runc).
 */
function lookupCapabilities(runtime: string): RuntimeCapabilities | undefined {
  return RUNTIME_REGISTRY[canonicalRuntime(runtime)];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Translates a user-facing container runtime name (e.g. `"gvisor"`) into the
 * Docker OCI runtime identifier (e.g. `"runsc"`).  Values that don't appear in
 * the registry are passed through unchanged (assumed to be raw Docker runtime
 * names).  Returns `undefined` for microVM backends that don't use Docker's
 * runtime field.
 */
export function resolveDockerRuntime(runtime: string): string | undefined {
  const entry = lookupCapabilities(runtime);
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
  return lookupCapabilities(runtime)?.needsStaticDns ?? false;
}

/**
 * Returns `true` when AWF should set up egress control for the runtime via the
 * `awf-iptables-init` container (host-netns iptables DNAT/RETURN rules).
 *
 * Returns `false` for runtimes whose network stack cannot be governed by those
 * rules (e.g. gVisor's isolated netstack, or microVM backends that manage their
 * own egress).  For these, AWF skips the iptables-init container and relies on
 * proxy env vars + `NO_PROXY`.
 *
 * Defaults to `true` for unknown/undefined runtimes (raw Docker runtime names
 * and the default runc), which share the host network namespace.
 */
export function runtimeUsesIptables(runtime: string | undefined): boolean {
  if (!runtime) return true;
  return lookupCapabilities(runtime)?.usesIptables ?? true;
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
  const entry = lookupCapabilities(runtime);
  if (!entry) return true; // unknown runtime → assume compose
  return entry.executionModel === 'compose';
}

/**
 * Returns `true` when the configured runtime is gVisor, accepting either the
 * friendly name (`gvisor`) or the raw Docker OCI runtime name (`runsc`).  Use
 * this instead of a direct `=== 'gvisor'` comparison so both spellings are
 * handled consistently.
 */
export function isGvisorRuntime(runtime: string | undefined): boolean {
  if (!runtime) return false;
  return canonicalRuntime(runtime) === 'gvisor';
}
