---
title: CLI Reference
description: Quick reference for awf command-line options and arguments.
---

Quick reference for the `awf` command-line interface.

:::caution[Requires sudo]
The firewall requires root privileges. Always run with `sudo` or `sudo -E` (to preserve environment variables).
:::

## Synopsis

```bash
awf [options] -- <command>
```

## Options Summary

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--allow-domains <domains>` | string | — | Comma-separated list of allowed domains (optional; if not specified, all network access is blocked) |
| `--allow-domains-file <path>` | string | — | Path to file containing allowed domains |
| `--ruleset-file <path>` | string | `[]` | YAML rule file for domain allowlisting (repeatable) |
| `--block-domains <domains>` | string | — | Comma-separated list of blocked domains (takes precedence over allowed) |
| `--block-domains-file <path>` | string | — | Path to file containing blocked domains |
| `--ssl-bump` | flag | `false` | Enable SSL Bump for HTTPS content inspection |
| `--allow-urls <urls>` | string | — | Comma-separated list of allowed URL patterns (requires `--ssl-bump`) |
| `--log-level <level>` | string | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `--keep-containers` | flag | `false` | Keep containers running after command exits |
| `--agent-timeout <minutes>` | number | no limit | Maximum time in minutes for the agent command to run |
| `--tty` | flag | `false` | Allocate pseudo-TTY for interactive tools |
| `--work-dir <dir>` | string | `/tmp/awf-<timestamp>` | Working directory for temporary files |
| `--build-local` | flag | `false` | Build containers locally instead of pulling from registry |
| `--image-registry <url>` | string | `ghcr.io/github/gh-aw-firewall` | Container image registry |
| `--image-tag <tag>` | string | `latest` | Container image tag |
| `--skip-pull` | flag | `false` | Use local images without pulling from registry |
| `-e, --env <KEY=VALUE>` | string | `[]` | Environment variable (repeatable) |
| `--env-all` | flag | `false` | Pass all host environment variables |
| `--exclude-env <name>` | string | `[]` | Exclude a variable from `--env-all` passthrough (repeatable) |
| `--env-file <path>` | string | — | Read env vars from a file (KEY=VALUE format, one per line) |
| `-v, --mount <host:container[:mode]>` | string | `[]` | Volume mount (repeatable) |
| `--container-workdir <dir>` | string | User home | Working directory inside container |
| `--memory-limit <limit>` | string | `6g` | Memory limit for the agent container |
| `--dns-servers <servers>` | string | Auto-detected | Trusted DNS servers (comma-separated; auto-detected from host, falls back to `8.8.8.8,8.8.4.4`) |
| `--dns-over-https [resolver-url]` | optional string | `https://dns.google/dns-query` | Enable DNS-over-HTTPS via sidecar proxy |
| `--proxy-logs-dir <path>` | string | — | Directory to save Squid proxy logs to |
| `--audit-dir <path>` | string | — | Directory for firewall audit artifacts |
| `--enable-host-access` | flag | `false` | Enable access to host services via host.docker.internal |
| `--allow-host-ports <ports>` | string | `80,443` | Ports to allow when using --enable-host-access |
| `--allow-host-service-ports <ports>` | string | — | Ports to allow ONLY to host gateway (for GitHub Actions `services:`) |
| `--enable-dind` | flag | `false` | Enable Docker-in-Docker by exposing host Docker socket |
| `--enable-dlp` | flag | `false` | Enable DLP scanning to block credential exfiltration |
| `--agent-image <value>` | string | `default` | Agent container image (default, act, or custom) |
| `--enable-api-proxy` | flag | `false` | Enable API proxy sidecar for secure credential injection |
| `--copilot-api-target <host>` | string | `api.githubcopilot.com` | Target hostname for Copilot API requests |
| `--openai-api-target <host>` | string | `api.openai.com` | Target hostname for OpenAI API requests |
| `--openai-api-base-path <path>` | string | — | Base path prefix for OpenAI API requests |
| `--anthropic-api-target <host>` | string | `api.anthropic.com` | Target hostname for Anthropic API requests |
| `--anthropic-api-base-path <path>` | string | — | Base path prefix for Anthropic API requests |
| `--rate-limit-rpm <n>` | number | `600` | Max requests per minute per provider |
| `--rate-limit-rph <n>` | number | `10000` | Max requests per hour per provider |
| `--rate-limit-bytes-pm <n>` | number | `52428800` (~50 MB) | Max request bytes per minute per provider |
| `--no-rate-limit` | flag | — | Disable rate limiting in API proxy |
| `-V, --version` | flag | — | Display version |
| `-h, --help` | flag | — | Display help |

## Options Details

### `--allow-domains <domains>`

Comma-separated list of allowed domains. Domains automatically match all subdomains. Supports wildcard patterns, protocol-specific filtering, and special keywords.

**If no domains are specified, all network access is blocked.** This is useful for running commands that should have no network access.

```bash
# Allow specific domains
--allow-domains github.com,npmjs.org
--allow-domains '*.github.com,api-*.example.com'

# No network access (empty or omitted)
awf -- echo "offline command"
```

#### Protocol-specific filtering

Restrict domains to HTTP-only or HTTPS-only traffic by prefixing with the protocol:

```bash
# HTTPS only - blocks HTTP traffic to this domain
--allow-domains 'https://secure.example.com'

# HTTP only - blocks HTTPS traffic to this domain
--allow-domains 'http://legacy-api.example.com'

# Both protocols (default behavior)
--allow-domains 'example.com'

# Mixed configuration
--allow-domains 'example.com,https://secure.example.com,http://legacy.example.com'

# Works with wildcards
--allow-domains 'https://*.secure.example.com'
```

| Format | HTTP | HTTPS | Example |
|--------|------|-------|---------|
| `domain.com` | ✓ | ✓ | `--allow-domains example.com` |
| `https://domain.com` | ✗ | ✓ | `--allow-domains 'https://api.example.com'` |
| `http://domain.com` | ✓ | ✗ | `--allow-domains 'http://legacy.example.com'` |

:::tip
Bare domains (without protocol prefix) allow both HTTP and HTTPS. Use protocol prefixes to restrict to a single protocol.
:::

#### Wildcard patterns

Use `*` to match multiple domains:

```bash
# Match any subdomain
--allow-domains '*.github.com'

# Match prefix patterns within a subdomain label
--allow-domains 'api-*.example.com'

# Combine plain domains and wildcards
--allow-domains 'github.com,*.googleapis.com,api-*.example.com'
```

:::caution
Use quotes around patterns to prevent shell expansion of `*`.
:::

| Pattern | Matches | Does Not Match |
|---------|---------|----------------|
| `*.github.com` | `api.github.com`, `raw.github.com` | `github.com` |
| `api-*.example.com` | `api-v1.example.com`, `api-test.example.com` | `api.example.com` |
| `github.com` | `github.com`, `api.github.com` | `notgithub.com` |

**Security restrictions:** Overly broad patterns like `*`, `*.*`, or `*.*.*` are rejected.

:::note
Wildcard patterns and protocol prefixes can be combined: `https://*.secure.example.com` matches only HTTPS traffic to any subdomain of `secure.example.com`.
:::

#### `localhost` keyword

Using `localhost` in `--allow-domains` triggers special behavior for local development:

```bash
# Automatically configures everything for local testing
sudo awf --allow-domains localhost -- npx playwright test
```

When `localhost` is detected, awf automatically:

1. **Replaces `localhost` with `host.docker.internal`** — Maps to Docker's host gateway so containers can reach host services
2. **Enables `--enable-host-access`** — Activates host network access (equivalent to passing `--enable-host-access`)
3. **Allows common development ports** — Opens ports 3000, 3001, 4000, 4200, 5000, 5173, 8000, 8080, 8081, 8888, 9000, 9090

Protocol prefixes are preserved: `http://localhost` becomes `http://host.docker.internal` and `https://localhost` becomes `https://host.docker.internal`.

```bash
# Override the default ports
sudo awf --allow-domains localhost --allow-host-ports 3000,8080 -- npx playwright test

# Combine with other domains
sudo awf --allow-domains localhost,github.com -- npx playwright test
```

:::caution
The `localhost` keyword enables access to services running on your host machine. Only use it for trusted workloads like local testing and development.
:::

**See also:** [Playwright Testing with Localhost](/gh-aw-firewall/guides/playwright-testing) for detailed examples.

### `--allow-domains-file <path>`

Path to file with allowed domains. Supports comments (`#`) and one domain per line.

```bash
--allow-domains-file ./allowed-domains.txt
```

### `--ruleset-file <path>`

YAML rule file for domain allowlisting. Can be specified multiple times to load multiple files. Domains from ruleset files are merged with `--allow-domains` and `--allow-domains-file`.

```bash
# Single ruleset file
--ruleset-file ./domains.yml

# Multiple ruleset files
--ruleset-file ./base-domains.yml --ruleset-file ./extra-domains.yml
```

**Schema** (version 1):

```yaml
version: 1
rules:
  - domain: github.com
    subdomains: true    # default: true — also allows *.github.com
  - domain: example.com
    subdomains: false   # exact match only
```

**Fields:**
- `version` — Must be `1`
- `rules` — Array of rule objects

Each rule has the following fields:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `domain` | Yes | — | Domain name to allow |
| `subdomains` | No | `true` | Whether to also allow all subdomains |

### `--block-domains <domains>`

Comma-separated list of blocked domains. **Blocked domains take precedence over allowed domains**, enabling fine-grained control. Supports the same wildcard patterns as `--allow-domains`.

```bash
# Block specific subdomain while allowing parent domain
--allow-domains example.com --block-domains internal.example.com

# Block with wildcards
--allow-domains '*.example.com' --block-domains '*.secret.example.com'
```

### `--block-domains-file <path>`

Path to file with blocked domains. Supports the same format as `--allow-domains-file`.

```bash
--block-domains-file ./blocked-domains.txt
```

### `--ssl-bump`

Enable SSL Bump for HTTPS content inspection. When enabled, the firewall generates a per-session CA certificate and intercepts HTTPS connections, allowing URL path filtering.

```bash
--ssl-bump --allow-urls "https://github.com/myorg/*"
```

:::caution[HTTPS Interception]
SSL Bump decrypts HTTPS traffic at the proxy. The proxy can see full URLs, headers, and request bodies. Applications with certificate pinning will fail to connect.
:::

**How it works:**
1. A unique CA certificate is generated (valid for 1 day)
2. The CA is injected into the agent container's trust store
3. Squid intercepts HTTPS using SSL Bump (peek, stare, bump)
4. Full URLs become visible for filtering via `--allow-urls`

**See also:** [SSL Bump Reference](/gh-aw-firewall/reference/ssl-bump/) for complete documentation.

### `--allow-urls <urls>`

Comma-separated list of allowed URL patterns for HTTPS traffic. Requires `--ssl-bump`.

```bash
# Single pattern
--allow-urls "https://github.com/myorg/*"

# Multiple patterns
--allow-urls "https://github.com/org1/*,https://api.github.com/repos/*"
```

**Pattern syntax:**
- Must include scheme (`https://`)
- `*` matches any characters in a path segment
- Patterns are matched against the full request URL

:::note
Without `--ssl-bump`, the firewall can only see domain names (via SNI). Enable `--ssl-bump` to filter by URL path.
:::

### `--log-level <level>`

Set logging verbosity.

| Level | Description |
|-------|-------------|
| `debug` | Detailed information including config, container startup, iptables rules |
| `info` | Normal operational messages (default) |
| `warn` | Warning messages |
| `error` | Error messages only |

### `--keep-containers`

Keep containers and configuration files after command exits for debugging.

:::note
Requires manual cleanup: `docker stop awf-squid awf-agent && docker network rm awf-net`
:::

### `--agent-timeout <minutes>`

Maximum time in minutes for the agent command to run. When the timeout is reached, the agent container is stopped and the firewall exits. Must be a positive integer.

```bash
# Allow up to 30 minutes
sudo awf --agent-timeout 30 --allow-domains github.com \
  -- long-running-command

# Allow up to 2 hours
sudo awf --agent-timeout 120 --allow-domains github.com \
  -- npx @github/copilot@latest --prompt "complex task"
```

:::note
By default, there is no time limit. Use this flag to prevent runaway agent processes.
:::

### `--tty`

Allocate a pseudo-TTY for interactive tools (e.g., Claude Code, interactive shells).

### `--work-dir <dir>`

Custom working directory for temporary files. Contains `squid.conf`, `docker-compose.yml`, and log directories.

### `--build-local`

Build containers from local Dockerfiles instead of pulling pre-built images.

### `--image-registry <url>`

Custom container image registry URL.

### `--image-tag <tag>`

Container image tag to use.

### `--skip-pull`

Use local images without pulling from the registry. This is useful for:

- **Air-gapped environments** where registry access is unavailable
- **CI systems with pre-warmed image caches** to avoid unnecessary network calls
- **Local development** when images are already cached

```bash
# Pre-pull images first
docker pull ghcr.io/github/gh-aw-firewall/squid:latest
docker pull ghcr.io/github/gh-aw-firewall/agent:latest

# Use with --skip-pull to avoid re-pulling
sudo awf --skip-pull --allow-domains github.com -- curl https://api.github.com
```

:::caution[Image Verification]
When using `--skip-pull`, you are responsible for verifying image authenticity. The firewall cannot verify that locally cached images haven't been tampered with. See [Image Verification](/gh-aw-firewall/docs/image-verification/) for cosign verification instructions.
:::

:::note[Incompatible with --build-local]
The `--skip-pull` flag cannot be used with `--build-local` since building images requires pulling base images from the registry.
:::

### `-e, --env <KEY=VALUE>`

Pass environment variable to container. Can be specified multiple times.

```bash
-e API_KEY=secret -e DEBUG=true
```

### `--env-all`

Pass all host environment variables to container.

:::danger[Security Risk]
May expose sensitive credentials. Prefer `-e` for specific variables, or use `--exclude-env` to filter out sensitive variables.
:::

### `--exclude-env <name>`

Exclude a specific environment variable from `--env-all` passthrough. Can be specified multiple times. Only meaningful when used with `--env-all`.

```bash
# Pass all env vars except secrets
sudo -E awf --env-all \
  --exclude-env AWS_SECRET_ACCESS_KEY \
  --exclude-env GITHUB_TOKEN \
  --allow-domains github.com \
  -- my-command
```

:::tip[Security Best Practice]
When using `--env-all`, always exclude sensitive variables like API keys, tokens, and credentials with `--exclude-env`.
:::

### `--env-file <path>`

Read environment variables from a file. The file uses `KEY=VALUE` format with one variable per line. Lines starting with `#` are treated as comments.

```bash
sudo awf --env-file ./env.production \
  --allow-domains github.com \
  -- my-command
```

**File format:**
```bash
# Database configuration
DB_HOST=localhost
DB_PORT=5432

# API settings
API_KEY=your-api-key-here
DEBUG=true
```

### `-v, --mount <host_path:container_path[:mode]>`

Mount host directories into container. Format: `host_path:container_path[:ro|rw]`

```bash
-v /data:/data:ro -v /tmp/output:/output:rw
```

**Requirements:**
- Both paths must be absolute
- Host path must exist
- Mode: `ro` (read-only) or `rw` (read-write)

**Default mounts (selective bind mounts, not a blanket host FS mount):**
- System binaries (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/opt`, `/sys`, `/dev`) at `/host` (read-only)
- Workspace and `/tmp` (read-write)
- Whitelisted `$HOME` subdirs such as `.cache`, `.config`, `.local` (read-write)
- Select `/etc` files only — SSL certs, `passwd`, `group`, etc. (not `/etc/shadow`)

### `--container-workdir <dir>`

Working directory inside the container.

### `--memory-limit <limit>`

Memory limit for the agent container. Format: `<number><unit>` where unit is `b` (bytes), `k` (kilobytes), `m` (megabytes), or `g` (gigabytes).

- **Default**: `6g`

```bash
# Increase memory for large language model agents
sudo awf --memory-limit 8g --allow-domains github.com \
  -- memory-intensive-command

# Reduce memory for lightweight tasks
sudo awf --memory-limit 2g --allow-domains github.com \
  -- curl https://api.github.com
```

:::tip
If your agent process is being killed unexpectedly (OOM), try increasing the memory limit with `--memory-limit 8g` or higher.
:::

### `--dns-servers <servers>`

Comma-separated list of trusted DNS servers. DNS traffic is **only** allowed to these servers, preventing DNS-based data exfiltration. Both IPv4 and IPv6 addresses are supported.

If omitted, DNS servers are **auto-detected from host resolvers** (e.g., `/run/systemd/resolve/resolv.conf` or `/etc/resolv.conf`). Falls back to Google DNS (`8.8.8.8`, `8.8.4.4`) only if auto-detection fails.

```bash
# Use Cloudflare DNS
--dns-servers 1.1.1.1,1.0.0.1

# Use Google DNS with IPv6
--dns-servers 8.8.8.8,2001:4860:4860::8888
```

:::note
Docker's embedded DNS (127.0.0.11) is always allowed for container name resolution, regardless of this setting.
:::

:::note[Chroot Mode]
AWF always runs in chroot mode, making the host filesystem appear as the root filesystem inside the container. This provides transparent access to host-installed binaries (Python, Node.js, Go, etc.) while maintaining network isolation. See [Chroot Mode Documentation](/gh-aw-firewall/docs/chroot-mode/) for details.
:::

### `--dns-over-https [resolver-url]`

Enable DNS-over-HTTPS (DoH) via a sidecar proxy. When enabled, DNS queries are encrypted and sent over HTTPS instead of plaintext UDP, preventing DNS-based traffic inspection or tampering.

```bash
# Use default resolver (Google DNS)
--dns-over-https

# Use a custom resolver
--dns-over-https https://cloudflare-dns.com/dns-query
```

- **Default resolver**: `https://dns.google/dns-query`
- **Requirement**: Resolver URL must start with `https://`

:::tip
Use `--dns-over-https` without a value to use the Google DNS default. Provide a custom URL only if your environment requires a specific resolver.
:::

### `--enable-host-access`

Enable access to host services via `host.docker.internal`. This allows containers to connect to services running on the host machine (e.g., local development servers, MCP gateways).

```bash
# Access local development server
sudo awf --enable-host-access --allow-domains host.docker.internal \
  -- curl http://host.docker.internal:3000
```

:::danger[Security Warning]
When `--enable-host-access` is enabled, containers can access services on the host machine. By default, only ports 80 and 443 are allowed. Use `--allow-host-ports` to allow additional ports.
:::

**See also:** [Host Access Configuration](/gh-aw-firewall/docs/usage/#host-access)

### `--allow-host-ports <ports>`

Specify which ports are allowed when using `--enable-host-access`. Accepts comma-separated port numbers or ranges.

```bash
# Allow specific ports
--allow-host-ports 3000,8080

# Allow port ranges
--allow-host-ports 3000-3010,8000-8090

# Combine with localhost keyword for Playwright testing
sudo awf --allow-domains localhost --allow-host-ports 3000 \
  -- npx playwright test
```

**Default behavior:**
- Without `--allow-host-ports`: Only ports 80 and 443 are allowed
- With `--allow-host-ports`: Only the specified ports are allowed

### `--allow-host-service-ports <ports>`

Comma-separated ports to allow **only** to the host gateway (`host.docker.internal`). Designed for GitHub Actions `services:` containers (e.g., PostgreSQL, Redis) whose ports are exposed to the host gateway.

```bash
# Allow PostgreSQL and Redis on host gateway
sudo awf --allow-host-service-ports 5432,6379 \
  --allow-domains github.com \
  -- python run_tests.py
```

**Key differences from `--allow-host-ports`:**

| | `--allow-host-ports` | `--allow-host-service-ports` |
|---|---|---|
| **Scope** | General host access | Host gateway only |
| **Dangerous ports** | Blocked (SSH, SMTP, etc.) | Allowed (restricted to host) |
| **Requires `--enable-host-access`** | Yes | No (auto-enables it) |
| **Use case** | Local dev servers | GitHub Actions `services:` |

- **Auto-enables host access**: No need to also pass `--enable-host-access`
- **Bypasses dangerous port restrictions**: Ports like 5432 (PostgreSQL) and 6379 (Redis) are normally blocked when using `--allow-host-ports` to prevent unintended database access, but are safe with `--allow-host-service-ports` because traffic is restricted to the host gateway only

:::danger[Security Warning]
Allowing port 22 grants SSH access to the host machine. Only allow ports for services you explicitly need.
:::

### `--proxy-logs-dir <path>`

Save Squid proxy logs directly to a custom directory instead of the default temporary location. Useful for preserving logs across multiple runs or integrating with log aggregation systems.

```bash
# Save logs to custom directory
sudo awf --proxy-logs-dir ./firewall-logs \
  --allow-domains github.com \
  -- curl https://api.github.com

# Check logs
cat ./firewall-logs/access.log
```

**Note:** The directory must be writable by the current user.

### `--audit-dir <path>`

Directory for firewall audit artifacts. When specified, the firewall saves configuration files, the policy manifest, and iptables state to this directory for compliance and debugging purposes.

```bash
# Save audit artifacts
sudo awf --audit-dir ./audit \
  --allow-domains github.com \
  -- curl https://api.github.com

# Review audit artifacts
ls ./audit/
```

:::tip
Use `--audit-dir` in CI/CD pipelines to capture firewall configuration for audit trails. Can also be set via the `AWF_AUDIT_DIR` environment variable.
:::

### `--agent-image <value>`

Specify the agent container image to use. Supports pre-built presets or custom base images.

**Presets** (pre-built, pull from GHCR):
- `default` — Minimal ubuntu:22.04 (~200MB, fast startup)
- `act` — GitHub Actions parity (~2GB, includes all runner tools)

**Custom base images** (requires `--build-local`):
- `ubuntu:XX.XX` (e.g., `ubuntu:22.04`, `ubuntu:24.04`)
- `ghcr.io/catthehacker/ubuntu:runner-XX.XX`
- `ghcr.io/catthehacker/ubuntu:full-XX.XX`
- `ghcr.io/catthehacker/ubuntu:act-XX.XX`

```bash
# Use default preset (minimal, fast)
sudo awf --allow-domains github.com -- curl https://api.github.com

# Use act preset (GitHub Actions compatible)
sudo awf --agent-image act --allow-domains github.com \
  -- curl https://api.github.com

# Use custom base image (requires --build-local)
sudo awf --agent-image ubuntu:24.04 --build-local \
  --allow-domains github.com \
  -- curl https://api.github.com
```

:::caution[Security]
Custom images are validated against approved patterns to prevent supply chain attacks. Only official Ubuntu images and catthehacker runner images are allowed.
:::

**See also:** [Agent Images Reference](/gh-aw-firewall/reference/agent-images/)

### `--enable-dind`

Enable Docker-in-Docker by mounting the host Docker socket (`/var/run/docker.sock`) into the agent container. This allows the agent to run Docker commands.

```bash
sudo awf --enable-dind --allow-domains github.com \
  -- docker run hello-world
```

:::danger[Security Warning]
Enabling Docker-in-Docker allows the agent to **bypass all firewall restrictions** by spawning new containers that are not subject to the firewall's network rules. Only enable this when you trust the command being executed and Docker access is required.
:::

### `--enable-dlp`

Enable Data Loss Prevention (DLP) scanning on outbound requests. When enabled, the firewall inspects outbound request URLs for patterns that match common credentials (API keys, tokens, passwords) and blocks requests that appear to exfiltrate secrets.

```bash
sudo awf --enable-dlp --allow-domains github.com \
  -- python my_script.py
```

:::tip
Enable DLP scanning as a defense-in-depth measure when running untrusted code that has access to environment variables or files containing credentials.
:::

### `--enable-api-proxy`

Enable the API proxy sidecar for secure credential injection. The sidecar is a Node.js proxy (`172.30.0.30`) that holds real API credentials so the agent never sees them. The agent sends unauthenticated requests to the sidecar, which injects the credentials and forwards the request through Squid to the upstream API.

```bash
# Enable with keys from environment
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
sudo -E awf --enable-api-proxy \
  --allow-domains api.openai.com,api.anthropic.com \
  -- command
```

**Required environment variables** (at least one):

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI / Codex |
| `ANTHROPIC_API_KEY` | Anthropic / Claude |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot |

**Sidecar ports:**

| Port | Provider |
|------|----------|
| `10000` | OpenAI |
| `10001` | Anthropic |
| `10002` | GitHub Copilot |
| `10004` | OpenCode |

:::tip
Use `sudo -E` to preserve environment variables like API keys through sudo.
:::

:::danger[Security]
API keys are held exclusively in the sidecar container. The agent container receives only the sidecar proxy URL — never the actual credentials.
:::

### `--copilot-api-target <host>`

Target hostname for GitHub Copilot API requests. Useful for GitHub Enterprise Server (GHES) deployments where the Copilot API endpoint differs from the public default. Can also be set via the `COPILOT_API_TARGET` environment variable.

- **Default:** `api.githubcopilot.com`
- **Requires:** `--enable-api-proxy`

```bash
sudo -E awf --enable-api-proxy \
  --copilot-api-target api.github.mycompany.com \
  --allow-domains api.github.mycompany.com \
  -- command
```

### `--openai-api-target <host>`

Target hostname for OpenAI API requests. Useful for custom OpenAI-compatible endpoints such as Azure OpenAI, internal LLM routers, vLLM, or TGI. Can also be set via the `OPENAI_API_TARGET` environment variable.

- **Default:** `api.openai.com`
- **Requires:** `--enable-api-proxy`

```bash
sudo -E awf --enable-api-proxy \
  --openai-api-target llm-router.internal.example.com \
  --allow-domains llm-router.internal.example.com \
  -- command
```

### `--openai-api-base-path <path>`

Base path prefix prepended to every upstream OpenAI API request path. Use this when the upstream endpoint requires a URL prefix (e.g., Databricks serving endpoints, Azure OpenAI deployments). Can also be set via the `OPENAI_API_BASE_PATH` environment variable.

- **Default:** none
- **Requires:** `--enable-api-proxy`

```bash
# Databricks serving endpoint
sudo -E awf --enable-api-proxy \
  --openai-api-target myworkspace.cloud.databricks.com \
  --openai-api-base-path /serving-endpoints \
  --allow-domains myworkspace.cloud.databricks.com \
  -- command
```

### `--anthropic-api-target <host>`

Target hostname for Anthropic API requests. Useful for custom Anthropic-compatible endpoints such as internal LLM routers. Can also be set via the `ANTHROPIC_API_TARGET` environment variable.

- **Default:** `api.anthropic.com`
- **Requires:** `--enable-api-proxy`

```bash
sudo -E awf --enable-api-proxy \
  --anthropic-api-target llm-router.internal.example.com \
  --allow-domains llm-router.internal.example.com \
  -- command
```

### `--anthropic-api-base-path <path>`

Base path prefix prepended to every upstream Anthropic API request path. Use this when the upstream endpoint requires a URL prefix. Can also be set via the `ANTHROPIC_API_BASE_PATH` environment variable.

- **Default:** none
- **Requires:** `--enable-api-proxy`

```bash
sudo -E awf --enable-api-proxy \
  --anthropic-api-target custom-llm.example.com \
  --anthropic-api-base-path /anthropic \
  --allow-domains custom-llm.example.com \
  -- command
```

### `--rate-limit-rpm <n>`

Maximum number of requests per minute per provider. Rate limiting is opt-in — it is only enabled when at least one `--rate-limit-*` flag is provided.

- **Default:** `600` (when rate limiting is enabled)
- **Requires:** `--enable-api-proxy`

```bash
sudo -E awf --enable-api-proxy \
  --rate-limit-rpm 100 \
  --allow-domains api.openai.com \
  -- command
```

### `--rate-limit-rph <n>`

Maximum number of requests per hour per provider.

- **Default:** `10000` (when rate limiting is enabled)
- **Requires:** `--enable-api-proxy`

```bash
sudo -E awf --enable-api-proxy \
  --rate-limit-rph 5000 \
  --allow-domains api.anthropic.com \
  -- command
```

### `--rate-limit-bytes-pm <n>`

Maximum request bytes per minute per provider.

- **Default:** `52428800` (~50 MB, when rate limiting is enabled)
- **Requires:** `--enable-api-proxy`

```bash
sudo -E awf --enable-api-proxy \
  --rate-limit-bytes-pm 10485760 \
  --allow-domains api.openai.com \
  -- command
```

### `--no-rate-limit`

Explicitly disable rate limiting in the API proxy, even if other `--rate-limit-*` flags are provided. Useful for overriding defaults in scripts or CI configurations.

- **Requires:** `--enable-api-proxy`

```bash
sudo -E awf --enable-api-proxy --no-rate-limit \
  --allow-domains api.anthropic.com \
  -- command
```

:::caution
When using a custom `--openai-api-target` or `--anthropic-api-target`, you must add the target domain to `--allow-domains` so the firewall permits outbound traffic. AWF emits a warning if a custom target is set but not in the allowlist.
:::

## Implicit Behaviors

### Enterprise domain auto-detection

AWF automatically detects GitHub Enterprise environments and adds required domains to the allowlist. No manual configuration is needed — the domains are auto-added when the relevant environment variables are present.

#### GitHub Enterprise Cloud (GHEC)

When `GITHUB_SERVER_URL` points to a `*.ghe.com` tenant (set automatically by GitHub Agentic Workflows), AWF auto-adds:

| Auto-added Domain | Purpose |
|-------------------|---------|
| `<tenant>.ghe.com` | Enterprise tenant |
| `api.<tenant>.ghe.com` | API access |
| `copilot-api.<tenant>.ghe.com` | Copilot inference |
| `copilot-telemetry-service.<tenant>.ghe.com` | Copilot telemetry |

Domains from `GITHUB_API_URL` (e.g., `https://api.<tenant>.ghe.com`) are also detected.

```bash
# These environment variables are set automatically by GitHub Agentic Workflows
# GITHUB_SERVER_URL=https://myorg.ghe.com
# GITHUB_API_URL=https://api.myorg.ghe.com

# AWF auto-adds: myorg.ghe.com, api.myorg.ghe.com,
#   copilot-api.myorg.ghe.com, copilot-telemetry-service.myorg.ghe.com
sudo awf --allow-domains github.com -- copilot-agent
```

:::note
Public `github.com` is not auto-added — it must be specified explicitly in `--allow-domains`.
:::

#### GitHub Enterprise Server (GHES)

When `ENGINE_API_TARGET` is set (indicating a GHES environment), AWF auto-adds:

| Auto-added Domain | Purpose |
|-------------------|---------|
| `github.<company>.com` | GHES base domain (extracted from API URL) |
| `api.github.<company>.com` | GHES API access |
| `api.githubcopilot.com` | Copilot API (cloud-hosted) |
| `api.enterprise.githubcopilot.com` | Enterprise Copilot API |
| `telemetry.enterprise.githubcopilot.com` | Enterprise Copilot telemetry |

```bash
# Set by GitHub Agentic Workflows on GHES
# ENGINE_API_TARGET=https://api.github.mycompany.com

# AWF auto-adds: github.mycompany.com, api.github.mycompany.com,
#   api.githubcopilot.com, api.enterprise.githubcopilot.com,
#   telemetry.enterprise.githubcopilot.com
sudo awf --allow-domains github.com -- copilot-agent
```

:::tip
Use `--log-level debug` to see which enterprise domains were auto-detected. Look for "Auto-added GHEC domains" or "Auto-added GHES domains" in the output.
:::

## Exit Codes

| Code | Description |
|------|-------------|
| `0` | Command succeeded |
| `1-255` | Command exit code or firewall error |
| `130` | Interrupted by SIGINT (Ctrl+C) |
| `143` | Terminated by SIGTERM |

## Subcommands

### `awf predownload`

Pre-download Docker images for offline use or faster startup. This pulls container images ahead of time so that subsequent `awf` runs can use `--skip-pull` to avoid network calls.

```bash
awf predownload [options]
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--image-registry <registry>` | string | `ghcr.io/github/gh-aw-firewall` | Container image registry |
| `--image-tag <tag>` | string | `latest` | Container image tag (applies to squid, agent, and api-proxy images) |
| `--agent-image <value>` | string | `default` | Agent image preset (`default`, `act`) or custom image |
| `--enable-api-proxy` | flag | `false` | Also download the API proxy image |

:::tip
After pre-downloading, use `--skip-pull` on subsequent runs to skip pulling images at runtime.
:::

#### Examples

```bash
# Pre-download default images (squid + agent)
awf predownload

# Pre-download including the API proxy image
awf predownload --enable-api-proxy

# Pre-download a specific version
awf predownload --image-tag v0.3.0

# Pre-download the act (GitHub Actions parity) agent image
awf predownload --agent-image act

# Use a custom registry
awf predownload --image-registry ghcr.io/myorg/awf

# After pre-downloading, run without pulling
sudo awf --skip-pull --allow-domains github.com -- curl https://api.github.com
```

### `awf logs`

View Squid proxy logs from current or previous runs.

```bash
awf logs [options]
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `-f, --follow` | flag | `false` | Follow log output in real-time |
| `--format <format>` | string | `pretty` | Output format: `raw`, `pretty`, `json` |
| `--source <path>` | string | auto | Path to log directory or `running` for live container |
| `--list` | flag | `false` | List available log sources |
| `--with-pid` | flag | `false` | Enrich logs with PID/process info (requires `-f`) |

#### Output Formats

| Format | Description |
|--------|-------------|
| `pretty` | Colorized, human-readable output (default) |
| `raw` | Logs as-is without parsing |
| `json` | Structured JSON for scripting |

#### Examples

```bash
# View recent logs with pretty formatting
awf logs

# Follow logs in real-time
awf logs -f

# View logs in JSON format
awf logs --format json

# List available log sources
awf logs --list

# Use a specific log directory
awf logs --source /tmp/squid-logs-1234567890

# Stream from running container
awf logs --source running -f

# Follow logs with PID/process tracking
awf logs -f --with-pid
```

#### PID Tracking

The `--with-pid` flag enriches log entries with process information, correlating each network request to the specific process that made it.

**Pretty format with PID:**
```
[2024-01-01 12:00:00.123] CONNECT api.github.com → 200 (ALLOWED) [curl/7.88.1] <PID:12345 curl>
```

**JSON output includes additional fields:**
```json
{
  "timestamp": 1703001234.567,
  "domain": "github.com",
  "pid": 12345,
  "cmdline": "curl https://github.com",
  "comm": "curl",
  "inode": "123456"
}
```

:::caution
PID tracking only works with `-f` (follow mode) and requires Linux. Process information is only available while processes are running.
:::

:::note
Log sources are auto-discovered in this order: running containers, `AWF_LOGS_DIR` environment variable, then preserved log directories in `/tmp/squid-logs-*`.
:::

### `awf logs stats`

Show aggregated statistics from firewall logs.

```bash
awf logs stats [options]
```

:::note[stats vs summary]
Use `awf logs stats` for terminal output (defaults to colorized `pretty` format). Use `awf logs summary` for CI/CD integration (defaults to `markdown` format for `$GITHUB_STEP_SUMMARY`). Both commands provide the same data in different default formats.
:::

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--format <format>` | string | `pretty` | Output format: `json`, `markdown`, `pretty` |
| `--source <path>` | string | auto | Path to log directory or `running` for live container |

#### Output Formats

| Format | Description |
|--------|-------------|
| `pretty` | Colorized terminal output with summary and domain breakdown (default) |
| `markdown` | Markdown table format suitable for documentation |
| `json` | Structured JSON for programmatic consumption |

#### Examples

```bash
# Show stats with colorized terminal output
awf logs stats

# Get stats in JSON format for scripting
awf logs stats --format json

# Get stats in markdown format
awf logs stats --format markdown

# Use a specific log directory
awf logs stats --source /tmp/squid-logs-1234567890
```

#### Example Output (Pretty)

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

### `awf logs summary`

Generate summary report optimized for GitHub Actions step summaries.

```bash
awf logs summary [options]
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--format <format>` | string | `markdown` | Output format: `json`, `markdown`, `pretty` |
| `--source <path>` | string | auto | Path to log directory or `running` for live container |

:::tip[GitHub Actions]
The `summary` command defaults to markdown format, making it perfect for piping directly to `$GITHUB_STEP_SUMMARY`.
:::

#### Examples

```bash
# Generate markdown summary (default)
awf logs summary

# Add to GitHub Actions step summary
awf logs summary >> $GITHUB_STEP_SUMMARY

# Get summary in JSON format
awf logs summary --format json

# Get summary with colorized terminal output
awf logs summary --format pretty
```

#### Example Output (Markdown)

```markdown
<details>
<summary>Firewall Activity</summary>

▼ 150 requests | 145 allowed | 5 blocked | 12 unique domains

| Domain | Allowed | Denied |
|--------|---------|--------|
| api.github.com | 50 | 0 |
| registry.npmjs.org | 95 | 0 |
| evil.com | 0 | 5 |

</details>
```

### `awf logs audit`

Show firewall audit with policy rule matching. Enriches log entries with the specific policy rule that caused each allow/deny decision.

```bash
awf logs audit [options]
```

:::caution
The audit command requires a `policy-manifest.json` file alongside the log files. This file is generated when running `awf` with the `--audit-dir` option.
:::

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--format <format>` | string | `pretty` | Output format: `json`, `markdown`, `pretty` |
| `--source <path>` | string | auto | Path to log directory or `running` for live container |
| `--rule <id>` | string | — | Filter to a specific rule ID |
| `--domain <domain>` | string | — | Filter to a specific domain |
| `--decision <decision>` | string | — | Filter to `allowed` or `denied` |

#### Examples

```bash
# Show audit report with colorized terminal output
awf logs audit

# Show audit in JSON format
awf logs audit --format json

# Generate markdown audit report
awf logs audit --format markdown

# Filter to denied requests only
awf logs audit --decision denied

# Filter to a specific domain
awf logs audit --domain github.com

# Filter by rule ID
awf logs audit --rule allow-both-plain

# Use a specific log directory
awf logs audit --source /tmp/squid-logs-1234567890
```

#### Example Output (Pretty)

```
Firewall Audit Report
────────────────────────────────────────────────────────────

Rule Evaluation:
  allow-both-plain    allow  12 hits  Allow domain (HTTP+HTTPS)
  default-deny        deny   3 hits   Default deny rule

Denied Requests (3):
  12:00:01.234  evil.com       → default-deny
  12:00:02.567  malware.org    → default-deny
  12:00:03.890  blocked.net    → default-deny
```

## See Also

- [API Proxy Sidecar](/gh-aw-firewall/reference/api-proxy-sidecar) - Secure credential injection architecture and configuration
- [Domain Filtering Guide](/gh-aw-firewall/guides/domain-filtering) - Allowlists, blocklists, wildcards, and protocol-specific filtering
- [Playwright Testing](/gh-aw-firewall/guides/playwright-testing) - Using the `localhost` keyword for local development
- [SSL Bump Reference](/gh-aw-firewall/reference/ssl-bump/) - HTTPS content inspection and URL filtering
- [Quick Start Guide](/gh-aw-firewall/quickstart) - Getting started with examples
- [Usage Guide](/gh-aw-firewall/usage) - Detailed usage patterns and examples
- [Troubleshooting](/gh-aw-firewall/troubleshooting) - Common issues and solutions
- [Security Architecture](/gh-aw-firewall/reference/security-architecture) - How the firewall works internally
