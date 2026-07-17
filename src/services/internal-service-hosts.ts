/**
 * Fixed IPs of the compose-internal proxy sidecars the agent (and topology
 * peers) may need to resolve by hostname.
 */
export interface InternalServiceIps {
  squidIp: string;
  apiProxyIp?: string;
  cliProxyIp?: string;
}

/**
 * Builds the `<service-name> -> <ip>` host entries for the compose-internal
 * proxy sidecars, including only the sidecars that are actually enabled (their
 * IP is defined).
 *
 * These hostnames normally resolve via Docker's embedded DNS (127.0.0.11), but
 * that resolver is unreachable from gVisor's userspace netstack and on ARC/DinD
 * runners (where the Docker-in-Docker network doesn't forward lookups to the
 * Kubernetes resolver). Since every sidecar has a fixed IP known at startup,
 * both the gVisor path (compose `extra_hosts`) and the network-isolation /
 * ARC/DinD path (runtime `/etc/hosts` patch) pre-register the same entries via
 * this single source of truth.
 */
export function buildInternalServiceHosts(ips: InternalServiceIps): Record<string, string> {
  const hosts: Record<string, string> = { 'squid-proxy': ips.squidIp };
  if (ips.apiProxyIp) {
    hosts['api-proxy'] = ips.apiProxyIp;
  }
  if (ips.cliProxyIp) {
    hosts['cli-proxy'] = ips.cliProxyIp;
  }
  return hosts;
}
