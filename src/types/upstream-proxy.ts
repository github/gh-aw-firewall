/**
 * Upstream proxy types.
 */

/**
 * Upstream proxy configuration for Squid cache_peer routing
 */
export interface UpstreamProxyConfig {
  /** Hostname or IP of the upstream proxy (e.g., 'proxy.corp.com') */
  host: string;
  /** Port of the upstream proxy (e.g., 3128) */
  port: number;
  /**
   * Domains that should bypass the upstream proxy and connect directly.
   * Parsed from host `no_proxy`/`NO_PROXY`. Only domain suffixes are
   * supported (e.g., '.corp.com', 'internal.example.com').
   * IPs, CIDRs, and wildcards are ignored with a warning.
   */
  noProxy?: string[];
}
