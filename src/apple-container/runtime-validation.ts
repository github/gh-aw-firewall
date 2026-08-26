/**
 * Fail-closed compatibility guards for the Apple Container preview runtime.
 *
 * The Apple Container backend is structurally different from every other AWF
 * runtime in three ways that make an explicit, exhaustive compatibility matrix
 * mandatory rather than nice to have:
 *
 * 1. **The guest has no NIC.** `--network none` is the confinement, so every
 *    feature that assumes the agent shares a Docker network — iptables egress
 *    control, host access, DoH, topology peers, Docker-in-Docker — has no
 *    implementation here. Silently ignoring such a flag would present a
 *    security control the runtime is not applying.
 * 2. **The capability set is closed.** Only the layer-2 allowlist can cross the
 *    VM boundary, and Vertex (port 10004) is deliberately not in it. A
 *    configuration that needs a capability outside the allowlist must be
 *    refused, not routed somewhere else.
 * 3. **The host contract is narrow.** Self-hosted bare-metal Apple Silicon on
 *    macOS 26+ with `kern.hv_support=1`. GitHub-hosted macOS reports
 *    `kern.hv_support=0`, and there is no fallback: an ineligible host fails
 *    preflight instead of quietly running under a weaker runtime.
 *
 * Nothing here probes the host — that is {@link runAppleContainerPreflight}'s
 * job, which runs later in the backend. This module only reasons about the
 * assembled {@link WrapperConfig}, so an unsupported combination is rejected
 * before any container, VM, or socket exists.
 */

import { getLocalDockerEnv } from '../docker-host';
import type { AppleContainerOptions, WrapperConfig } from '../types';

/** User-facing runtime name that selects this backend. */
export const APPLE_CONTAINER_RUNTIME = 'apple-container';

/**
 * Longest `--agent-timeout` the backend accepts, in milliseconds.
 *
 * Matches the Cloud Hypervisor preview bound (24h). A larger value would be
 * accepted by `container run` but is well past any plausible CI budget and
 * would keep a VM and its capability sockets alive indefinitely.
 */
export const APPLE_CONTAINER_MAX_TIMEOUT_MS = 86_400_000;

/**
 * Rejects Apple Container options attached to a different runtime.
 *
 * Runs before security-mode resolution so `--apple-container-*` on, say, a
 * gVisor run is a hard error rather than a silently inert flag.
 */
export function assertAppleContainerSelection(config: WrapperConfig): void {
  if (config.appleContainer && config.containerRuntime !== APPLE_CONTAINER_RUNTIME) {
    const mcpGatewayPort = config.appleContainer.mcpGatewayUpstreamPort;
    if (mcpGatewayPort !== undefined) {
      throw new Error(
        'appleContainer.mcpGatewayUpstreamPort bridges an external MCP gateway into a NIC-less ' +
        `Apple Container guest and requires --container-runtime ${APPLE_CONTAINER_RUNTIME}; ` +
        `the ${config.containerRuntime ?? 'docker'} runtime reaches the gateway over its own ` +
        'network and must not set it',
      );
    }
    throw new Error(
      `Apple Container options require --container-runtime ${APPLE_CONTAINER_RUNTIME}`,
    );
  }
}

/**
 * Re-validates the MCP gateway upstream port on a fully assembled config.
 *
 * The CLI parser already enforces this range, but a config file or a
 * programmatic caller can populate `appleContainer` directly. A configured
 * relay target is a network path into an otherwise NIC-less guest, so it is
 * checked again here rather than trusted because one entry point validated it.
 */
function assertAppleContainerMcpGatewayUpstream(appleContainer: AppleContainerOptions): void {
  const port = appleContainer.mcpGatewayUpstreamPort;
  if (port === undefined) return;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `appleContainer.mcpGatewayUpstreamPort must be an integer TCP port in 1..65535; got ${port}`,
    );
  }
}

/**
 * Guards that must hold *before* `applySecurityMode` mutates the config.
 *
 * Security mode can turn `--legacy-security` into a populated iptables
 * configuration, at which point "the user asked for legacy security" is no
 * longer distinguishable from "AWF defaulted to it". Checking here keeps the
 * error message pointed at the flag the operator actually passed.
 */
export function assertAppleContainerPreSecurityCompatibility(config: WrapperConfig): void {
  if (config.networkIsolation === false) {
    throw new Error('Apple Container preview cannot disable --network-isolation');
  }
  if (config.legacySecurity) {
    throw new Error(
      'Apple Container preview does not support --legacy-security; the guest has no NIC, so ' +
      'host and container iptables rules govern nothing',
    );
  }
  if (config.enableDind || config.dockerHostPathPrefix || config.runnerTopology === 'arc-dind') {
    throw new Error(
      'Apple Container preview does not support Docker-in-Docker or split runner/daemon ' +
      'filesystems; the guest never receives a Docker socket',
    );
  }
  if (config.enableHostAccess || config.allowHostPorts || config.allowHostServicePorts) {
    throw new Error(
      'Apple Container preview does not support host access; only allowlisted AWF capability ' +
      'sockets cross the VM boundary',
    );
  }
  if (config.dnsOverHttps) {
    throw new Error(
      'Apple Container preview does not support DNS-over-HTTPS; the guest resolves no names ' +
      'at all and reaches every destination through the Squid capability',
    );
  }
  if (config.enclaves?.enabled) {
    throw new Error(
      'Apple Container preview does not yet support enclaves; the enclave MCP gateway is a ' +
      'Docker-network peer that has not been proven reachable from a NIC-less guest',
    );
  }
  if (config.topologyAttach && config.topologyAttach.length > 0) {
    throw new Error(
      'Apple Container preview does not support --topology-attach; externally owned peers are ' +
      'not published to macOS loopback and therefore cannot be bridged into the guest',
    );
  }
  const dockerHost = config.awfDockerHost ?? getLocalDockerEnv().DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    throw new Error(
      'Apple Container preview requires a local Unix-socket Docker daemon so infrastructure ' +
      'ports are published to macOS loopback',
    );
  }
}

/**
 * Full compatibility check for a fully assembled config.
 *
 * @throws with an actionable message on any unsupported combination.
 */
export function assertAppleContainerRuntimeCompatibility(
  config: WrapperConfig,
  appleContainer = requireAppleContainerConfig(config),
): void {
  if (!appleContainer.previewEnabled) {
    throw new Error(
      'Apple Container workload execution requires explicit --apple-container-preview opt-in',
    );
  }
  if (!config.networkIsolation) {
    throw new Error('Apple Container preview requires strict --network-isolation security');
  }
  assertAppleContainerMcpGatewayUpstream(appleContainer);
  assertAppleContainerPreSecurityCompatibility(config);

  if (config.agentImage && config.agentImage !== 'default') {
    throw new Error(
      'Apple Container preview supports only the default agent image; the "act" preset and ' +
      'custom base images are not published as native arm64 and Rosetta translation is refused',
    );
  }
  if (config.buildLocal) {
    throw new Error(
      'Apple Container preview cannot use --build-local; the agent image is pulled through the ' +
      "Apple Container image store, not Docker's",
    );
  }
  if (config.filesystemAllowWrite !== undefined) {
    throw new Error(
      `filesystem.allowWrite is not yet supported by the ${APPLE_CONTAINER_RUNTIME} runtime`,
    );
  }
  if (config.volumeMounts?.length) {
    throw new Error(
      'Apple Container preview does not support --volume; only the workspace and AWF-owned ' +
      'run directories are exposed to the guest',
    );
  }
  if (config.tty) {
    throw new Error('Apple Container preview does not support --tty');
  }
  if (config.sslBump) {
    throw new Error(
      'Apple Container preview does not support --ssl-bump; it requires a locally built Squid ' +
      'image and a guest trust store AWF does not manage here',
    );
  }
  if (config.sysrootImage || config.chrootBinariesSourcePath) {
    throw new Error(
      'Apple Container preview does not use the chroot sysroot; the guest runs the agent image ' +
      'root filesystem directly',
    );
  }
  if (config.googleApiKey) {
    throw new Error(
      'Apple Container preview does not support Google Vertex AI credential isolation; the ' +
      'Vertex provider port is not part of the capability transport allowlist',
    );
  }
  if (
    config.agentTimeout !== undefined &&
    config.agentTimeout * 60_000 > APPLE_CONTAINER_MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `Apple Container preview supports --agent-timeout values up to ` +
      `${APPLE_CONTAINER_MAX_TIMEOUT_MS / 60_000} minutes`,
    );
  }
}

/**
 * Narrows a config to one that actually selected this runtime.
 *
 * A backend reached without Apple Container configuration is a wiring bug, not
 * a user error, so this throws rather than substituting defaults.
 */
export function requireAppleContainerConfig(config: WrapperConfig): AppleContainerOptions {
  if (config.containerRuntime !== APPLE_CONTAINER_RUNTIME || !config.appleContainer) {
    throw new Error(
      'Apple Container backend resolved without Apple Container runtime configuration',
    );
  }
  return config.appleContainer;
}
