# Usage Guide

## Command-Line Options

```
sudo awf [options] -- <command>

Options:
  --config <path>              Path to AWF JSON/YAML config file (use "-" to read from stdin)
  -d, --allow-domains <domains>  Comma-separated list of allowed domains. Supports wildcards and protocol prefixes:
                             - github.com: exact domain + subdomains (HTTP & HTTPS)
                             - *.github.com: any subdomain of github.com
                             - api-*.example.com: prefix wildcards
                             - https://secure.com: HTTPS only
                             - http://legacy.com: HTTP only
                             - localhost: auto-configure for local testing
  --allow-domains-file <path>  Path to file containing allowed domains (one per line or
                               comma-separated, supports # comments)
  --block-domains <domains>    Comma-separated list of blocked domains (takes precedence over allowed
                               domains). Supports wildcards.
  --block-domains-file <path>  Path to file containing blocked domains (one per line or
                               comma-separated, supports # comments)
  --log-level <level>          Log level: debug, info, warn, error (default: info)
  -k, --keep-containers        Keep containers running after command exits (default: false)
  --agent-timeout <minutes>    Maximum time in minutes for the agent command to run (default: no limit)
  --tty                        Allocate a pseudo-TTY for the container (required for interactive
                               tools like Claude Code) (default: false)
  --work-dir <dir>             Working directory for temporary files
  -b, --build-local            Build containers locally instead of using GHCR images (default: false)
  --agent-image <value>        Agent container image (default: "default")
                               Presets (pre-built, fast):
                                 default  - Minimal ubuntu:22.04 (~200MB)
                                 act      - GitHub Actions parity (~2GB)
                               Custom base images (requires --build-local):
                                 ubuntu:XX.XX
                                 ghcr.io/catthehacker/ubuntu:runner-XX.XX
                                 ghcr.io/catthehacker/ubuntu:full-XX.XX
  --image-registry <registry>  Container image registry (default: ghcr.io/github/gh-aw-firewall)
  --image-tag <tag>            Container image tag (default: latest)
                               Optional digest metadata:
                                 <tag>,squid=sha256:...,agent=sha256:...,agent-act=sha256:...,api-proxy=sha256:...,cli-proxy=sha256:...
                                 Supported digest metadata keys: squid, agent, agent-act, api-proxy, cli-proxy
                                 Image name varies by --agent-image preset:
                                   default → agent:<tag>
                                   act     → agent-act:<tag>
  --skip-pull                  Use local images without pulling from registry (requires images to be
                                pre-downloaded) (default: false)
  --docker-host <socket>       Docker socket for AWF's own containers (default: auto-detect from
                               DOCKER_HOST env). Example: unix:///run/user/1000/docker.sock
  -e, --env <KEY=VALUE>        Additional environment variables to pass to container (can be
                                specified multiple times)
  --env-all                    Pass all host environment variables to container (excludes system vars
                                like PATH) (default: false)
  --exclude-env <name>         Exclude a specific environment variable from --env-all passthrough
                               (can be specified multiple times)
  --env-file <path>            Read environment variables from a file (KEY=VALUE format, one per line)
  -v, --mount <host_path:container_path[:ro|rw]>  Volume mount (can be specified multiple times). Format:
                                host_path:container_path[:ro|rw]
  --container-workdir <dir>    Working directory inside the container (should match GITHUB_WORKSPACE
                               for path consistency)
  --dns-servers <servers>      Comma-separated list of trusted DNS servers. DNS traffic is ONLY
                               allowed to these servers (default: auto-detected from host resolvers,
                               falls back to 8.8.8.8,8.8.4.4)
  --upstream-proxy <url>       Upstream (corporate) proxy URL for Squid to chain through.
                               Auto-detected from host https_proxy/http_proxy if not set.
  --proxy-logs-dir <path>      Directory to save Squid proxy logs to (writes access.log directly to
                                this directory)
  --audit-dir <path>           Directory for firewall audit artifacts (configs, policy manifest,
                               iptables state)
  --session-state-dir <path>   Directory to save Copilot CLI session state (events.jsonl, session
                                data). Writes directly during execution (timeout-safe, predictable
                                path). Also configurable via AWF_SESSION_STATE_DIR env var.
  --enable-host-access         Enable access to host services via host.docker.internal. Security
                               warning: When combined with --allow-domains host.docker.internal,
                               containers can access ANY service on the host machine. (default: false)
  --allow-host-ports <ports>   Comma-separated list of ports or port ranges to allow when using
                                --enable-host-access. By default, only ports 80 and 443 are allowed.
                                Example: --allow-host-ports 3000 or --allow-host-ports 3000,8080 or
                                --allow-host-ports 3000-3010,8000-8090
  --allow-host-service-ports <ports> Comma-separated ports to allow ONLY to host gateway
                               (for GitHub Actions services). Auto-enables host access.
                               Example: --allow-host-service-ports 5432,6379
  --ssl-bump                   Enable SSL Bump for HTTPS content inspection (allows URL path
                                filtering for HTTPS) (default: false)
  --allow-urls <urls>          Comma-separated list of allowed URL patterns for HTTPS (requires --ssl-bump).
                               Supports wildcards: https://github.com/myorg/*
  --enable-api-proxy           Enable API proxy sidecar for holding authentication credentials.
                               Deploys a Node.js proxy that injects API keys securely.
                               Supports OpenAI (Codex) and Anthropic (Claude) APIs. (default: false)
  --copilot-api-target <host>  Target hostname for Copilot API requests
                               (default: api.githubcopilot.com)
  --openai-api-target <host>   Target hostname for OpenAI API requests (default: api.openai.com)
  --openai-api-base-path <path> Base path prefix for OpenAI API requests
  --anthropic-api-target <host> Target hostname for Anthropic API requests
                                (default: api.anthropic.com)
  --anthropic-api-base-path <path> Base path prefix for Anthropic API requests
  --gemini-api-target <host>   Target hostname for Gemini API requests
                               (default: generativelanguage.googleapis.com)
  --gemini-api-base-path <path> Base path prefix for Gemini API requests
  --rate-limit-rpm <n>         Max requests per minute per provider (requires --enable-api-proxy)
  --rate-limit-rph <n>         Max requests per hour per provider (requires --enable-api-proxy)
  --rate-limit-bytes-pm <n>    Max request bytes per minute per provider (requires --enable-api-proxy)
  --no-rate-limit              Disable rate limiting in the API proxy (requires --enable-api-proxy)
  --difc-proxy-host <host:port> Connect to an external DIFC proxy (Multi-Cloud Proxy Gateway, "mcpg")
                               and enable the CLI proxy sidecar for gh command routing
  --difc-proxy-ca-cert <path>  Path to TLS CA cert written by external DIFC proxy
  --ruleset-file <path>        YAML rule file for domain allowlisting (repeatable).
                                Schema: version: 1, rules: [{domain, subdomains}]
  --dns-over-https [url]       Enable DNS-over-HTTPS via sidecar proxy
                               (default: https://dns.google/dns-query)
  --memory-limit <limit>       Memory limit for the agent container (default: 6g)
                                Examples: 1g, 4g, 512m
  --enable-dind                Enable Docker-in-Docker by exposing host Docker socket.
                               WARNING: allows firewall bypass via docker run (default: false)
  --enable-dlp                 Enable DLP (Data Loss Prevention) scanning to block credential
                                exfiltration in outbound request URLs. (default: false)
  --diagnostic-logs            Collect container logs, exit state, and sanitized config on non-zero
                               exit. Written to <workDir>/diagnostics/ (or <audit-dir>/diagnostics/)
  -V, --version                Output the version number
  -h, --help                   Display help for command

Arguments:
  command                      Command to execute (wrap in quotes, use -- separator)

Commands:
  predownload [options]        Pre-download Docker images for offline use or faster startup
    --image-registry <registry> Container image registry (default: ghcr.io/github/gh-aw-firewall)
    --image-tag <tag>          Container image tag (default: latest)
    --agent-image <value>      Agent image preset (default, act) or custom image
    --enable-api-proxy         Also download the API proxy image
    --difc-proxy               Also download the CLI proxy image (for --difc-proxy-host)

  logs [options]               View and analyze Squid proxy logs
    -f, --follow               Follow log output in real-time (like tail -f)
    --format <format>          Output format: raw, pretty (colorized), json
    --source <path>            Path to log directory or "running" for live container
    --list                     List available log sources
    --with-pid                 Enrich logs with PID/process info (requires -f)
  
  logs stats [options]         Show aggregated statistics from firewall logs
    --format <format>          Output format: json, markdown, pretty
    --source <path>            Path to log directory or "running" for live container
  
  logs summary [options]       Generate summary report (markdown by default)
    --format <format>          Output format: json, markdown, pretty
    --source <path>            Path to log directory or "running" for live container

  logs audit [options]         Show firewall audit with policy rule matching
    --format <format>          Output format: json, markdown, pretty
    --source <path>            Path to log directory or "running" for live container
    --rule <id>                Filter to specific rule ID
    --domain <domain>          Filter to specific domain
    --decision <decision>      Filter to "allowed" or "denied"
```

## Basic Examples

### Simple HTTP Request

```bash
sudo awf \
  --allow-domains github.com,api.github.com \
  'curl https://api.github.com'
```

### Playwright Testing Localhost

Test local web applications with Playwright without complex configuration:

```bash
# Start your dev server (e.g., npm run dev on port 3000)
# Then run Playwright tests through the firewall:
sudo awf \
  --allow-domains localhost,playwright.dev \
  'npx playwright test'
```

The `localhost` keyword automatically:
- Enables access to host services via `host.docker.internal`
- Allows common development ports (3000, 4200, 5173, 8080, etc.)
- Works with both HTTP and HTTPS protocols

You can customize the ports with `--allow-host-ports`:
```bash
sudo awf \
  --allow-domains localhost \
  --allow-host-ports 3000,8080 \
  'npx playwright test'
```

### With GitHub Copilot CLI

```bash
sudo awf \
  --allow-domains github.com,api.github.com,githubusercontent.com,anthropic.com \
  'copilot --prompt "List my repositories"'
```

### With MCP Servers

```bash
sudo awf \
  --allow-domains github.com,arxiv.org,mcp.tavily.com \
  --log-level debug \
  'copilot --mcp arxiv,tavily --prompt "Search arxiv for recent AI papers"'
```

## Command Passing with Environment Variables

AWF preserves shell variables for expansion inside the container, making it compatible with GitHub Actions and other CI/CD environments.

### Single Argument (Recommended for Complex Commands)

Quote your entire command to preserve shell syntax and variables:

```bash
# Variables expand inside the container
sudo awf --allow-domains github.com -- 'echo $HOME && pwd'
```

Variables like `$HOME`, `$USER`, `$PWD` will expand inside the container, not on your host machine. This is **critical** for commands that need to reference the container environment.

### Multiple Arguments (Simple Commands)

For simple commands without variables or special shell syntax:

```bash
# Each argument is automatically shell-escaped
sudo awf --allow-domains github.com -- curl -H "Authorization: Bearer token" https://api.github.com
```

### GitHub Actions Usage

Environment variables work correctly when using the single-argument format:

```yaml
- name: Run with environment variables
  run: |
    sudo -E awf --allow-domains github.com -- 'cd $GITHUB_WORKSPACE && npm test'
```

**Why this works:**
- GitHub Actions expands `${{ }}` syntax before the shell sees it
- Shell variables like `$GITHUB_WORKSPACE` are preserved literally
- These variables then expand inside the container with correct values

**Important:** Do NOT use multi-argument format with variables:
```bash
# ❌ Wrong: Variables won't expand correctly
sudo awf -- echo $HOME  # Shell expands $HOME on host first

# ✅ Correct: Single-quoted preserves for container
sudo awf -- 'echo $HOME'  # Expands to container home
```

## Domain Whitelisting

### Subdomain Matching

Domains automatically match all subdomains:

```bash
# github.com matches api.github.com, raw.githubusercontent.com, etc.
sudo awf --allow-domains github.com "curl https://api.github.com"  # ✓ works
```

### Wildcard Patterns

You can use wildcard patterns with `*` to match multiple domains:

```bash
# Match any subdomain of github.com
--allow-domains '*.github.com'

# Match api-v1.example.com, api-v2.example.com, etc.
--allow-domains 'api-*.example.com'

# Combine plain domains and wildcards
--allow-domains 'github.com,*.googleapis.com,api-*.example.com'
```

**Pattern rules:**
- `*` matches any characters (converted to regex `.*`)
- Patterns are case-insensitive (DNS is case-insensitive)
- Overly broad patterns like `*`, `*.*`, or `*.*.*` are rejected for security
- Use quotes around patterns to prevent shell expansion

**Examples:**
| Pattern | Matches | Does Not Match |
|---------|---------|----------------|
| `*.github.com` | `api.github.com`, `raw.github.com` | `github.com` |
| `api-*.example.com` | `api-v1.example.com`, `api-test.example.com` | `api.example.com` |
| `github.com` | `github.com`, `api.github.com` | `notgithub.com` |

### Multiple Domains

```bash
sudo awf --allow-domains github.com,arxiv.org "curl https://api.github.com"
```

### Normalization

Domains are case-insensitive, spaces/trailing dots are trimmed:

```bash
# These are equivalent
--allow-domains github.com
--allow-domains " GitHub.COM. "
```

### Example Domain Lists

For GitHub Copilot with GitHub API:
```bash
--allow-domains github.com,api.github.com,githubusercontent.com,githubassets.com
```

For MCP servers:
```bash
--allow-domains \
  github.com,\
  arxiv.org,\
  mcp.context7.com,\
  mcp.tavily.com,\
  learn.microsoft.com,\
  mcp.deepwiki.com
```

## Domain Blocklist

You can explicitly block specific domains using `--block-domains` and `--block-domains-file`. **Blocked domains take precedence over allowed domains**, enabling fine-grained control.

### Basic Blocklist Usage

```bash
# Allow example.com but block internal.example.com
sudo awf \
  --allow-domains example.com \
  --block-domains internal.example.com \
  -- curl https://api.example.com  # ✓ works

sudo awf \
  --allow-domains example.com \
  --block-domains internal.example.com \
  -- curl https://internal.example.com  # ✗ blocked
```

### Blocklist with Wildcards

```bash
# Allow all of example.com except any subdomain starting with "internal-"
sudo awf \
  --allow-domains example.com \
  --block-domains 'internal-*.example.com' \
  -- curl https://api.example.com  # ✓ works

# Block all subdomains matching the pattern
sudo awf \
  --allow-domains '*.example.com' \
  --block-domains '*.secret.example.com' \
  -- curl https://api.example.com  # ✓ works
```

### Using a Blocklist File

```bash
# Create a blocklist file
cat > blocked-domains.txt << 'EOF'
# Internal services that should never be accessed
internal.example.com
admin.example.com

# Block all subdomains of sensitive.org
*.sensitive.org
EOF

# Use the blocklist file
sudo awf \
  --allow-domains example.com,sensitive.org \
  --block-domains-file blocked-domains.txt \
  -- curl https://api.example.com
```

**Combining flags:**
```bash
# You can combine all domain flags
sudo awf \
  --allow-domains github.com \
  --allow-domains-file allowed.txt \
  --block-domains internal.github.com \
  --block-domains-file blocked.txt \
  -- your-command
```

**Use cases:**
- Allow a broad domain (e.g., `*.example.com`) but block specific sensitive subdomains
- Block known bad domains while allowing a curated list
- Prevent access to internal services from AI agents

## Host Access (MCP Gateways)

When running MCP gateways or other services on your host machine that need to be accessible from inside the firewall, use the `--enable-host-access` flag.

### Enabling Host Access

```bash
# Enable access to services running on the host via host.docker.internal
sudo awf \
  --enable-host-access \
  --allow-domains host.docker.internal \
  -- curl http://host.docker.internal:8080
```

### Security Considerations

> ⚠️ **Security Warning**: When `--enable-host-access` is enabled, containers can currently access ANY port on services running on the host machine via `host.docker.internal`. This includes databases, admin panels, and other sensitive services.
>
> **Port restrictions:** Use `--allow-host-ports` to explicitly restrict which ports can be accessed (e.g., `--allow-host-ports 80,443,8080`). A future update will make port restrictions the default behavior.
>
> Only enable this for trusted workloads like MCP gateways or local testing with Playwright.

**Why opt-in?** By default, `host.docker.internal` hostname resolution is disabled to prevent containers from accessing host services. This is a defense-in-depth measure against malicious code attempting to access local resources.

### Example: MCP Gateway on Host

```bash
# Start your MCP gateway on the host (port 8080)
./my-mcp-gateway --port 8080 &

# Run awf with host access enabled and custom port
sudo awf \
  --enable-host-access \
  --allow-host-ports 8080 \
  --allow-domains host.docker.internal,api.github.com \
  -- 'copilot --mcp-gateway http://host.docker.internal:8080 --prompt "test"'
```

**Note:** When `--enable-host-access` is enabled without `--allow-host-ports`, all ports on `host.docker.internal` are currently allowed. Use `--allow-host-ports` to explicitly restrict which ports can be accessed (e.g., `--allow-host-ports 80,443,8080` for web services and an MCP gateway).

> **Security Note:** A future update will change the default behavior to only allow ports 80 and 443 unless `--allow-host-ports` is specified. Explicitly set `--allow-host-ports` now to ensure consistent behavior across versions.

### CONNECT Method on Port 80

The firewall allows the HTTP CONNECT method on both ports 80 and 443. This is required because some HTTP clients (e.g., Node.js fetch) use the CONNECT method even for HTTP connections when going through a proxy. Domain ACLs remain the primary security control.

## SSL Bump (HTTPS Content Inspection)

By default, awf filters HTTPS traffic based on domain names only (using SNI). Enable SSL Bump to filter by URL path.

### Enabling SSL Bump

```bash
sudo awf \
  --allow-domains github.com \
  --ssl-bump \
  --allow-urls "https://github.com/myorg/*" \
  'curl https://github.com/myorg/some-repo'
```

### URL Pattern Syntax

URL patterns support wildcards:

```bash
# Match any path under an organization
--allow-urls "https://github.com/myorg/*"

# Match specific API endpoints
--allow-urls "https://api.github.com/repos/*,https://api.github.com/users/*"

# Multiple patterns (comma-separated)
--allow-urls "https://github.com/org1/*,https://github.com/org2/*"
```

### How It Works

When `--ssl-bump` is enabled:

1. A per-session CA certificate is generated (valid for 1 day)
2. The CA is injected into the agent container's trust store
3. Squid intercepts HTTPS connections to inspect full URLs
4. Requests are matched against `--allow-urls` patterns

### Security Note

SSL Bump requires intercepting HTTPS traffic:

- The session CA is unique to each execution
- CA private key exists only in the temporary work directory
- Short certificate validity (1 day) limits exposure
- Traffic is re-encrypted between proxy and destination

For more details, see [SSL Bump documentation](ssl-bump.md).

## API Proxy Sidecar

The `--enable-api-proxy` flag deploys a Node.js proxy sidecar that securely holds LLM API credentials and automatically injects authentication headers. This keeps API keys isolated from the agent container.

```bash
# Enable the API proxy sidecar (reads keys from environment)
sudo awf \
  --allow-domains api.openai.com,api.anthropic.com \
  --enable-api-proxy \
  -- your-agent-command
```

When enabled, the proxy:
- Isolates API keys from the agent container (keys never enter the agent environment)
- Automatically injects Bearer tokens for OpenAI and Anthropic APIs
- Routes all traffic through Squid to respect domain whitelisting

Rate limiting is available with the API proxy:
```bash
sudo awf \
  --allow-domains api.openai.com \
  --enable-api-proxy \
  --rate-limit-rpm 60 \
  --rate-limit-rph 1000 \
  -- your-agent-command
```

For detailed architecture, credential flow, and configuration, see [API Proxy Sidecar](api-proxy-sidecar.md).

## Agent Image

The `--agent-image` flag controls which agent container image to use. It supports two presets for quick startup, or custom base images for advanced use cases.

### Presets (Pre-built, Fast Startup)

| Preset | GHCR Image | Base | Size | Use Case |
|--------|------------|------|------|----------|
| `default` | `agent:latest` | `ubuntu:22.04` | ~200MB | Minimal, fast startup |
| `act` | `agent-act:latest` | `catthehacker/ubuntu:act-24.04` | ~2GB | GitHub Actions parity |

```bash
# Use default preset (minimal image, fastest startup)
sudo awf --allow-domains github.com -- your-command

# Explicitly specify default
sudo awf --agent-image default --allow-domains github.com -- your-command

# Use act preset for GitHub Actions parity
sudo awf --agent-image act --allow-domains github.com -- your-command
```

### Custom Base Images (Requires --build-local)

For advanced use cases, you can specify a custom base image. This requires `--build-local` since it customizes the container build:

| Image | Size | Description |
|-------|------|-------------|
| `ubuntu:XX.XX` | ~200MB | Official Ubuntu image |
| `ghcr.io/catthehacker/ubuntu:runner-XX.XX` | ~2-5GB | Medium image with common tools |
| `ghcr.io/catthehacker/ubuntu:full-XX.XX` | ~20GB | Near-identical to GitHub Actions runner |

```bash
# Use custom runner image (requires --build-local)
sudo awf \
  --build-local \
  --agent-image ghcr.io/catthehacker/ubuntu:runner-22.04 \
  --allow-domains github.com \
  -- your-command

# Use full image for maximum parity (large download, ~20GB)
sudo awf \
  --build-local \
  --agent-image ghcr.io/catthehacker/ubuntu:full-22.04 \
  --allow-domains github.com \
  -- your-command
```

**Error handling:** Using a custom image without `--build-local` will result in an error:
```
❌ Custom agent images require --build-local flag
   Example: awf --build-local --agent-image ghcr.io/catthehacker/ubuntu:runner-22.04 ...
```

### When to Use Each Option

**Use `default` preset when:**
- Fast startup time is important
- Minimal container size is preferred
- Your commands only need basic tools (curl, git, Node.js, Docker CLI)

**Use `act` preset when:**
- You need GitHub Actions parity without building locally
- Fast startup is still important
- You trust the pre-built GHCR image

**Use custom base images with `--build-local` when:**
- You need specific runner variants (runner-22.04, full-22.04)
- You want to pin to a specific digest for reproducibility
- You need maximum control over the base image

### Security Considerations

**⚠️ IMPORTANT:** Custom base images introduce supply chain risk. When using third-party images:

1. **Verify image sources** - Only use images from trusted publishers. The `catthehacker` images are community-maintained and not officially supported by GitHub.

2. **Review image contents** - Understand what tools and configurations are included. Third-party images may contain pre-installed software that could behave unexpectedly.

3. **Pin specific versions** - Use image digests (e.g., `@sha256:...`) instead of mutable tags to prevent tag manipulation:
   ```bash
   --agent-image ghcr.io/catthehacker/ubuntu:runner-22.04@sha256:abc123...
   ```

4. **Monitor for vulnerabilities** - Third-party images may not receive timely security updates compared to official images.

**Existing security controls remain in effect:**
- Host-level iptables (DOCKER-USER chain) enforce egress filtering regardless of container contents
- Squid proxy enforces domain allowlist at L7
- NET_ADMIN capability is dropped before user command execution
- Seccomp profile blocks dangerous syscalls
- `no-new-privileges` prevents privilege escalation

**For maximum security, use the `default` preset.** Custom base images are recommended only when you trust the image publisher and the benefits outweigh the supply chain risks.

### Pre-installed Tools

The default `ubuntu:22.04` image includes:
- Node.js 22
- Docker CLI
- curl, git, iptables
- CA certificates
- Network utilities (dnsutils, net-tools, netcat)

When using runner/full images or the `act` preset, you get additional tools like:
- Multiple Python, Node.js, Go, Ruby versions
- Build tools (make, cmake, gcc)
- AWS CLI, Azure CLI, GitHub CLI
- Container tools (docker, buildx)
- And many more (see [catthehacker/docker_images](https://github.com/catthehacker/docker_images))

For complete tool listings with versions, see [Agent Image Tools Reference](/gh-aw-firewall/reference/agent-images/).

### Notes

- Presets (`default`, `act`) use pre-built GHCR images for fast startup
- Custom base images require `--build-local` and build time on first use
- First build with a new base image will take longer (downloading the image)
- Subsequent builds use Docker cache and are faster
- The `full-XX.XX` images require significant disk space (~60GB extracted)

## Using Pre-Downloaded Images

For offline environments, air-gapped systems, or CI pipelines with image caching, you can use the `--skip-pull` flag to prevent awf from pulling images from the registry. This requires images to be pre-downloaded locally.

### Basic Usage

```bash
# Pre-download images first
docker pull ghcr.io/github/gh-aw-firewall/squid:latest
docker pull ghcr.io/github/gh-aw-firewall/agent:latest

# Use pre-downloaded images without pulling
sudo awf --skip-pull --allow-domains github.com -- curl https://api.github.com
```

### Use Cases

**Offline/Air-Gapped Environments:**
```bash
# Download images on a connected machine
docker pull ghcr.io/github/gh-aw-firewall/squid:latest
docker pull ghcr.io/github/gh-aw-firewall/agent:latest
docker save ghcr.io/github/gh-aw-firewall/squid:latest > squid.tar
docker save ghcr.io/github/gh-aw-firewall/agent:latest > agent.tar

# Transfer tar files to air-gapped system, then:
docker load < squid.tar
docker load < agent.tar

# Run without network access to registry
sudo awf --skip-pull --allow-domains github.com -- your-command
```

**CI Pipeline Image Caching:**
```yaml
# GitHub Actions example
- name: Cache Docker images
  uses: actions/cache@v4
  with:
    path: /var/lib/docker
    key: docker-images-${{ hashFiles('**/Dockerfile') }}

- name: Pre-pull images (only if cache miss)
  if: steps.cache.outputs.cache-hit != 'true'
  run: |
    docker pull ghcr.io/github/gh-aw-firewall/squid:latest
    docker pull ghcr.io/github/gh-aw-firewall/agent:latest

- name: Run awf with cached images
  run: |
    sudo awf --skip-pull --allow-domains github.com -- your-command
```

**Using Specific Versions:**
```bash
# Pre-download specific version
docker pull ghcr.io/github/gh-aw-firewall/squid:latest
docker pull ghcr.io/github/gh-aw-firewall/agent:latest

# Or pin to a specific version
docker pull ghcr.io/github/gh-aw-firewall/squid:v0.16.2
docker pull ghcr.io/github/gh-aw-firewall/agent:v0.16.2

# Tag a specific version as latest for awf to use
docker tag ghcr.io/github/gh-aw-firewall/squid:v0.16.2 ghcr.io/github/gh-aw-firewall/squid:latest
docker tag ghcr.io/github/gh-aw-firewall/agent:v0.16.2 ghcr.io/github/gh-aw-firewall/agent:latest

# Use with --skip-pull
sudo awf --skip-pull --allow-domains github.com -- your-command
```

### Important Notes

- **Images must be pre-downloaded**: Using `--skip-pull` without having the required images will cause Docker to fail
- **Version compatibility**: Ensure pre-downloaded image versions match the awf version you're using
- **Not compatible with --build-local**: The `--skip-pull` flag cannot be used with `--build-local` since building requires pulling base images
- **Default images only**: This works with preset images (`default`, `act`). Custom base images require `--build-local` and cannot use `--skip-pull`

### Error Handling

If images are not available locally when using `--skip-pull`, you'll see an error like:
```
Error: unable to find image 'ghcr.io/github/gh-aw-firewall/agent:latest' locally
```

To fix this, remove `--skip-pull` to allow automatic pulling, or pre-download the images first.

## Chroot Mode

AWF always runs in chroot mode, providing transparent access to host binaries (Python, Node.js, Go, etc.) while maintaining network isolation. This is especially useful for GitHub Actions runners with pre-installed tools.

```bash
# Use host binaries with network isolation
sudo awf --allow-domains api.github.com \
  -- python3 -c "import requests; print(requests.get('https://api.github.com').status_code)"

# Combine with --env-all for environment variables
sudo awf --env-all --allow-domains api.github.com \
  -- bash -c 'echo "Home: $HOME, User: $USER"'
```

For detailed documentation including security considerations, volume mounts, and troubleshooting, see [Chroot Mode](chroot-mode.md).

## Flag Combinations and Constraints

Certain flags have validation constraints that produce errors if violated.

### `--skip-pull` + `--build-local` = Error

These flags are incompatible. `--skip-pull` uses pre-downloaded images without pulling, while `--build-local` builds images from source (which requires pulling base images).

```bash
# ❌ Error: incompatible flags
sudo awf --skip-pull --build-local --allow-domains github.com -- your-command
# Error: --skip-pull cannot be used with --build-local. Building images requires pulling base images from the registry.

# ✅ Correct: use one or the other
sudo awf --skip-pull --allow-domains github.com -- your-command
sudo awf --build-local --allow-domains github.com -- your-command
```

### `--allow-host-ports` requires `--enable-host-access`

The `--allow-host-ports` flag restricts which host ports are accessible, so it only makes sense when host access is enabled.

```bash
# ❌ Error: missing dependency flag
sudo awf --allow-host-ports 3000,8080 --allow-domains github.com -- your-command
# Error: --allow-host-ports requires --enable-host-access to be set

# ✅ Correct: include --enable-host-access
sudo awf --enable-host-access --allow-host-ports 3000,8080 --allow-domains github.com -- your-command
```

## Limitations

### No Internationalized Domains

Use punycode instead:

```bash
--allow-domains bücher.ch              # ✗ fails
--allow-domains xn--bcher-kva.ch       # ✓ works
"curl https://xn--bcher-kva.ch"        # use punycode in URL too
```

### HTTP→HTTPS Redirects

Redirects from HTTP to HTTPS may fail:

```bash
# May return 400 (redirect from http to https)
sudo awf --allow-domains github.com "curl -fL http://github.com"

# Use HTTPS directly instead
sudo awf --allow-domains github.com "curl -fL https://github.com"  # ✓ works
```

### HTTP/3 Not Supported

```bash
# Container's curl doesn't support HTTP/3
sudo awf --allow-domains github.com "curl --http3 https://api.github.com"  # ✗ fails

# Use HTTP/1.1 or HTTP/2 instead
sudo awf --allow-domains github.com "curl https://api.github.com"  # ✓ works
```

### IPv6 Not Supported

```bash
# IPv6 traffic not configured
sudo awf --allow-domains github.com "curl -6 https://api.github.com"  # ✗ fails

# Use IPv4 (default)
sudo awf --allow-domains github.com "curl https://api.github.com"  # ✓ works
```

### Limited Tooling in Container

```bash
# wscat not installed in container
sudo awf --allow-domains echo.websocket.events "wscat -c wss://echo.websocket.events"  # ✗ fails

# Install tools first or use available ones (curl, git, nodejs, npm)
sudo awf --allow-domains github.com "npm install -g wscat && wscat -c wss://echo.websocket.events"
```

### Workflow-Scope DinD Incompatibility

Setting `DOCKER_HOST` to an external TCP daemon (e.g. a DinD service container) at
**workflow scope** is incompatible with AWF and will be rejected at startup with an
error like:

```
❌ DOCKER_HOST is set to an external daemon (tcp://localhost:2375). AWF requires the
local Docker daemon (default socket). Workflow-scope DinD is incompatible with AWF's
network isolation model.
```

**Why it is incompatible:**

AWF manages its own Docker network (`172.30.0.0/24`) and iptables NAT rules that must
run on the host runner's network namespace.  When `DOCKER_HOST` points at a DinD TCP
daemon, `docker compose` routes all container creation through that daemon's isolated
network namespace, which breaks:

- AWF's fixed subnet routing (the subnet is inside the DinD namespace, unreachable from the runner)
- The iptables DNAT rules configured by `awf-iptables-init` (they run in the wrong namespace)
- Port-binding expectations used for container-to-container communication

**Workaround:**

If the agent command itself needs to run Docker, use `--enable-dind` to mount the host
Docker socket into the agent container rather than configuring DinD at workflow scope:

```bash
# ✓ Use --enable-dind to allow docker commands inside the agent
sudo awf --enable-dind --allow-domains registry-1.docker.io -- docker run hello-world
```

> **⚠️ Security warning:** `--enable-dind` allows the agent to bypass firewall
> restrictions by spawning containers that are not subject to the firewall's network
> rules.  Only enable it for trusted workloads that genuinely need Docker access.

## IP-Based Access

Direct IP access (without domain names) is blocked:

```bash
# ✓ Cloud metadata services blocked
sudo awf --allow-domains github.com "curl -f http://169.254.169.254"
# Returns 400 Bad Request (blocked as expected)
```

## Debugging

### Enable Debug Logging

```bash
sudo awf \
  --allow-domains github.com \
  --log-level debug \
  'your-command'
```

This will show:
- Squid configuration generation
- Docker container startup logs (streamed in real-time)
- iptables rules applied
- Network connectivity tests
- Proxy traffic logs

### Real-Time Log Streaming

Container logs are streamed in real-time, allowing you to see output as commands execute:

```bash
sudo awf \
  --allow-domains github.com \
  "npx @github/copilot@0.0.347 -p 'your prompt' --allow-all-tools"
# Logs appear immediately as command runs, not after completion
```

### Log Preservation

Both GitHub Copilot CLI and Squid proxy logs are automatically preserved for debugging:

```bash
# Logs automatically saved after command completes
sudo awf \
  --allow-domains github.com,api.enterprise.githubcopilot.com \
  "npx @github/copilot@0.0.347 -p 'your prompt' --log-level debug --allow-all-tools"

# Output:
# [INFO] Agent logs preserved at: /tmp/awf-agent-logs-<timestamp>
# [INFO] Squid logs preserved at: /tmp/squid-logs-<timestamp>
```

**Agent Logs:**
- Contains GitHub Copilot CLI debug output and session information
- Location: `/tmp/awf-agent-logs-<timestamp>/`
- View with: `cat /tmp/awf-agent-logs-<timestamp>/*.log`

**Agent Session State:**
- Contains structured conversation data written by Copilot CLI (e.g., `events.jsonl`)
- Default location: `/tmp/awf-agent-session-state-<timestamp>/`
- View with: `cat /tmp/awf-agent-session-state-<timestamp>/events.jsonl`
- Useful for triage dashboards, benchmarking, and debugging Copilot CLI runs
- Use `--session-state-dir <path>` (or `AWF_SESSION_STATE_DIR`) to write session state to a
  predictable path during execution — ideal for artifact upload in GitHub Actions where the
  runner may time out before cleanup completes

**Squid Logs:**
- Contains all HTTP/HTTPS traffic (allowed and denied)
- Location: `/tmp/squid-logs-<timestamp>/`
- Requires sudo: `sudo cat /tmp/squid-logs-<timestamp>/access.log`

```bash
# Check which domains were blocked
sudo grep "TCP_DENIED" /tmp/squid-logs-<timestamp>/access.log

# View all traffic
sudo cat /tmp/squid-logs-<timestamp>/access.log
```

**How it works:**
- GitHub Copilot CLI writes to `~/.copilot/logs/` and `~/.copilot/session-state/`; Squid writes to `/var/log/squid/`
- Volume mounts map container paths to:
  - `${workDir}/agent-logs/` → `~/.copilot/logs/`
  - `${workDir}/agent-session-state/` → `~/.copilot/session-state/`
  - `${workDir}/squid-logs/` → `/var/log/squid/`
- Before cleanup, non-empty directories are automatically moved to timestamped `/tmp` paths:
  - `/tmp/awf-agent-logs-<timestamp>/`
  - `/tmp/awf-agent-session-state-<timestamp>/`
  - `/tmp/squid-logs-<timestamp>/`
- Empty log directories are not preserved (avoids cluttering /tmp)

### Keep Containers for Inspection

```bash
sudo awf \
  --allow-domains github.com \
  --keep-containers \
  'your-command'

# View real-time container logs:
docker logs awf-agent
docker logs awf-squid

# Access preserved logs at:
# /tmp/awf-<timestamp>/agent-logs/
# /tmp/awf-<timestamp>/squid-logs/
```

## Viewing Logs with `awf logs`

The `awf logs` command provides an easy way to view Squid proxy logs from current or previous runs.

### Basic Usage

```bash
# View recent logs with pretty formatting (default)
awf logs

# Follow logs in real-time (like tail -f)
awf logs -f
```

### Output Formats

The command supports three output formats:

```bash
# Pretty: colorized, human-readable output (default)
awf logs --format pretty

# Raw: logs as-is without parsing or colorization
awf logs --format raw

# JSON: structured output for programmatic consumption
awf logs --format json
```

Example JSON output:
```json
{"timestamp":1760987995.318,"clientIp":"172.20.98.20","clientPort":"55960","domain":"example.com","destIp":"-","destPort":"-","httpVersion":"1.1","method":"CONNECT","statusCode":403,"decision":"TCP_DENIED:HIER_NONE","url":"example.com:443","userAgent":"curl/7.81.0","isAllowed":false}
```

### Log Source Discovery

The command auto-discovers log sources in this order:
1. Running `awf-squid` container (live logs)
2. `AWF_LOGS_DIR` environment variable (if set)
3. Preserved log directories in `/tmp/squid-logs-<timestamp>`

```bash
# List all available log sources
awf logs --list

# Output example:
# Available log sources:
#   [running] awf-squid (live container)
#   [preserved] /tmp/squid-logs-1760987995318 (11/27/2024, 12:30:00 PM)
#   [preserved] /tmp/squid-logs-1760987890000 (11/27/2024, 12:28:10 PM)
```

### Using Specific Log Sources

```bash
# Stream from a running container
awf logs --source running -f

# Use a specific preserved log directory
awf logs --source /tmp/squid-logs-1760987995318

# Use logs from AWF_LOGS_DIR
export AWF_LOGS_DIR=/path/to/logs
awf logs
```

### Combining Options

```bash
# Follow live logs in JSON format
awf logs -f --format json

# View specific logs in raw format
awf logs --source /tmp/squid-logs-1760987995318 --format raw
```

### PID/Process Tracking

Correlate network requests with the specific processes that made them using the `--with-pid` flag. This enables security auditing and forensic analysis.

```bash
# Follow logs with PID tracking (requires -f for real-time mode)
awf logs -f --with-pid
```

**Pretty format output with PID:**
```
[2024-01-01 12:00:00.123] CONNECT api.github.com → 200 (ALLOWED) [curl/7.88.1] <PID:12345 curl>
```

**JSON format includes additional PID fields:**
```json
{
  "timestamp": 1703001234.567,
  "domain": "github.com",
  "statusCode": 200,
  "isAllowed": true,
  "pid": 12345,
  "cmdline": "curl https://github.com",
  "comm": "curl",
  "inode": "123456"
}
```

**Important limitations:**
- **Real-time only**: `--with-pid` requires `-f` (follow mode) because PID tracking reads the live `/proc` filesystem
- **Linux only**: PID tracking requires the `/proc` filesystem (standard on Linux)
- **Process must be running**: By the time historical logs are viewed, processes may have exited

**Use cases:**
- **Security auditing**: Identify which command or tool made each request
- **Incident response**: Trace suspicious network activity to specific processes
- **Debugging**: Correlate MCP server or tool behavior with network requests

### Troubleshooting with Logs

**Find blocked requests:**
```bash
awf logs --format json | jq 'select(.isAllowed == false)'
```

**Filter by domain:**
```bash
awf logs --format json | jq 'select(.domain | contains("github"))'
```

**Count blocked vs allowed:**
```bash
awf logs --format json | jq -s 'group_by(.isAllowed) | map({allowed: .[0].isAllowed, count: length})'
```

## Log Analysis

### Using `awf logs stats`

Get aggregated statistics from firewall logs including total requests, allowed/denied counts, and per-domain breakdown:

```bash
# Pretty terminal output (default)
awf logs stats

# JSON format for scripting
awf logs stats --format json

# Markdown format
awf logs stats --format markdown
```

Example output:
```
Firewall Statistics
────────────────────────────────────────

Total Requests:  150
Allowed:         145 (96.7%)
Denied:          5 (3.3%)
Unique Domains:  12

Domains:
  api.github.com       50 allowed, 0 denied
  registry.npmjs.org   95 allowed, 0 denied
  evil.com             0 allowed, 5 denied
```

### Using `awf logs summary` (GitHub Actions)

Generate a markdown summary optimized for GitHub Actions:

```bash
# Generate markdown summary and append to step summary
awf logs summary >> $GITHUB_STEP_SUMMARY
```

This creates a collapsible summary in your GitHub Actions workflow output showing all allowed and blocked domains.

### Manual Log Queries

For more granular analysis, you can query the logs directly:

Find all blocked domains:
```bash
docker exec awf-squid grep "TCP_DENIED" /var/log/squid/access.log | awk '{print $3}' | sort -u
```

Count blocked attempts by domain:
```bash
docker exec awf-squid grep "TCP_DENIED" /var/log/squid/access.log | awk '{print $3}' | sort | uniq -c | sort -rn
```

**For detailed logging documentation, see [LOGGING.md](../LOGGING.md)**
