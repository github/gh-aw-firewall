/**
 * Container runtime resolution and capability detection.
 *
 * Centralises two concerns:
 *
 * 1. **Name translation** – user-facing runtime names (e.g. `"gvisor"`) are
 *    mapped to Docker OCI runtime identifiers (e.g. `"runsc"`).  Unknown names
 *    are passed through unchanged so callers can also use raw Docker names.
 *
 * 2. **Capability flags** – each runtime can declare behavioural quirks that
 *    AWF must compensate for.  Today the only flag is `needsStaticDns`, which
 *    tells AWF to inject `/etc/hosts` entries for every service hostname
 *    because the runtime's network stack cannot reach Docker's embedded DNS
 *    at 127.0.0.11.
 *
 * To add a new runtime, add an entry to {@link RUNTIME_REGISTRY}.
 */

// ─── Registry ────────────────────────────────────────────────────────────────

/** Behavioural capabilities / quirks for a container runtime. */
export interface RuntimeCapabilities {
  /** Docker OCI runtime identifier (set on docker-compose `runtime:` key). */
  readonly dockerRuntime: string;

  /**
   * When `true`, Docker's embedded DNS (127.0.0.11) is unreachable from inside
   * the container.  AWF compensates by injecting static `/etc/hosts` entries
   * for all compose-internal services and topology peers.
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
    dockerRuntime: 'runsc',
    needsStaticDns: true,
  },
  // Example: a hypothetical runtime that uses standard Docker DNS
  // kata: { dockerRuntime: 'kata-runtime', needsStaticDns: false },
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Translates a user-facing container runtime name (e.g. `"gvisor"`) into the
 * Docker OCI runtime identifier (e.g. `"runsc"`).  Values that don't appear in
 * the registry are passed through unchanged.
 */
export function resolveDockerRuntime(runtime: string): string {
  return RUNTIME_REGISTRY[runtime]?.dockerRuntime ?? runtime;
}

/**
 * Returns the capability flags for a runtime, or `undefined` if the runtime
 * is not in the registry (i.e. a raw Docker runtime name was used directly).
 */
export function getRuntimeCapabilities(runtime: string): RuntimeCapabilities | undefined {
  return RUNTIME_REGISTRY[runtime];
}

/**
 * Returns `true` when the configured runtime requires static DNS entries
 * (extra_hosts + chroot hosts patching) because Docker's embedded DNS is
 * unreachable from inside the container.
 *
 * Returns `false` for unknown runtimes (passthrough names) — they are assumed
 * to work with Docker's standard DNS.
 */
export function runtimeNeedsStaticDns(runtime: string | undefined): boolean {
  if (!runtime) return false;
  return RUNTIME_REGISTRY[runtime]?.needsStaticDns ?? false;
}
