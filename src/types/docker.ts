/**
 * Docker and container configuration types for the agentic workflow firewall
 */

import type { UpstreamProxyConfig } from './config';

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
}

/**
 * Docker Compose configuration structure
 * 
 * Represents the structure of a docker-compose.yml file used to orchestrate
 * the Squid proxy container and agent execution container. This configuration
 * is generated dynamically and written to the work directory.
 * 
 * The typical setup includes:
 * - A Squid proxy service for traffic filtering
 * - An agent service for command execution with iptables NAT rules
 * - A custom Docker network with fixed IP assignments
 * - Named volumes for log persistence
 */
export interface DockerComposeConfig {
  /**
   * Docker Compose file version
   * 
   * @deprecated Version specification is optional in modern Docker Compose
   */
  version?: string;

  /**
   * Service definitions (containers)
   * 
   * Typically includes two services:
   * - 'squid-proxy': Squid proxy server for traffic filtering
   * - 'agent': Ubuntu container for command execution with iptables
   * 
   * @example { 'squid-proxy': {...}, 'agent': {...} }
   */
  services: {
    [key: string]: DockerService;
  };

  /**
   * Network definitions
   * 
   * Defines the Docker network topology. The firewall uses either:
   * - An external network 'awf-net' (when using host-iptables enforcement)
   * - A custom network with fixed subnet and IP assignments
   * 
   * @example { 'awf-net': { external: true } }
   */
  networks: {
    [key: string]: DockerNetwork;
  };

  /**
   * Named volume definitions
   * 
   * Optional volume definitions for persistent storage. Used for Squid
   * cache or log volumes when needed.
   * 
   * @example { 'squid-logs': {} }
   */
  volumes?: {
    [key: string]: DockerVolume;
  };
}

/**
 * Docker service (container) configuration
 * 
 * Represents a single service in docker-compose.yml with all possible
 * configuration options used by the firewall. Services can be built locally
 * or pulled from a registry, and can have complex networking, volume mounting,
 * and dependency configurations.
 * @internal Internal sub-type of DockerComposeConfig; subject to change with Docker Compose spec updates
 */
export interface DockerService {
  /**
   * Pre-built Docker image to use
   * 
   * Mutually exclusive with 'build'. When specified, the image is pulled
   * from the registry (local or remote).
   * 
   * @example 'ubuntu/squid:latest'
   * @example 'ghcr.io/github/gh-aw-firewall/agent:latest'
   */
  image?: string;

  /**
   * Build configuration for building images locally
   * 
   * Mutually exclusive with 'image'. When specified, Docker builds the
   * image from a Dockerfile in the given context directory.
   * 
   * @example { context: './containers/squid', dockerfile: 'Dockerfile' }
   */
  build?: {
    /** Directory containing the Dockerfile and build context */
    context: string;
    /** Path to the Dockerfile relative to context */
    dockerfile: string;
    /** Build arguments passed to docker build */
    args?: Record<string, string>;
  };

  /**
   * Container name for the service
   * 
   * Used for container identification, logging, and inter-container communication.
   * The firewall typically uses 'awf-squid' and 'awf-agent'.
   * 
   * @example 'awf-squid'
   * @example 'awf-agent'
   */
  container_name: string;

  /**
   * Network configuration for the container
   * 
   * Can be either:
   * - Simple array: ['awf-net'] - Connect to named networks
   * - Object with IPs: { 'awf-net': { ipv4_address: '172.30.0.10' } } - Static IPs
   * 
   * Static IPs are used to ensure predictable addressing for iptables rules.
   * Mutually exclusive with network_mode.
   * 
   * @example ['awf-net']
   * @example { 'awf-net': { ipv4_address: '172.30.0.10' } }
   */
  networks?: string[] | { [key: string]: { ipv4_address?: string } };

  /**
   * Network mode for the container
   * 
   * When set to 'service:<name>', the container shares the named service's
   * network namespace. This is used when two containers need to communicate
   * via localhost (e.g., for TLS cert hostname matching).
   * Mutually exclusive with networks.
   * 
   * @example 'service:agent'
   */
  network_mode?: string;

  /**
   * Custom DNS servers for the container
   * 
   * Overrides the default Docker DNS. The firewall uses Google's public DNS
   * (8.8.8.8, 8.8.4.4) to ensure reliable name resolution.
   * 
   * @example ['8.8.8.8', '8.8.4.4']
   */
  dns?: string[];

  /**
   * DNS search domains for the container
   *
   * Appended to unqualified hostnames during DNS resolution.
   */
  dns_search?: string[];

  /**
   * Extra hosts to add to /etc/hosts in the container
   *
   * Array of host:ip mappings. Used to enable host.docker.internal
   * on Linux where it's not available by default.
   *
   * @example ['host.docker.internal:host-gateway']
   */
  extra_hosts?: string[];

  /**
   * Volume mount specifications
   * 
   * Array of mount specifications in Docker format:
   * - Bind mounts: '/host/path:/container/path:options'
   * - Named volumes: 'volume-name:/container/path:options'
   * 
   * Common mounts:
   * - Host filesystem: '/:/host:ro' (read-only host access)
   * - Home directory: '${HOME}:${HOME}' (user files)
   * - Configs: '${workDir}/squid.conf:/etc/squid/squid.conf:ro'
   * 
   * @example ['./squid.conf:/etc/squid/squid.conf:ro']
   */
  volumes?: string[];

  /**
   * Environment variables for the container
   * 
   * Key-value pairs of environment variables. Values can include variable
   * substitutions (e.g., ${HOME}) which are resolved by Docker Compose.
   * 
   * @example { HTTP_PROXY: 'http://172.30.0.10:3128', GITHUB_TOKEN: '${GITHUB_TOKEN}' }
   */
  environment?: Record<string, string>;

  /**
   * Service dependencies
   * 
   * Can be either:
   * - Simple array: ['squid-proxy'] - Wait for service to start
   * - Object with conditions: { 'squid-proxy': { condition: 'service_healthy' } }
   * 
   * The agent service typically depends on squid being healthy before starting.
   * 
   * @example ['squid-proxy']
   * @example { 'squid-proxy': { condition: 'service_healthy' } }
   */
  depends_on?: string[] | { [key: string]: { condition: string } };

  /**
   * Container health check configuration
   * 
   * Defines how Docker monitors container health. The Squid service uses
   * health checks to ensure the proxy is ready before starting the agent container.
   * 
   * @example
   * ```typescript
   * {
   *   test: ['CMD', 'squidclient', '-h', 'localhost', '-p', '3128', 'http://localhost/'],
   *   interval: '1s',
   *   timeout: '1s',
   *   retries: 5,
   *   start_period: '2s'
   * }
   * ```
   */
  healthcheck?: {
    /** Command to run for health check (exit 0 = healthy) */
    test: string[];
    /** Time between health checks */
    interval: string;
    /** Max time to wait for a health check */
    timeout: string;
    /** Number of consecutive failures before unhealthy */
    retries: number;
    /** Grace period before health checks start */
    start_period?: string;
  };

  /**
   * Linux capabilities to add to the container
   *
   * Grants additional privileges beyond the default container capabilities.
   * The agent container requires NET_ADMIN for iptables manipulation.
   *
   * @example ['NET_ADMIN']
   */
  cap_add?: string[];

  /**
   * Linux capabilities to drop from the container
   *
   * Removes specific capabilities to reduce attack surface. The firewall drops
   * capabilities that could be used for container escape or firewall bypass.
   *
   * @example ['NET_RAW', 'SYS_PTRACE', 'SYS_MODULE']
   */
  cap_drop?: string[];

  /**
   * Security options for the container
   *
   * Used for seccomp profiles, AppArmor profiles, and other security configurations.
   *
   * @example ['seccomp=/path/to/profile.json']
   */
  security_opt?: string[];

  /**
   * Memory limit for the container
   *
   * Maximum amount of memory the container can use. Prevents DoS attacks
   * via memory exhaustion.
   *
   * @example '4g'
   * @example '512m'
   */
  mem_limit?: string;

  /**
   * Total memory limit including swap
   *
   * Set equal to mem_limit to disable swap usage.
   *
   * @example '4g'
   */
  memswap_limit?: string;

  /**
   * Maximum number of PIDs (processes) in the container
   *
   * Limits fork bombs and process exhaustion attacks.
   *
   * @example 1000
   */
  pids_limit?: number;

  /**
   * CPU shares (relative weight)
   *
   * Controls CPU allocation relative to other containers.
   * Default is 1024.
   *
   * @example 1024
   * @example 512
   */
  cpu_shares?: number;

  /**
   * Keep STDIN open even if not attached
   * 
   * Required for containers that need to read from stdin, such as MCP servers
   * that use stdio transport.
   * 
   * @default false
   */
  stdin_open?: boolean;

  /**
   * Allocate a pseudo-TTY
   * 
   * When false, prevents ANSI escape sequences in output, providing cleaner logs.
   * The firewall sets this to false for better log readability.
   * 
   * @default false
   */
  tty?: boolean;

  /**
   * Command to run in the container
   * 
   * Overrides the CMD from the Dockerfile. Array format is preferred to avoid
   * shell parsing issues.
   * 
   * @example ['sh', '-c', 'echo hello']
   */
  command?: string[];

  /**
   * Port mappings from host to container
   *
   * Array of port mappings in format 'host:container' or 'host:container/protocol'.
   * The firewall typically doesn't expose ports as communication happens over
   * the Docker network.
   *
   * @example ['8080:80', '443:443/tcp']
   */
  ports?: string[];

  /**
   * Working directory inside the container
   *
   * Sets the initial working directory (pwd) for command execution.
   * This overrides the WORKDIR specified in the Dockerfile.
   *
   * @example '/home/runner/work/repo/repo'
   * @example '/workspace'
   */
  working_dir?: string;

  /**
   * Tmpfs mounts for the container
   *
   * In-memory filesystems mounted over files or directories to shadow their
   * contents. Used as a security measure to prevent the agent from reading
   * sensitive files (e.g., docker-compose.yml containing tokens, MCP logs).
   *
   * Note: volume mounts of subdirectories that map to different container
   * paths are unaffected by a tmpfs overlay on the parent directory.
   *
   * @example ['/tmp/awf-123:rw,noexec,nosuid,size=1m']
   */
  tmpfs?: string[];
}

/**
 * Docker network configuration
 * 
 * Defines a custom Docker network or references an external network.
 * The firewall uses networks to isolate container communication and assign
 * static IP addresses for predictable iptables rules.
 * @internal Internal sub-type of DockerComposeConfig; subject to change with Docker Compose spec updates
 */
export interface DockerNetwork {
  /**
   * Network driver to use
   * 
   * The 'bridge' driver creates a private network on the host.
   * 
   * @default 'bridge'
   * @example 'bridge'
   */
  driver?: string;

  /**
   * IP Address Management (IPAM) configuration
   * 
   * Defines the network's IP address range and gateway. Used to create
   * networks with specific subnets for avoiding conflicts with existing
   * Docker networks.
   * 
   * @example { config: [{ subnet: '172.30.0.0/24' }] }
   */
  ipam?: {
    /** Array of subnet configurations */
    config: Array<{ subnet: string }>;
  };

  /**
   * Whether this network is externally managed
   * 
   * When true, Docker Compose will not create or delete the network,
   * assuming it already exists. Used when the network is created by
   * host-iptables setup before running Docker Compose.
   * 
   * @default false
   */
  external?: boolean;
}

/**
 * Docker named volume configuration
 * 
 * Represents an entry in the top-level `volumes:` map of a docker-compose.yml
 * file. An empty object (`{}`) creates an anonymous managed volume with Docker
 * defaults. Fields map directly to the Docker Compose volume specification.
 * @internal Internal sub-type of DockerComposeConfig; subject to change with Docker Compose spec updates
 */
export interface DockerVolume {
  /**
   * Volume driver to use
   * 
   * @default 'local'
   * @example 'local'
   */
  driver?: string;

  /**
   * Driver-specific options passed to the volume driver
   * 
   * @example { type: 'nfs', o: 'addr=10.0.0.1,rw', device: ':/path/to/dir' }
   */
  driver_opts?: Record<string, string>;

  /**
   * Whether this volume is externally managed
   * 
   * When true, Docker Compose will not create or delete the volume,
   * assuming it already exists outside of this Compose project.
   * 
   * @default false
   */
  external?: boolean;

  /**
   * Custom name for the volume
   * 
   * Overrides the default Compose-project-prefixed name.
   * 
   * @example 'squid-logs'
   */
  name?: string;

  /**
   * Volume labels
   * 
   * Metadata labels to attach to the volume.
   */
  labels?: Record<string, string>;
}
