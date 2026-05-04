/**
 * Configuration types for the agentic workflow firewall
 */

/**
 * API Proxy port configuration
 *
 * These ports are used by the api-proxy sidecar container to expose
 * authentication-injecting proxies for different LLM providers.
 *
 * All ports must be allowed in:
 * - containers/api-proxy/Dockerfile (EXPOSE directive)
 * - src/host-iptables.ts (firewall rules)
 * - containers/agent/setup-iptables.sh (NAT rules)
 */
export const API_PROXY_PORTS = {
  /**
   * OpenAI API proxy port
   * Also serves as the health check endpoint for Docker healthcheck
   * @see containers/api-proxy/server.js
   */
  OPENAI: 10000,

  /**
   * Anthropic (Claude) API proxy port
   * @see containers/api-proxy/server.js
   */
  ANTHROPIC: 10001,

  /**
   * GitHub Copilot API proxy port
   * @see containers/api-proxy/server.js
   */
  COPILOT: 10002,

  /**
   * Google Gemini API proxy port
   * @see containers/api-proxy/server.js
   */
  GEMINI: 10003,

  /**
   * OpenCode API proxy port (defaults to Copilot/OpenAI routing; falls back to Anthropic)
   * OpenCode is BYOK — credential priority: OPENAI_API_KEY > ANTHROPIC_API_KEY > COPILOT_GITHUB_TOKEN/COPILOT_API_KEY
   * @see containers/api-proxy/server.js
   */
  OPENCODE: 10004,
} as const;

/**
 * Health check port for the API proxy sidecar
 * Always uses the OpenAI port (10000) for Docker healthcheck
 */
export const API_PROXY_HEALTH_PORT = API_PROXY_PORTS.OPENAI;

/**
 * Port for the CLI proxy sidecar HTTP server.
 *
 * The CLI proxy sidecar listens on this port for gh CLI invocations forwarded
 * from the agent container. Port 11000 is chosen to avoid collision with the
 * api-proxy ports (10000-10004).
 *
 * All ports must be allowed in:
 * - containers/cli-proxy/Dockerfile (EXPOSE directive)
 * - containers/agent/setup-iptables.sh (NAT rules)
 * @see containers/cli-proxy/server.js
 */
export const CLI_PROXY_PORT = 11000;

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
   * Additional environment variable names to exclude when using --env-all
   *
   * When `envAll` is true, these variable names are excluded from the host environment
   * passthrough in addition to the built-in exclusion list (PATH, HOME, etc.).
   * Has no effect when `envAll` is false.
   *
   * @example ['GITHUB_MCP_SERVER_TOKEN', 'GH_AW_GITHUB_TOKEN']
   */
  excludeEnv?: string[];

  /**
   * Path to a file containing environment variables to inject into the container
   *
   * The file should contain KEY=VALUE pairs, one per line. Lines starting with
   * '#' are treated as comments and ignored. Empty lines are also ignored.
   * Variables in the file are injected before `additionalEnv` (--env flags),
   * so explicit --env values take precedence.
   *
   * Excluded system variables (PATH, HOME, etc.) are never injected regardless
   * of whether they appear in the file.
   *
   * @example '/tmp/runtime-paths.env'
   */
  envFile?: string;

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
   *
   * @example ['/workspace:/workspace:ro', '/data:/data:rw']
   */
  volumeMounts?: string[];


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
   * Memory limit for the agent execution container
   *
   * Accepts Docker memory format: a positive integer followed by a unit suffix
   * (b, k, m, g). Controls the maximum amount of memory the container can use.
   *
   * @default '6g'
   * @example '4g'
   * @example '512m'
   */
  memoryLimit?: string;

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
   * Directory for firewall audit artifacts (configs, policy manifest, iptables state)
   *
   * When specified, audit artifacts are written directly to this directory
   * during execution. This is useful for CI/CD where you want a predictable
   * path for artifact upload.
   *
   * When not specified, audit artifacts are written to ${workDir}/audit/
   * during runtime and moved to /tmp/awf-audit-<timestamp> after cleanup.
   *
   * Artifacts include:
   * - squid.conf: The generated Squid proxy configuration
   * - docker-compose.redacted.yml: Container orchestration config (secrets redacted)
   * - policy-manifest.json: Structured description of all firewall rules
   * - iptables-audit.txt: Captured iptables state from the agent container
   *
   * Can be set via:
   * - CLI flag: `--audit-dir <path>`
   * - Environment variable: `AWF_AUDIT_DIR`
   *
   * @example '/tmp/gh-aw/sandbox/firewall/audit'
   */
  auditDir?: string;

  /**
   * Directory for agent session state (Copilot CLI events.jsonl, session data)
   *
   * When specified, the session-state volume is written directly to this
   * directory during execution, making it timeout-safe and available at a
   * predictable path for artifact upload.
   *
   * When not specified, session state is written to ${workDir}/agent-session-state
   * during runtime and moved to /tmp/awf-agent-session-state-<timestamp> after cleanup.
   *
   * Can be set via:
   * - CLI flag: `--session-state-dir <path>`
   * - Environment variable: `AWF_SESSION_STATE_DIR`
   *
   * @example '/tmp/gh-aw/sandbox/agent/session-state'
   */
  sessionStateDir?: string;

  /**
   * Enable diagnostic log collection on non-zero exit
   *
   * When true and AWF exits with a non-zero exit code, container stdout/stderr
   * logs, state metadata, and a sanitized docker-compose.yml are written to
   * `${workDir}/diagnostics/` before containers are stopped.  When `auditDir`
   * is also set the diagnostics are co-located there as `${auditDir}/diagnostics/`.
   *
   * Collected artifacts:
   * - `<container>.log`: stdout+stderr from `docker logs`
   * - `<container>.state`: exit code and error string from `docker inspect`
   * - `<container>.mounts.json`: volume mount info from `docker inspect`
   * - `docker-compose.yml`: generated compose file with TOKEN/KEY/SECRET values redacted
   *
   * Containers inspected: awf-squid, awf-agent, awf-api-proxy, awf-iptables-init.
   * Containers that never started (e.g. api-proxy when not enabled) are silently skipped.
   *
   * Off by default. Enable via `--diagnostic-logs` CLI flag or the
   * `features.awf-diagnostic-logs: true` workflow frontmatter key.
   *
   * @default false
   */
  diagnosticLogs?: boolean;

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
   * Enable Docker-in-Docker by exposing the host Docker socket
   *
   * When true, the host's Docker socket (/var/run/docker.sock) is mounted
   * into the agent container, allowing the agent to run Docker commands.
   *
   * WARNING: This allows the agent to bypass firewall restrictions by
   * spawning new containers without network restrictions.
   *
   * @default false
   */
  enableDind?: boolean;

  /**
   * Docker host (socket) to use for AWF's own container operations
   *
   * When set, overrides the `DOCKER_HOST` environment variable for all
   * docker CLI calls made by AWF itself (compose up/down, docker wait, etc.).
   *
   * Use this when you need to point AWF at a specific local Unix socket that
   * is not the system default (`/var/run/docker.sock`).
   *
   * When not set, AWF auto-detects the Docker host:
   * - If `DOCKER_HOST` is a Unix socket, it is used as-is.
   * - If `DOCKER_HOST` is a TCP address (e.g. a Docker-in-Docker (DinD) daemon),
   *   AWF clears it and falls back to the system default socket.
   *
   * The original `DOCKER_HOST` value (if any) is always forwarded into the
   * agent container so the agent workload can still reach the DinD daemon.
   *
   * @example 'unix:///var/run/docker.sock'
   * @example 'unix:///run/user/1000/docker.sock'
   */
  awfDockerHost?: string;

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
   * - http://api-proxy:10000 - OpenAI API proxy (for Codex) {@link API_PROXY_PORTS.OPENAI}
   * - http://api-proxy:10001 - Anthropic API proxy (for Claude) {@link API_PROXY_PORTS.ANTHROPIC}
   * - http://api-proxy:10002 - GitHub Copilot API proxy {@link API_PROXY_PORTS.COPILOT}
   * - http://api-proxy:10004 - OpenCode API proxy (defaults to Copilot/OpenAI routing) {@link API_PROXY_PORTS.OPENCODE}
   *
   * When the corresponding API key is provided, the following environment
   * variables are set in the agent container:
   * - OPENAI_BASE_URL=http://api-proxy:10000 (set when OPENAI_API_KEY is provided)
   * - ANTHROPIC_BASE_URL=http://api-proxy:10001 (set when ANTHROPIC_API_KEY is provided)
   * - COPILOT_API_URL=http://api-proxy:10002 (set when COPILOT_GITHUB_TOKEN or COPILOT_API_KEY is provided)
   * - CLAUDE_CODE_API_KEY_HELPER=/usr/local/bin/get-claude-key.sh (set when ANTHROPIC_API_KEY is provided)
   *
   * API keys are passed via environment variables:
   * - OPENAI_API_KEY - Optional OpenAI API key for Codex
   * - ANTHROPIC_API_KEY - Optional Anthropic API key for Claude
   * - COPILOT_GITHUB_TOKEN - Optional GitHub token for Copilot
   * - COPILOT_API_KEY - Optional direct Copilot API key (BYOK)
   *
   * @default false
   * @example
   * ```bash
   * # Enable API proxy with keys from environment
   * export OPENAI_API_KEY="sk-..."
   * export ANTHROPIC_API_KEY="sk-ant-..."
   * export COPILOT_GITHUB_TOKEN="ghp_..."
   * export COPILOT_API_KEY="your-copilot-api-key..."
   * awf --enable-api-proxy --allow-domains api.openai.com,api.anthropic.com,api.githubcopilot.com -- command
   * ```
   * @see API_PROXY_PORTS for port configuration
   */
  enableApiProxy?: boolean;

  /**
   * Rate limiting configuration for the API proxy sidecar
   *
   * Controls per-provider rate limits enforced by the API proxy before
   * requests are forwarded to upstream LLM APIs.
   *
   * @see RateLimitConfig
   */
  rateLimitConfig?: RateLimitConfig;

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
   * GitHub token for Copilot (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this token is injected into the Node.js sidecar
   * container and used to authenticate requests to api.githubcopilot.com.
   *
   * The token is NOT exposed to the agent container - only the proxy URL is provided.
   * The agent receives a placeholder value that is protected by the one-shot-token library.
   *
   * @default undefined
   */
  copilotGithubToken?: string;

  /**
   * Direct Copilot API key for BYOK (Bring Your Own Key) authentication
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to api.githubcopilot.com.
   *
   * This is an alternative to copilotGithubToken for direct API key authentication
   * (BYOK mode) without requiring GitHub OAuth token exchange.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   *
   * @default undefined
   */
  copilotApiKey?: string;

  /**
   * Google Gemini API key (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this key is injected into the Node.js sidecar
   * container and used to authenticate requests to generativelanguage.googleapis.com.
   *
   * The key is NOT exposed to the agent container - only the proxy URL is provided.
   * The agent receives a placeholder value so Gemini CLI's startup auth check passes.
   *
   * @default undefined
   */
  geminiApiKey?: string;

  /**
   * Enable the OpenCode API proxy listener on port 10004
   *
   * When true, the api-proxy sidecar starts the OpenCode listener (port 10004) that
   * dynamically routes requests to whichever LLM credential is available.
   * When false (the default), the listener is not started even if other API keys
   * are present, preventing unnecessary port exposure in workflows that do not use
   * the OpenCode engine.
   *
   * @default false
   */
  enableOpenCode?: boolean;

  /**
   * Target hostname for GitHub Copilot API requests (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this hostname is passed to the Node.js sidecar
   * as `COPILOT_API_TARGET`. The proxy will forward Copilot API requests to this host
   * instead of the default `api.githubcopilot.com`.
   *
   * Useful for GitHub Enterprise Server (GHES) deployments where the Copilot API
   * endpoint differs from the public default.
   *
   * Can be set via:
   * - CLI flag: `--copilot-api-target <host>`
   * - Environment variable: `COPILOT_API_TARGET`
   *
   * @default 'api.githubcopilot.com'
   * @example
   * ```bash
   * awf --enable-api-proxy --copilot-api-target api.github.mycompany.com -- command
   * ```
   */
  copilotApiTarget?: string;

  /**
   * Target hostname for OpenAI API requests (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this hostname is passed to the Node.js sidecar
   * as `OPENAI_API_TARGET`. The proxy will forward OpenAI API requests to this host
   * instead of the default `api.openai.com`.
   *
   * Useful for custom OpenAI-compatible endpoints (e.g., Azure OpenAI, internal
   * LLM routers, vLLM, TGI) where the API endpoint differs from the public default.
   *
   * Can be set via:
   * - CLI flag: `--openai-api-target <host>`
   * - Environment variable: `OPENAI_API_TARGET`
   *
   * @default 'api.openai.com'
   * @example
   * ```bash
   * awf --enable-api-proxy --openai-api-target llm-router.internal.example.com -- command
   * ```
   */
  openaiApiTarget?: string;

  /**
   * Base path prefix for OpenAI API requests (used by API proxy sidecar)
   *
   * When set, this path is prepended to every upstream request path so that
   * endpoints which require a URL prefix (e.g. Databricks serving endpoints,
   * Azure OpenAI deployments) work correctly.
   *
   * Can be set via:
   * - CLI flag: `--openai-api-base-path <path>`
   * - Environment variable: `OPENAI_API_BASE_PATH`
   *
   * @default ''
   * @example '/serving-endpoints'
   * @example '/openai/deployments/gpt-4'
   */
  openaiApiBasePath?: string;

  /**
   * Target hostname for Anthropic API requests (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this hostname is passed to the Node.js sidecar
   * as `ANTHROPIC_API_TARGET`. The proxy will forward Anthropic API requests to this host
   * instead of the default `api.anthropic.com`.
   *
   * Useful for custom Anthropic-compatible endpoints (e.g., internal LLM routers)
   * where the API endpoint differs from the public default.
   *
   * Can be set via:
   * - CLI flag: `--anthropic-api-target <host>`
   * - Environment variable: `ANTHROPIC_API_TARGET`
   *
   * @default 'api.anthropic.com'
   * @example
   * ```bash
   * awf --enable-api-proxy --anthropic-api-target llm-router.internal.example.com -- command
   * ```
   */
  anthropicApiTarget?: string;

  /**
   * Base path prefix for Anthropic API requests (used by API proxy sidecar)
   *
   * When set, this path is prepended to every upstream request path so that
   * endpoints which require a URL prefix work correctly.
   *
   * Can be set via:
   * - CLI flag: `--anthropic-api-base-path <path>`
   * - Environment variable: `ANTHROPIC_API_BASE_PATH`
   *
   * @default ''
   * @example '/anthropic'
   */
  anthropicApiBasePath?: string;

  /**
   * Target hostname for Google Gemini API requests (used by API proxy sidecar)
   *
   * When enableApiProxy is true, this hostname is passed to the Node.js sidecar
   * as `GEMINI_API_TARGET`. The proxy will forward Gemini API requests to this host
   * instead of the default `generativelanguage.googleapis.com`.
   *
   * Can be set via:
   * - CLI flag: `--gemini-api-target <host>`
   * - Environment variable: `GEMINI_API_TARGET`
   *
   * @default 'generativelanguage.googleapis.com'
   * @example
   * ```bash
   * awf --enable-api-proxy --gemini-api-target custom-gemini-endpoint.example.com -- command
   * ```
   */
  geminiApiTarget?: string;

  /**
   * Base path prefix for Google Gemini API requests (used by API proxy sidecar)
   *
   * When set, this path is prepended to every upstream request path so that
   * endpoints which require a URL prefix work correctly.
   *
   * Can be set via:
   * - CLI flag: `--gemini-api-base-path <path>`
   * - Environment variable: `GEMINI_API_BASE_PATH`
   *
   * @default ''
   */
  geminiApiBasePath?: string;

  /**
   * Model alias map for the API proxy sidecar
   *
   * When enableApiProxy is true and model aliases are configured, the proxy
   * intercepts POST/PUT/PATCH request bodies containing a "model" field and rewrites
   * the model name using the alias resolution chain before forwarding to upstream.
   *
   * Alias map format: each key is an alias name (or "" for the default policy),
   * and the value is an ordered list of candidates. Candidates can be:
   * - "provider/modelpattern" — match against available models for that provider
   *   using case-insensitive glob patterns (* wildcard)
   * - "alias-name" — recursively expand another alias (loop detection applies)
   *
   * Resolution picks the highest-version matching model (semver semantics).
   * Only models for the receiving provider's port are considered (e.g., the
   * Copilot proxy at port 10002 only matches "copilot/*" patterns).
   *
   * Set via the `apiProxy.models` section of the AWF config file.
   *
   * @example
   * ```json
   * {
   *   "sonnet": ["copilot/*sonnet*", "anthropic/*sonnet*"],
   *   "gpt-5-codex": ["copilot/gpt-5*-codex", "openai/gpt-5*-codex"],
   *   "": ["sonnet", "gpt-5-codex"]
   * }
   * ```
   */
  modelAliases?: Record<string, string[]>;

  /**
   * Enable Anthropic prompt-cache optimizations in the API proxy sidecar.
   *
   * When true, the Anthropic proxy (port 10001) automatically mutates every
   * POST /v1/messages request before forwarding it to api.anthropic.com:
   *
   * - Injects prompt-cache breakpoints on tools, system, messages[0], and the
   *   rolling tail where they are missing — reducing the uncached token count
   *   for repetitive content to near zero.
   * - Upgrades existing ephemeral cache TTLs from the implicit 5-minute default
   *   to 1 hour on stable content (tools, system, messages[0]); the rolling tail
   *   stays at the shorter TTL configured by `anthropicCacheTailTtl`.
   * - Adds the `anthropic-beta: extended-cache-ttl-2025-04-11` header required
   *   by the Anthropic API to honour 1h TTLs.
   * - Strips ANSI SGR escape sequences from message text and tool results so
   *   terminal output with colour codes caches cleanly.
   *
   * Requires `enableApiProxy: true`. Has no effect without an `ANTHROPIC_API_KEY`.
   *
   * Set via:
   * - CLI flag: `--anthropic-auto-cache`
   * - Config file: `apiProxy.anthropicAutoCache: true`
   *
   * @default false
   */
  anthropicAutoCache?: boolean;

  /**
   * TTL for the rolling-tail cache breakpoint when `anthropicAutoCache` is enabled.
   *
   * The rolling tail is the last cacheable block across all messages; it moves every
   * turn so a shorter TTL is more cost-effective than 1h (avoids paying the 2.0×
   * write multiplier for a breakpoint that will expire before reuse).
   *
   * - `"5m"` (default): 5-minute TTL. Suitable for interactive sessions with
   *   fast back-and-forth turns.
   * - `"1h"`: 1-hour TTL. Better for long-running agentic tasks where individual
   *   turns may take minutes.
   *
   * Only used when `anthropicAutoCache` is true.
   *
   * Set via:
   * - CLI flag: `--anthropic-cache-tail-ttl <5m|1h>`
   * - Config file: `apiProxy.anthropicCacheTailTtl: "1h"`
   *
   * @default "5m"
   */
  anthropicCacheTailTtl?: '5m' | '1h';

  /**
   * Enable CLI proxy sidecar for secure gh CLI access
   *
   * When true, deploys a CLI proxy sidecar container that:
   * - Routes gh CLI invocations through an external DIFC proxy (mcpg)
   * - The DIFC proxy enforces guard policies (min-integrity, repo restrictions)
   * - Generates audit logs via mcpg's JSONL output
   *
   * The agent container gets a /usr/local/bin/gh wrapper script that
   * forwards invocations to the CLI proxy sidecar at http://172.30.0.50:11000.
   *
   * The DIFC proxy (mcpg) is started externally by the gh-aw compiler on the
   * host. AWF only launches the cli-proxy container and connects it to the
   * external DIFC proxy via a TCP tunnel for TLS hostname matching.
   *
   * @example 'host.docker.internal:18443'
   */
  difcProxyHost?: string;

  /**
   * Path to the TLS CA certificate written by the external DIFC proxy.
   *
   * The DIFC proxy generates a self-signed TLS cert. This path points to
   * the CA cert on the host filesystem, which is bind-mounted into the
   * cli-proxy container for TLS verification.
   *
   * @example '/tmp/gh-aw/difc-proxy-tls/ca.crt'
   */
  difcProxyCaCert?: string;

  /**
   * GitHub token for the CLI proxy sidecar
   *
   * When difcProxyHost is set, GitHub tokens are excluded from the agent
   * container environment. The token is held by the external DIFC proxy.
   *
   * Read from GITHUB_TOKEN environment variable when not specified.
   *
   * @default undefined
   */
  githubToken?: string;

  /**
   * Enable Data Loss Prevention (DLP) scanning
   *
   * When true, Squid proxy will block outgoing requests that contain
   * credential-like patterns (API keys, tokens, secrets) in URLs.
   * This protects against accidental credential exfiltration via
   * query parameters, path segments, or encoded URL content.
   *
   * Detected patterns include: GitHub tokens (ghp_, gho_, ghs_, ghu_,
   * github_pat_), OpenAI keys (sk-), Anthropic keys (sk-ant-),
   * AWS access keys (AKIA), Google API keys (AIza), Slack tokens,
   * and generic credential patterns.
   *
   * @default false
   */
  enableDlp?: boolean;

  /**
   * Maximum time in minutes to allow the agent command to run
   *
   * When specified, the agent container is forcibly stopped after this many
   * minutes. Useful for large projects where builds or tests may exceed
   * default CI timeouts.
   *
   * When not specified, the agent runs indefinitely until the command completes
   * or the process is externally terminated.
   *
   * @default undefined (no timeout)
   * @example 30
   * @example 45
   */
  agentTimeout?: number;

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
 * Rate limiting configuration for the API proxy sidecar
 *
 * Controls per-provider rate limits enforced before requests reach upstream APIs.
 * All providers share the same limits but have independent counters.
 */
export interface RateLimitConfig {
  /** Whether rate limiting is enabled (default: true) */
  enabled: boolean;
  /** Max requests per minute per provider (default: 600 when enabled) */
  rpm: number;
  /** Max requests per hour per provider (default: 1000) */
  rph: number;
  /** Max request bytes per minute per provider (default: 52428800 = 50 MB) */
  bytesPm: number;
}
