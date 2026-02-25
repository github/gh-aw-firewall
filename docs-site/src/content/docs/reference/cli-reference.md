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
| `--block-domains <domains>` | string | — | Comma-separated list of blocked domains (takes precedence over allowed) |
| `--block-domains-file <path>` | string | — | Path to file containing blocked domains |
| `--ssl-bump` | flag | `false` | Enable SSL Bump for HTTPS content inspection |
| `--allow-urls <urls>` | string | — | Comma-separated list of allowed URL patterns (requires `--ssl-bump`) |
| `--log-level <level>` | string | `info` | Logging verbosity: `debug`, `info`, `warn`, `error` |
| `--keep-containers` | flag | `false` | Keep containers running after command exits |
| `--tty` | flag | `false` | Allocate pseudo-TTY for interactive tools |
| `--work-dir <dir>` | string | `/tmp/awf-<timestamp>` | Working directory for temporary files |
| `--build-local` | flag | `false` | Build containers locally instead of pulling from registry |
| `--image-registry <url>` | string | `ghcr.io/github/gh-aw-firewall` | Container image registry |
| `--image-tag <tag>` | string | `latest` | Container image tag |
| `--skip-pull` | flag | `false` | Use local images without pulling from registry |
| `-e, --env <KEY=VALUE>` | string | `[]` | Environment variable (repeatable) |
| `--env-all` | flag | `false` | Pass all host environment variables |
| `-v, --mount <host:container[:mode]>` | string | `[]` | Volume mount (repeatable) |
| `--container-workdir <dir>` | string | User home | Working directory inside container |
| `--dns-servers <servers>` | string | `8.8.8.8,8.8.4.4` | Trusted DNS servers (comma-separated) |
| `--proxy-logs-dir <path>` | string | — | Directory to save Squid proxy logs to |
| `--enable-host-access` | flag | `false` | Enable access to host services via host.docker.internal |
| `--allow-host-ports <ports>` | string | `80,443` | Ports to allow when using --enable-host-access |
| `--agent-image <value>` | string | `default` | Agent container image (default, act, or custom) |
| `-V, --version` | flag | — | Display version |
| `-h, --help` | flag | — | Display help |

## Options Details

### `--allow-domains <domains>`

Comma-separated list of allowed domains. Domains automatically match all subdomains. Supports wildcard patterns and protocol-specific filtering.

**If no domains are specified, all network access is blocked.** This is useful for running commands that should have no network access.

```bash
# Allow specific domains
--allow-domains github.com,npmjs.org
--allow-domains '*.github.com,api-*.example.com'

# No network access (empty or omitted)
awf -- echo "offline command"
```

#### Protocol-Specific Filtering

Restrict domains to HTTP-only or HTTPS-only traffic by prefixing with the protocol:

```bash
# HTTPS only - blocks HTTP traffic to this domain
--allow-domains 'https://secure.example.com'

# HTTP only - blocks HTTPS traffic to this domain
--allow-domains 'http://legacy-api.example.com'

# Both protocols (default behavior, backward compatible)
--allow-domains 'example.com'

# Mixed configuration
--allow-domains 'example.com,https://secure.example.com,http://legacy.example.com'

# Works with wildcards
--allow-domains 'https://*.secure.example.com'
```

### `--allow-domains-file <path>`

Path to file with allowed domains. Supports comments (`#`) and one domain per line.

```bash
--allow-domains-file ./allowed-domains.txt
```

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
Requires manual cleanup: `docker stop awf-squid awf-copilot && docker network rm awf-net`
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
May expose sensitive credentials. Prefer `-e` for specific variables.
:::

### `-v, --mount <host_path:container_path[:mode]>`

Mount host directories into container. Format: `host_path:container_path[:ro|rw]`

```bash
-v /data:/data:ro -v /tmp/output:/output:rw
```

**Requirements:**
- Both paths must be absolute
- Host path must exist
- Mode: `ro` (read-only) or `rw` (read-write)

**Default mounts:**
- Host filesystem at `/host` (read-only)
- User home directory (read-write)

### `--container-workdir <dir>`

Working directory inside the container.

### `--dns-servers <servers>`

Comma-separated list of trusted DNS servers. DNS traffic is **only** allowed to these servers, preventing DNS-based data exfiltration. Both IPv4 and IPv6 addresses are supported.

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

### `--enable-host-access`

Enable access to host services via `host.docker.internal`. This allows containers to connect to services running on the host machine (e.g., local development servers, MCP gateways).

```bash
# Access local development server
sudo awf --enable-host-access --allow-domains host.docker.internal \
  -- curl http://host.docker.internal:3000
```

:::danger[Security Warning]
When `--enable-host-access` is enabled, containers can access services on the host machine. Use `--allow-host-ports` to restrict which ports can be accessed. Without port restrictions, all ports are allowed by default (this will change in a future version).
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
- Without `--allow-host-ports`: Currently allows all ports (will default to 80,443 in future version)
- With `--allow-host-ports`: Only specified ports are allowed

:::tip[Best Practice]
Always explicitly specify `--allow-host-ports` to ensure consistent behavior across versions.
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


## Exit Codes

| Code | Description |
|------|-------------|
| `0` | Command succeeded |
| `1-255` | Command exit code or firewall error |
| `130` | Interrupted by SIGINT (Ctrl+C) |
| `143` | Terminated by SIGTERM |

## Subcommands

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

## See Also

- [Domain Filtering Guide](/gh-aw-firewall/guides/domain-filtering) - Allowlists, blocklists, and wildcards
- [SSL Bump Reference](/gh-aw-firewall/reference/ssl-bump/) - HTTPS content inspection and URL filtering
- [Quick Start Guide](/gh-aw-firewall/quickstart) - Getting started with examples
- [Usage Guide](/gh-aw-firewall/usage) - Detailed usage patterns and examples
- [Troubleshooting](/gh-aw-firewall/troubleshooting) - Common issues and solutions
- [Security Architecture](/gh-aw-firewall/reference/security-architecture) - How the firewall works internally
