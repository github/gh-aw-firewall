/**
 * Squid proxy configuration types for the agentic workflow firewall
 */

import type { UpstreamProxyConfig } from './upstream-proxy';

/**
 * Configuration for the Squid proxy server
 * 
 * Used to generate squid.conf with domain-based access control lists (ACLs).
 * The generated configuration implements L7 (application layer) filtering for
 * HTTP and HTTPS traffic using domain whitelisting and optional blocklisting.
 */
export interface SquidConfig {
  /**
   * List of allowed domains for proxy access
   * 
   * These domains are converted to Squid ACL rules with subdomain matching.
   * For example, 'github.com' becomes '.github.com' in Squid configuration,
   * which matches both 'github.com' and all subdomains like 'api.github.com'.
   */
  domains: string[];

  /**
   * List of blocked domains for proxy access
   * 
   * These domains are explicitly denied. Blocked domains take precedence over
   * allowed domains. This allows for fine-grained control like allowing
   * '*.example.com' but blocking 'internal.example.com'.
   * 
   * Supports the same wildcard patterns as domains.
   */
  blockedDomains?: string[];

  /**
   * Port number for the Squid proxy to listen on
   * 
   * The proxy listens on this port within the Docker network for HTTP
   * and HTTPS (CONNECT method) requests.
   * 
   * @default 3128
   */
  port: number;

  /**
   * Whether to enable SSL Bump for HTTPS content inspection
   *
   * When true, Squid will intercept HTTPS connections and generate
   * per-host certificates on-the-fly, allowing inspection of URL paths.
   *
   * @default false
   */
  sslBump?: boolean;

  /**
   * Paths to CA certificate files for SSL Bump
   *
   * Required when sslBump is true.
   */
  caFiles?: {
    certPath: string;
    keyPath: string;
  };

  /**
   * Path to SSL certificate database for dynamic certificate generation
   *
   * Required when sslBump is true.
   */
  sslDbPath?: string;

  /**
   * URL patterns for HTTPS traffic filtering (requires sslBump)
   *
   * When SSL Bump is enabled, these regex patterns are used to filter
   * HTTPS traffic by URL path, not just domain.
   */
  urlPatterns?: string[];

  /**
   * Whether to enable DLP (Data Loss Prevention) scanning
   *
   * When true, Squid will block requests containing credential patterns
   * (API keys, tokens, secrets) in URLs via url_regex ACLs.
   *
   * @default false
   */
  enableDlp?: boolean;

  /**
   * Whether to enable host access (allows non-standard ports)
   *
   * When true, Squid will allow connections to any port, not just
   * standard HTTP (80) and HTTPS (443) ports. This is required when
   * --enable-host-access is used to allow access to host services
   * running on non-standard ports.
   *
   * @default false
   */
  enableHostAccess?: boolean;

  /**
   * Additional ports to allow (comma-separated list)
   *
   * Ports or port ranges specified by the user via --allow-host-ports flag.
   * These are added to the Safe_ports ACL in addition to 80 and 443.
   *
   * @example "3000,8080,9000"
   * @example "3000-3010,8000-8090"
   */
  allowHostPorts?: string;

  /**
   * DNS servers for Squid to use for domain resolution
   *
   * In the simplified security model, Squid handles all DNS resolution
   * for HTTP/HTTPS traffic. These servers are passed to Squid's
   * dns_nameservers directive.
   *
   * @default ['8.8.8.8', '8.8.4.4']
   */
  dnsServers?: string[];

  /**
   * Upstream (corporate) proxy for Squid to chain outbound traffic through.
   *
   * When set, generates `cache_peer` / `never_direct` / `always_direct`
   * directives so Squid forwards traffic through the parent proxy.
   */
  upstreamProxy?: UpstreamProxyConfig;

  /**
   * IP address of the AWF api-proxy sidecar container (e.g., "172.30.0.30").
   *
   * When set, an explicit `http_access allow` rule is inserted for this IP
   * *before* the `deny dst_ipv4` raw-IP block. This is required because some
   * HTTP clients (e.g., Node.js fetch / undici ProxyAgent) route requests to
   * the api-proxy through `HTTP_PROXY` without honouring `NO_PROXY` for raw IP
   * addresses, causing Squid to deny them via the raw-IP rule.
   */
  apiProxyIp?: string;

  /**
   * Ports served by the AWF api-proxy sidecar (e.g., [10000, 10001, 10002, 10003]).
   *
   * When set, these ports are appended to Squid's `Safe_ports` ACL so that
   * `http_access deny !Safe_ports` and `http_access deny CONNECT !Safe_ports`
   * do not block connections to the api-proxy before the allow rule fires.
   */
  apiProxyPorts?: number[];

  /**
   * Trusted topology-peer hostnames reachable through Squid in network-isolation
   * (topology) mode — the `--topology-attach` container names plus the DIFC/
   * cli-proxy host.
   *
   * These Docker-internal peers (e.g. an MCP gateway `awmg-mcpg`) are served on
   * non-standard ports (e.g. 8080) and cannot be reached via the normal
   * domain allowlist, which is gated behind `http_access deny !Safe_ports`
   * (80/443 only). For each peer an explicit `http_access allow` (dstdomain) is
   * emitted *before* the Safe_ports and raw-IP deny rules, so proxy clients that
   * honour `HTTP(S)_PROXY` but ignore `NO_PROXY` can reach the peer on any port.
   *
   * DNS resolution of these Docker-only names is provided separately by patching
   * the squid-proxy container's `extra_hosts` (see topology.ts), since Squid's
   * external `dns_nameservers` cannot resolve them.
   */
  topologyPeers?: string[];
}
