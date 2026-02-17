/**
 * Configuration types for the agentic workflow firewall
 */

/**
 * Main configuration interface for the firewall wrapper
 * 
 * This configuration controls the entire firewall lifecycle including:
 * - Domain whitelisting for egress traffic control
 * - Container orchestration via Docker Compose
 * - Logging behavior and debugging options
 * - Container image sources (GHCR vs local builds)
 * - Environment variable propagation to containers
 * 
 * @example
 * ```typescript
 * const config: WrapperConfig = {
 *   allowedDomains: ['github.com', 'api.github.com'],
 *   agentCommand: 'npx @github/copilot --prompt "test"',
 *   logLevel: 'info',
 *   keepContainers: false,
 *   workDir: '/tmp/awf-1234567890',
 * };
 * ```
 */
export interface WrapperConfig {
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
   * The command to execute inside the firewall container
   * 
   * This command runs inside an Ubuntu-based Docker container with iptables rules
   * that redirect all HTTP/HTTPS traffic through a Squid proxy. The command has
   * access to the host filesystem (mounted at /host and ~).
   * 
   * @example 'npx @github/copilot --prompt "list files"'
   * @example 'curl https://api.github.com/zen'
   */
  agentCommand: string;

  /**
   * Logging verbosity level
   * 
   * Controls which log messages are displayed:
   * - 'debug': All messages including detailed diagnostics
   * - 'info': Informational messages and above
   * - 'warn': Warnings and errors only
   * - 'error': Errors only
   */
  logLevel: LogLevel;

  /**
   * Whether to preserve containers and configuration files after execution
   *
   * When true:
   * - Docker containers are not stopped or removed
   * - Work directory and all config files remain on disk
   * - Useful for debugging, inspecting logs, and troubleshooting
   *
   * When false (default):
   * - Containers are stopped and removed via 'docker compose down -v'
   * - Work directory is deleted (except preserved log directories)
   * - Squid and agent logs are moved to /tmp if they exist
   */
  keepContainers: boolean;

  /**
   * Whether to allocate a pseudo-TTY for the agent execution container
   *
   * When true:
   * - Allocates a pseudo-TTY (stdin becomes a TTY)
   * - Required for interactive CLI tools like Claude Code that use Ink/raw mode
   * - Logs will contain ANSI escape sequences (colors, cursor movements)
   *
   * When false (default):
   * - No TTY allocation (stdin is a pipe)
   * - Clean logs without ANSI escape sequences
   * - Interactive tools requiring TTY will hang or fail
   *
   * @default false
   */
  tty?: boolean;

  /**
   * Temporary work directory for configuration files and logs
   * 
   * This directory contains:
   * - squid.conf: Generated Squid proxy configuration
   * - docker-compose.yml: Docker Compose service definitions
   * - agent-logs/: Volume mount for agent logs
   * - squid-logs/: Volume mount for Squid proxy logs
   * 
   * @example '/tmp/awf-1234567890'
   */
  workDir: string;

  /**
   * Docker image registry to use for container images
   * 
   * Allows overriding the default GitHub Container Registry with custom registries
   * for development, testing, or air-gapped environments.
   * 
   * @default 'ghcr.io/github/gh-aw-firewall'
   * @example 'my-registry.example.com/awf'
   */
  imageRegistry?: string;

  /**
   * Docker image tag to use for container images
   * 
   * @default 'latest'
   * @example 'v0.1.0'
   * @example 'dev'
   */
  imageTag?: string;

  /**
   * Whether to build container images locally instead of pulling from registry
   *
   * When true, Docker images are built from local Dockerfiles in containers/squid
   * and containers/agent directories. When false (default), images are pulled
   * from the configured registry.
   *
   * @default false
   */
  buildLocal?: boolean;

  /**
   * Whether to skip pulling images from the registry
   *
   * When true, Docker Compose will use locally available images without
   * attempting to pull from the registry. This is useful when images are
   * pre-downloaded or in air-gapped environments.
   *
   * If the required images are not available locally, container startup will fail.
   *
   * @default false
   */
  skipPull?: boolean;

  /**
   * Agent container image preset or custom base image
   *
   * Presets (pre-built, fast startup):
   * - 'default' or undefined: Minimal ubuntu:22.04 (~200MB) - uses GHCR agent:tag
   * - 'act': GitHub Actions parity (~2GB) - uses GHCR agent-act:tag
   *
   * Custom base images (require --build-local):
   * - 'ubuntu:XX.XX': Official Ubuntu image
   * - 'ghcr.io/catthehacker/ubuntu:runner-XX.XX': Closer to GitHub Actions runner (~2-5GB)
   * - 'ghcr.io/catthehacker/ubuntu:full-XX.XX': Near-identical to GitHub Actions runner (~20GB)
   *
   * @default 'default'
   * @example 'act'
   * @example 'ghcr.io/catthehacker/ubuntu:runner-22.04'
   */
  agentImage?: 'default' | 'act' | string;

  /**
   * Additional environment variables to pass to the agent execution container
   * 
   * These variables are explicitly passed to the container and are accessible
   * to the command and any MCP servers. Common use cases include API tokens,
   * configuration values, and credentials.
   * 
   * @example { GITHUB_TOKEN: 'ghp_...', OPENAI_API_KEY: 'sk-...' }
   */
  additionalEnv?: Record<string, string>;

  /**
   * Whether to pass all host environment variables to the container
   *
   * When true, all environment variables from the host (excluding system variables
   * like PATH, HOME, etc.) are passed to the agent execution container. This is useful for
   * development but may pose security risks in production.
   *
   * When false (default), only variables specified in additionalEnv are passed.
   *
   * @default false
   */
  envAll?: boolean;

  /**
   * Custom volume mounts to add to the agent execution container
   *
   * Array of volume mount specifications in Docker format:
   * - 'host_path:container_path' (defaults to rw)
   * - 'host_path:container_path:ro' (read-only)
   * - 'host_path:container_path:rw' (read-write)
   *
   * When specified, selective mounting is used (only essential directories + custom mounts).
   * When not specified, selective mounting is still used by default for security.
   * Use --allow-full-filesystem-access to opt into blanket mounting.
   *
   * @example ['/workspace:/workspace:ro', '/data:/data:rw']
   */
  volumeMounts?: string[];

  /**
   * Allow full filesystem access (blanket /:/host:rw mount)
   *
   * **SECURITY WARNING**: This flag disables AWF's security protection against
   * credential exfiltration via prompt injection attacks. It mounts the entire
   * host filesystem with read-write access, exposing ALL files including:
   * - Docker Hub tokens (~/.docker/config.json)
   * - GitHub CLI tokens (~/.config/gh/hosts.yml)
   * - NPM tokens (~/.npmrc)
   * - Rust crates.io tokens (~/.cargo/credentials)
   * - PHP Composer tokens (~/.composer/auth.json)
   * - And any other sensitive files on the host
   *
   * **Default behavior (false)**: Selective mounting is used, which only mounts:
   * - User home directory (for workspace access)
   *   - In GitHub Actions, the workspace directory ($GITHUB_WORKSPACE) is typically a
   *     subdirectory of $HOME and is therefore accessible via this home directory mount
   * - Essential directories (/tmp, ~/.copilot/logs)
   * - Credential files are hidden by mounting /dev/null over them
   *
   * **Only enable this if**:
   * - You need access to files outside the standard directories
   * - You cannot use --volume-mount to specify needed directories
   * - You understand and accept the security risks
   *
   * @default false
   * @example
   * ```bash
   * # Avoid this - use selective mounting instead
   * awf --allow-full-filesystem-access --allow-domains github.com -- curl https://api.github.com
   *
   * # Preferred - use selective mounting (default)
   * awf --allow-domains github.com -- curl https://api.github.com
   *
   * # If you need specific directories, mount them explicitly
   * awf --volume-mount /data:/data:ro --allow-domains github.com -- curl https://api.github.com
   * ```
   */
  allowFullFilesystemAccess?: boolean;

  /**
   * Working directory inside the agent execution container
   *
   * Sets the initial working directory (pwd) for command execution.
   * This overrides the Dockerfile's WORKDIR and should match GITHUB_WORKSPACE
   * for path consistency with AI prompts.
   *
   * When not specified, defaults to the container's WORKDIR (/workspace).
   *
   * @example '/home/runner/work/repo/repo'
   */
  containerWorkDir?: string;

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
   * Custom directory for Squid proxy logs (written directly during runtime)
   *
   * When specified, Squid proxy logs (access.log, cache.log) are written
   * directly to this directory during execution via Docker volume mount.
   * This is timeout-safe: logs are available immediately and survive
   * unexpected termination (SIGKILL).
   *
   * When not specified, logs are written to ${workDir}/squid-logs during
   * runtime and moved to /tmp/squid-logs-<timestamp> after cleanup.
   *
   * Note: This only affects Squid proxy logs. Agent logs (e.g., from
   * Copilot CLI --log-dir) are handled separately and always preserved
   * to /tmp/awf-agent-logs-<timestamp>.
   *
   * @example '/tmp/my-proxy-logs'
   */
  proxyLogsDir?: string;

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
   * Whether to enable SSL Bump for HTTPS content inspection
   *
   * When true, Squid will intercept HTTPS connections and generate
   * per-host certificates on-the-fly, allowing inspection of URL paths,
   * query parameters, and request methods for HTTPS traffic.
   *
   * Security implications:
   * - A per-session CA certificate is generated (valid for 1 day)
   * - The CA certificate is injected into the agent container's trust store
   * - HTTPS traffic is decrypted at the proxy for inspection
   * - The CA private key is stored only in the temporary work directory
   *
   * @default false
   */
  sslBump?: boolean;

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
   * Enable API proxy sidecar for holding authentication credentials
   *
   * When true, deploys a Node.js proxy sidecar container that:
   * - Holds OpenAI, Anthropic, and GitHub Copilot API keys securely
   * - Automatically injects authentication headers
   * - Routes all traffic through Squid to respect domain whitelisting
   * - Proxies requests to LLM providers
   *
   * The sidecar exposes three endpoints accessible from the agent container:
   * - http://api-proxy:10000 - OpenAI API proxy (for Codex)
   * - http://api-proxy:10001 - Anthropic API proxy (for Claude)
   * - http://api-proxy:10002 - GitHub Copilot API proxy
   *
   * When the corresponding API key is provided, the following environment
   * variables are set in the agent container:
   * - OPENAI_BASE_URL=http://api-proxy:10000/v1 (set when OPENAI_API_KEY is provided)
   * - ANTHROPIC_BASE_URL=http://api-proxy:10001 (set when ANTHROPIC_API_KEY is provided)
   * - COPILOT_API_URL=http://api-proxy:10002 (set when COPILOT_API_KEY is provided)
   * - CLAUDE_CODE_API_KEY_HELPER=/usr/local/bin/get-claude-key.sh (set when ANTHROPIC_API_KEY is provided)
   *
   * API keys are passed via environment variables:
   * - OPENAI_API_KEY - Optional OpenAI API key for Codex
   * - ANTHROPIC_API_KEY - Optional Anthropic API key for Claude
   * - COPILOT_API_KEY - Optional GitHub Copilot API key
   *
   * @default false
   * @example
   * ```bash
   * # Enable API proxy with keys from environment
   * export OPENAI_API_KEY="sk-..."
   * export ANTHROPIC_API_KEY="sk-ant-..."
   * export COPILOT_API_KEY="ghu_..."
   * awf --enable-api-proxy --allow-domains api.openai.com,api.anthropic.com,api.githubcopilot.com -- command
   * ```
   */
  enableApiProxy?: boolean;

  /**
   * OpenAI API key for Codex (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to api.openai.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   *
   * @default undefined
   */
  openaiApiKey?: string;

  /**
   * Anthropic API key for Claude (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to api.anthropic.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   *
   * @default undefined
   */
  anthropicApiKey?: string;

  /**
   * GitHub Copilot API key (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to api.githubcopilot.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   *
   * @default undefined
   */
  copilotApiKey?: string;
}

/**
 * Logging level type for controlling output verbosity
 * 
 * The logger filters messages based on this level. Each level includes
 * all messages from higher severity levels:
 * - 'debug' (0): Shows all messages
 * - 'info' (1): Shows info, warn, and error
 * - 'warn' (2): Shows warn and error
 * - 'error' (3): Shows only errors
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
    [key: string]: Record<string, unknown>;
  };
}

/**
 * Docker service (container) configuration
 * 
 * Represents a single service in docker-compose.yml with all possible
 * configuration options used by the firewall. Services can be built locally
 * or pulled from a registry, and can have complex networking, volume mounting,
 * and dependency configurations.
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
   * 
   * @example ['awf-net']
   * @example { 'awf-net': { ipv4_address: '172.30.0.10' } }
   */
  networks: string[] | { [key: string]: { ipv4_address?: string } };

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
   *   interval: '5s',
   *   timeout: '3s',
   *   retries: 3,
   *   start_period: '10s'
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
 * Information about a blocked network target
 * 
 * Represents a domain and optional port that was blocked by the firewall.
 * Used for error reporting and diagnostics when egress traffic is denied.
 * Parsed from Squid proxy access logs (TCP_DENIED entries).
 */
export interface BlockedTarget {
  /**
   * Full target specification including port if present
   * 
   * @example 'github.com:8443'
   * @example 'example.com'
   */
  target: string;

  /**
   * Domain name without port
   * 
   * Extracted from the target for matching against the allowed domains list.
   * 
   * @example 'github.com'
   * @example 'example.com'
   */
  domain: string;

  /**
   * Port number if specified in the blocked request
   *
   * Non-standard ports (other than 80/443) that were part of the connection attempt.
   *
   * @example '8443'
   * @example '8080'
   */
  port?: string;
}

/**
 * Parsed entry from Squid's firewall_detailed log format
 *
 * Represents a single log line parsed into structured fields for
 * display formatting and analysis.
 */
export interface ParsedLogEntry {
  /** Unix timestamp with milliseconds (e.g., 1761074374.646) */
  timestamp: number;
  /** Client IP address */
  clientIp: string;
  /** Client port number */
  clientPort: string;
  /** Host header value (may be "-" for CONNECT requests) */
  host: string;
  /** Destination IP address (may be "-" for denied requests) */
  destIp: string;
  /** Destination port number */
  destPort: string;
  /** HTTP protocol version (e.g., "1.1") */
  protocol: string;
  /** HTTP method (CONNECT, GET, POST, etc.) */
  method: string;
  /** HTTP status code (200, 403, etc.) */
  statusCode: number;
  /** Squid decision code (e.g., "TCP_TUNNEL:HIER_DIRECT", "TCP_DENIED:HIER_NONE") */
  decision: string;
  /** Request URL or domain:port for CONNECT */
  url: string;
  /** User-Agent header value */
  userAgent: string;
  /** Extracted domain name */
  domain: string;
  /** true if request was allowed (TCP_TUNNEL), false if denied (TCP_DENIED) */
  isAllowed: boolean;
  /** true if CONNECT method (HTTPS) */
  isHttps: boolean;
}

/**
 * Output format for log display
 */
export type OutputFormat = 'raw' | 'pretty' | 'json';

/**
 * Output format for log stats and summary commands
 */
export type LogStatsFormat = 'json' | 'markdown' | 'pretty';

/**
 * Source of log data (running container or preserved log files)
 */
export interface LogSource {
  /** Type of log source */
  type: 'running' | 'preserved';
  /** Path to preserved log directory (for preserved type) */
  path?: string;
  /** Container name (for running type) */
  containerName?: string;
  /** Timestamp extracted from directory name (for preserved type) */
  timestamp?: number;
  /** Human-readable date string (for preserved type) */
  dateStr?: string;
}

/**
 * Result of PID tracking operation
 *
 * Contains information about the process that made a network request,
 * identified by correlating the source port with /proc filesystem data.
 */
export interface PidTrackResult {
  /** Process ID that owns the socket, or -1 if not found */
  pid: number;
  /** Full command line of the process, or 'unknown' if not found */
  cmdline: string;
  /** Short command name (from /proc/[pid]/comm), or 'unknown' if not found */
  comm: string;
  /** Socket inode number, or undefined if not found */
  inode?: string;
  /** Error message if tracking failed, or undefined on success */
  error?: string;
}

/**
 * Extended log entry with PID tracking information
 *
 * Combines the standard parsed log entry with process attribution
 * for complete request tracking.
 */
export interface EnhancedLogEntry extends ParsedLogEntry {
  /** Process ID that made the request, or -1 if unknown */
  pid?: number;
  /** Full command line of the process that made the request */
  cmdline?: string;
  /** Short command name (from /proc/[pid]/comm) */
  comm?: string;
  /** Socket inode associated with the connection */
  inode?: string;
}
