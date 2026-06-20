/**
 * Networking and DNS configuration options.
 */

import type { UpstreamProxyConfig } from './upstream-proxy';

export interface NetworkOptions {
  /**
   * List of allowed domains for HTTP/HTTPS egress traffic
   * 
   * Domains are normalized (protocol and trailing slash removed) and automatically
   * include subdomain matching. For example, 'github.com' will also allow
   * 'api.github.com' and 'raw.githubusercontent.com'.
   * 
   * @example ['github.com', 'googleapis.com', 'arxiv.org']
   */
  allowedDomains: string[];

  /**
   * List of blocked domains for HTTP/HTTPS egress traffic
   * 
   * Blocked domains take precedence over allowed domains. If a domain matches
   * both the allowlist and blocklist, it will be blocked. This allows for
   * fine-grained control like allowing '*.example.com' but blocking 'internal.example.com'.
   * 
   * Supports the same wildcard patterns as allowedDomains.
   * 
   * @example ['internal.example.com', '*.sensitive.org']
   */
  blockedDomains?: string[];

  /**
   * List of trusted DNS servers for DNS queries
   *
   * DNS traffic is ONLY allowed to these servers, preventing DNS-based data
   * exfiltration to arbitrary destinations. Both IPv4 and IPv6 addresses are
   * supported.
   *
   * Docker's embedded DNS (127.0.0.11) is always allowed for container name
   * resolution, in addition to the servers specified here.
   *
   * @default ['8.8.8.8', '8.8.4.4'] (Google Public DNS)
   * @example ['1.1.1.1', '1.0.0.1'] (Cloudflare DNS)
   * @example ['8.8.8.8', '2001:4860:4860::8888'] (Google DNS with IPv6)
   */
  dnsServers?: string[];

  /**
   * DNS-over-HTTPS resolver URL
   *
   * When specified, a DoH proxy sidecar is deployed that encrypts DNS queries
   * over HTTPS, preventing DNS spoofing and interception. The agent container's
   * DNS is routed through this proxy instead of using unencrypted UDP DNS.
   *
   * The DoH proxy runs as a separate container on the awf-net network and has
   * direct HTTPS access to the DoH resolver (bypassing Squid).
   *
   * @default undefined (use traditional UDP DNS)
   * @example 'https://dns.google/dns-query'
   * @example 'https://cloudflare-dns.com/dns-query'
   * @example 'https://1.1.1.1/dns-query'
   */
  dnsOverHttps?: string;

  /**
   * Enable access to host services via host.docker.internal
   *
   * When true, adds `host.docker.internal` hostname resolution to containers,
   * allowing traffic to reach services running on the host machine.
   *
   * **Security Warning**: When enabled and `host.docker.internal` is added to
   * --allow-domains, containers can access ANY service running on the host,
   * including databases, APIs, and other sensitive services. Only enable this
   * when you specifically need container-to-host communication (e.g., for MCP
   * gateways running on the host).
   *
   * @default false
   * @example
   * ```bash
   * # Enable host access for MCP gateway on host
   * awf --enable-host-access --allow-domains host.docker.internal -- curl http://host.docker.internal:8080
   * ```
   */
  enableHostAccess?: boolean;

  /**
   * Enable network-isolation (topology) enforcement instead of iptables.
   *
   * **Experimental.** When true, AWF enforces egress containment purely through
   * Docker network topology rather than host/container iptables: the agent (and
   * any sidecars) run on an `internal` Docker network with no route to the
   * internet, and the Squid proxy is dual-homed (attached to both the internal
   * network and an external bridge network) so it is the sole egress path.
   *
   * This mode requires **no NET_ADMIN and no host-level iptables**, so it does
   * not need `sudo` and works inside environments where privileged networking is
   * unavailable (e.g. ARC / Kubernetes runner containers using a DinD sidecar).
   * When enabled, the `awf-iptables-init` container is not created.
   *
   * Not yet supported in combination with `--dns-over-https` or
   * `--enable-host-access`.
   *
   * @default false
   */
  networkIsolation?: boolean;

  /**
   * Whether the localhost keyword was detected in --allow-domains.
   *
   * When true, localhost inside the container resolves to the host machine's
   * Docker bridge gateway IP instead of 127.0.0.1 (container loopback).
   * This allows Playwright and other tools to access services running on the host.
   *
   * @default undefined (localhost resolves to container loopback as normal)
   */
  localhostDetected?: boolean;

  /**
   * Additional ports to allow when using --enable-host-access
   *
   * Comma-separated list of ports or port ranges to allow in addition to
   * standard HTTP (80) and HTTPS (443). This provides explicit control over
   * which non-standard ports can be accessed when using host access.
   *
   * By default, only ports 80 and 443 are allowed even with --enable-host-access.
   * Use this flag to explicitly allow specific ports needed for your use case.
   *
   * @default undefined (only 80 and 443 allowed)
   * @example
   * ```bash
   * # Allow MCP gateway on port 3000
   * awf --enable-host-access --allow-host-ports 3000 --allow-domains host.docker.internal -- command
   *
   * # Allow multiple ports
   * awf --enable-host-access --allow-host-ports 3000,8080,9000 --allow-domains host.docker.internal -- command
   *
   * # Allow port ranges
   * awf --enable-host-access --allow-host-ports 3000-3010,8000-8090 --allow-domains host.docker.internal -- command
   * ```
   */
  allowHostPorts?: string;

  /**
   * Ports to allow for host service access (e.g., GitHub Actions services containers)
   *
   * Comma-separated list of ports that are allowed ONLY to the host gateway IP
   * (host.docker.internal). Unlike --allow-host-ports, this flag bypasses the
   * DANGEROUS_PORTS validation because traffic is restricted to the host machine.
   *
   * This is designed for GitHub Actions `services:` containers (e.g., Postgres on
   * port 5432) which publish to the host via port mapping. The agent can reach
   * these services on the host but still cannot reach databases on the internet.
   *
   * Automatically enables host access (--enable-host-access).
   *
   * @default undefined
   * @example
   * ```bash
   * # Allow Postgres service container on host
   * awf --allow-host-service-ports 5432 --allow-domains github.com -- psql -h host.docker.internal
   *
   * # Allow multiple service containers
   * awf --allow-host-service-ports 5432,6379,3306 --allow-domains github.com -- command
   * ```
   */
  allowHostServicePorts?: string;

  /**
   * URL patterns to allow for HTTPS traffic (requires sslBump: true)
   *
   * When SSL Bump is enabled, these patterns are used to filter HTTPS
   * traffic by URL path, not just domain. Supports wildcards (*).
   *
   * If not specified, falls back to domain-only filtering.
   *
   * @example ['https://github.com/myorg/*', 'https://api.example.com/v1/*']
   */
  allowedUrls?: string[];

  /**
   * Upstream (corporate) proxy for Squid to route outbound traffic through.
   *
   * When set, Squid uses `cache_peer` to forward all outbound HTTP/HTTPS
   * traffic through this parent proxy instead of connecting directly to the
   * internet. This is required on self-hosted runners behind corporate proxies
   * where direct egress is blocked.
   *
   * Auto-detected from host `https_proxy`/`HTTPS_PROXY`/`http_proxy`/`HTTP_PROXY`
   * environment variables, or explicitly set via `--upstream-proxy <url>`.
   *
   * @example { host: 'proxy.corp.com', port: 3128 }
   */
  upstreamProxy?: UpstreamProxyConfig;
}
