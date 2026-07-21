import { runtimeUsesComposeAgent } from './container-runtime';
import { parseDifcProxyHost } from './host-env';

/**
 * The subset of options needed to resolve trusted topology-peer hostnames.
 * Deliberately structural so both raw CLI options (preflight) and the resolved
 * {@link WrapperConfig} (config-writer) can be passed without adapters.
 */
export interface TopologyPeerOptions {
  networkIsolation?: unknown;
  containerRuntime?: string;
  topologyAttach?: unknown;
  difcProxyHost?: unknown;
}

/**
 * Resolves the set of trusted topology-peer hostnames that must be reachable
 * through Squid in network-isolation (topology) mode.
 *
 * Peers are the `--topology-attach` container names plus the DIFC/cli-proxy
 * host (`--difc-proxy-host`, scheme/port stripped). The gating mirrors
 * `buildProxyEnvironment()` exactly: only meaningful when the agent actually
 * shares `awf-net`, i.e. a compose-managed agent (runc, gVisor). microVM
 * backends (Docker sbx) run the agent off `awf-net` and reach peers via their
 * own proxy-chaining path, so peers are skipped there — keeping the Squid ACL,
 * DNS, and NO_PROXY code paths consistent.
 *
 * @returns Deduplicated peer hostnames, or `[]` when not applicable.
 */
export function resolveTopologyPeerHosts(options: TopologyPeerOptions): string[] {
  if (!options.networkIsolation || !runtimeUsesComposeAgent(options.containerRuntime)) {
    return [];
  }

  const peers: string[] = [];
  if (Array.isArray(options.topologyAttach)) {
    for (const name of options.topologyAttach) {
      if (typeof name === 'string' && name.trim() !== '') {
        peers.push(name);
      }
    }
  }
  if (typeof options.difcProxyHost === 'string' && options.difcProxyHost.trim() !== '') {
    peers.push(parseDifcProxyHost(options.difcProxyHost).host);
  }

  return [...new Set(peers)];
}
