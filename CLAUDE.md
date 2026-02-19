# AGENTS.md

This file provides guidance to coding agent when working with code in this repository.

## Project Overview

This is a firewall for GitHub Copilot CLI (package name: `@github/awf`) that provides L7 (HTTP/HTTPS) egress control using Squid proxy and Docker containers. The tool restricts network access to a whitelist of approved domains while maintaining full filesystem access for the Copilot CLI and its MCP servers.

### Documentation Files

- **[README.md](README.md)** - Main project documentation and usage guide
- **[docs/environment.md](docs/environment.md)** - Environment variable configuration and security best practices
- **[LOGGING.md](LOGGING.md)** - Comprehensive logging documentation
- **[docs/logging_quickref.md](docs/logging_quickref.md)** - Quick reference for log queries and monitoring
- **[docs/releasing.md](docs/releasing.md)** - Release process and versioning instructions

## Development Workflow

### Debugging GitHub Actions Failures

**IMPORTANT:** When GitHub Actions workflows fail, always follow this debugging workflow:

1. **Reproduce locally first** - Run the same commands/scripts that failed in CI on your local machine
2. **Understand the root cause** - Investigate logs, error messages, and system state to identify why it failed
3. **Test the fix locally** - Verify your solution works in your local environment
4. **Then update the action** - Only modify the GitHub Actions workflow after confirming the fix locally

This approach prevents trial-and-error debugging in CI (which wastes runner time and makes debugging slower) and ensures fixes address the actual root cause rather than symptoms.

**Downloading CI Logs for Local Analysis:**

Use `scripts/download-latest-artifact.sh` to download logs from GitHub Actions runs:

```bash
# Download logs from the latest integration test workflow run (default)
./scripts/download-latest-artifact.sh

# Download logs from a specific run ID
./scripts/download-latest-artifact.sh 1234567890

# Download from test-coverage workflow (latest run)
./scripts/download-latest-artifact.sh "" ".github/workflows/test-coverage.yml" "coverage-report"
```

**Parameters:**
- `RUN_ID` (optional): Specific workflow run ID, or empty string for latest run
- `WORKFLOW_FILE` (optional): Path to workflow file (default: `.github/workflows/test-coverage.yml`)
- `ARTIFACT_NAME` (optional): Artifact name (default: `coverage-report`)

**Artifact name:**
- `coverage-report` - test-coverage.yml

This downloads artifacts to `./artifacts-run-$RUN_ID` for local examination. Requires GitHub CLI (`gh`) authenticated with the repository.

**Example:** The "Pool overlaps" Docker network error was reproduced locally, traced to orphaned networks from `timeout`-killed processes, fixed by adding pre-test cleanup in scripts, then verified before updating workflows.

## Development Commands

### Build and Testing
```bash
# Build TypeScript to dist/
npm run build

# Watch mode (rebuilds on changes)
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm test:watch

# Lint TypeScript files
npm run lint

# Clean build artifacts
npm run clean
```

### Workflow Compilation

**IMPORTANT:** When modifying smoke or build-test workflow `.md` files, you MUST run the post-processing script after compiling. The compiled `.lock.yml` files need post-processing to replace GHCR image references with local builds, remove sparse-checkout, and install awf from source.

```bash
# 1. Compile the workflow(s)
gh-aw compile .github/workflows/smoke-claude.md

# 2. Post-process ALL lock files (always run this after any compile)
npx tsx scripts/ci/postprocess-smoke-workflows.ts
```

The post-processing script (`scripts/ci/postprocess-smoke-workflows.ts`) applies these transformations to lock files:
- Replaces the "Install awf binary" step with local `npm ci && npm run build` steps
- Removes sparse-checkout blocks (full repo needed for npm build)
- Removes shallow depth settings
- Replaces `--image-tag <version> --skip-pull` with `--build-local`

### Local Installation

**For regular use:**
```bash
# Link locally for testing
npm link

# Use the CLI
awf --allow-domains github.com 'curl https://api.github.com'
```

**For sudo usage (required for iptables manipulation):**

Since `npm link` creates symlinks in the user's npm directory which isn't in root's PATH, you need to create a wrapper script in `/usr/local/bin/`:

```bash
# Build the project
npm run build

# Create sudo wrapper script
# Update the paths below to match your system:
# - NODE_PATH: Find with `which node` (example shows nvm installation)
# - PROJECT_PATH: Your cloned repository location
sudo tee /usr/local/bin/awf > /dev/null <<'EOF'
#!/bin/bash
NODE_PATH="$HOME/.nvm/versions/node/v22.13.0/bin/node"
PROJECT_PATH="$HOME/developer/gh-aw-firewall"

exec "$NODE_PATH" "$PROJECT_PATH/dist/cli.js" "$@"
EOF

sudo chmod +x /usr/local/bin/awf

# Verify it works
sudo awf --help
```

**Note:** After each `npm run build`, the wrapper automatically uses the latest compiled code. Update the paths in the wrapper script to match your node installation and project directory.

## Container Image Strategy

The firewall uses two Docker containers (Squid proxy and agent execution environment). By default, the CLI pulls pre-built images from GitHub Container Registry (GHCR) for faster startup and easier distribution.

**Default behavior (GHCR images):**
- Images are automatically pulled from `ghcr.io/github/gh-aw-firewall/squid:latest` and `ghcr.io/github/gh-aw-firewall/agent:latest`
- Published during releases via `.github/workflows/release.yml`
- Users don't need to build containers locally

**Local build option:**
- Use `--build-local` flag to build containers from source
- Useful for development or when GHCR is unavailable
- Example: `sudo awf --build-local --allow-domains github.com 'curl https://github.com'`

**Custom registry/tag:**
- `--image-registry <registry>` - Use a different registry (default: `ghcr.io/github/gh-aw-firewall`)
- `--image-tag <tag>` - Use a specific version tag (default: `latest`)
- Example: `sudo awf --image-tag v0.2.0 --allow-domains github.com 'curl https://github.com'`

## Architecture

The codebase follows a modular architecture with clear separation of concerns:

### Core Components

1. **CLI Entry Point** (`src/cli.ts`)
   - Uses `commander` for argument parsing
   - Orchestrates the entire workflow: config generation → container startup → command execution → cleanup
   - Handles signal interrupts (SIGINT/SIGTERM) for graceful shutdown
   - Main flow: `writeConfigs()` → `startContainers()` → `runAgentCommand()` → `stopContainers()` → `cleanup()`

2. **Configuration Generation** (`src/squid-config.ts`, `src/docker-manager.ts`)
   - `generateSquidConfig()`: Creates Squid proxy configuration with domain ACL rules
   - `generateDockerCompose()`: Creates Docker Compose YAML with two services (squid-proxy, agent)
   - All configs are written to a temporary work directory (default: `/tmp/awf-<timestamp>`)

3. **Docker Management** (`src/docker-manager.ts`)
   - Manages container lifecycle using `execa` to run docker-compose commands
   - Fixed network topology: `172.30.0.0/24` subnet, Squid at `172.30.0.10`, Agent at `172.30.0.20`
   - Squid container uses healthcheck; Agent waits for Squid to be healthy before starting

4. **Type Definitions** (`src/types.ts`)
   - `WrapperConfig`: Main configuration interface
   - `SquidConfig`, `DockerComposeConfig`: Typed configuration objects

5. **Logging** (`src/logger.ts`)
   - Singleton logger with configurable log levels (debug, info, warn, error)
   - Uses `chalk` for colored output
   - All logs go to stderr (console.error) to avoid interfering with command stdout

### Container Architecture

**Squid Container** (`containers/squid/`)
- Based on `ubuntu/squid:latest`
- Mounts dynamically-generated `squid.conf` from work directory
- Exposes port 3128 for proxy traffic
- Logs to shared volume `squid-logs:/var/log/squid`
- **Network:** Connected to `awf-net` at `172.30.0.10`
- **Firewall Exemption:** Allowed unrestricted outbound access via iptables rule `-s 172.30.0.10 -j ACCEPT`

**Agent Execution Container** (`containers/agent/`)
- Based on `ubuntu:22.04` with iptables, curl, git, nodejs, npm
- Mounts entire host filesystem at `/host` and user home directory for full access
- `NET_ADMIN` capability required for iptables setup during initialization
- **Security:** `NET_ADMIN` is dropped via `capsh --drop=cap_net_admin` before executing user commands, preventing malicious code from modifying iptables rules
- Two-stage entrypoint:
  1. `setup-iptables.sh`: Configures iptables NAT rules to redirect HTTP/HTTPS traffic to Squid (agent container only)
  2. `entrypoint.sh`: Drops NET_ADMIN capability, then executes user command as non-root user
- Key iptables rules (in `setup-iptables.sh`):
  - Allow localhost traffic (for stdio MCP servers)
  - Allow DNS queries
  - Allow traffic to Squid proxy itself
  - Redirect all HTTP (port 80) and HTTPS (port 443) to Squid via DNAT (NAT table)

### Traffic Flow

```
User Command
    ↓
CLI generates configs (squid.conf, docker-compose.yml)
    ↓
Docker Compose starts Squid container (with healthcheck)
    ↓
Docker Compose starts Agent container (waits for Squid healthy)
    ↓
iptables rules applied in Agent container
    ↓
User command executes in Agent container
    ↓
All HTTP/HTTPS traffic → iptables DNAT → Squid proxy → domain ACL filtering
    ↓
Containers stopped, temporary files cleaned up
```

## Domain Whitelisting

- Domains in `--allow-domains` are normalized (protocol/trailing slash removed)
- Both exact matches and subdomain matches are added to Squid ACL:
  - `github.com` → matches `github.com` and `.github.com` (subdomains)
  - `.github.com` → matches all subdomains
- Squid denies any domain not in the allowlist

## DNS Configuration

DNS traffic is restricted to trusted DNS servers only to prevent DNS-based data exfiltration:

- **CLI Option**: `--dns-servers <servers>` (comma-separated list of IP addresses)
- **Default**: Google DNS (`8.8.8.8,8.8.4.4`)
- **IPv6 Support**: Both IPv4 and IPv6 DNS servers are supported
- **Docker DNS**: `127.0.0.11` is always allowed for container name resolution

**Implementation**:
- Host-level iptables (`src/host-iptables.ts`): DNS traffic to non-whitelisted servers is blocked
- Container NAT rules (`containers/agent/setup-iptables.sh`): Reads from `AWF_DNS_SERVERS` env var
- Container DNS config (`containers/agent/entrypoint.sh`): Configures `/etc/resolv.conf`
- Docker Compose (`src/docker-manager.ts`): Sets container `dns:` config and `AWF_DNS_SERVERS` env var

## Proxy Environment Variables

AWF sets the following proxy-related environment variables in the agent container:

- `HTTP_PROXY` / `HTTPS_PROXY`: Standard proxy variables (used by curl, wget, pip, npm, etc.)
- `SQUID_PROXY_HOST` / `SQUID_PROXY_PORT`: Raw proxy host and port for tools that need them separately
- `JAVA_TOOL_OPTIONS`: JVM system properties (`-Dhttp.proxyHost`, `-Dhttps.proxyHost`, etc.) for Java tools. Works for Gradle, SBT, and most JVM tools. **Maven requires separate `~/.m2/settings.xml` configuration** — see `docs/troubleshooting.md`.

**Example**:
```bash
# Use Cloudflare DNS instead of Google DNS
sudo awf --allow-domains github.com --dns-servers 1.1.1.1,1.0.0.1 -- curl https://api.github.com
```

## Exit Code Handling

The wrapper propagates the exit code from the agent container:
1. Command runs in agent container
2. Container exits with command's exit code
3. Wrapper inspects container: `docker inspect --format={{.State.ExitCode}}`
4. Wrapper exits with same code

## Cleanup Lifecycle

The system uses a defense-in-depth cleanup strategy across four stages to prevent Docker resource leaks:

### 1. Pre-Test Cleanup (CI/CD Scripts)
**Location:** `scripts/ci/test-agent-*.sh` (start of each script)
**What:** Runs `cleanup.sh` to remove orphaned resources from previous failed runs
**Why:** Prevents Docker network subnet pool exhaustion and container name conflicts
**Critical:** Without this, `timeout` commands that kill the wrapper mid-cleanup leave networks/containers behind

### 2. Normal Exit Cleanup (Built-in)
**Location:** `src/cli.ts:117-118` (`performCleanup()`)
**What:**
- `stopContainers()` → `docker compose down -v` (stops containers, removes volumes)
- `cleanup()` → Deletes workDir (`/tmp/awf-<timestamp>`)
**Trigger:** Successful command completion

### 3. Signal/Error Cleanup (Built-in)
**Location:** `src/cli.ts:95-103, 122-126` (SIGINT/SIGTERM handlers, catch blocks)
**What:** Same as normal exit cleanup
**Trigger:** User interruption (Ctrl+C), timeout signals, or errors
**Limitation:** Cannot catch SIGKILL (9) from `timeout` after grace period

### 4. CI/CD Always Cleanup
**Location:** `.github/workflows/test-agent-*.yml` (`if: always()`)
**What:** Runs `cleanup.sh` regardless of job status
**Why:** Safety net for SIGKILL, job cancellation, and unexpected failures

### Cleanup Script (`scripts/ci/cleanup.sh`)
Removes all awf resources:
- Containers by name (`awf-squid`, `awf-agent`)
- All docker-compose services from work directories
- Unused containers (`docker container prune -f`)
- Unused networks (`docker network prune -f`) - **critical for subnet pool management**
- Temporary directories (`/tmp/awf-*`)

**Note:** Test scripts use `timeout 60s` which can kill the wrapper before Stage 2/3 cleanup completes. Stage 1 (pre-test) and Stage 4 (always) prevent accumulation across test runs.

## Configuration Files

All temporary files are created in `workDir` (default: `/tmp/awf-<timestamp>`):
- `squid.conf`: Generated Squid proxy configuration
- `docker-compose.yml`: Generated Docker Compose configuration
- `agent-logs/`: Directory for agent logs (automatically preserved if logs are created)
- `squid-logs/`: Directory for Squid proxy logs (automatically preserved if logs are created)

Use `--keep-containers` to preserve containers and files after execution for debugging.

## Log Streaming and Persistence

### Real-Time Log Streaming

The wrapper streams container logs in real-time using `docker logs -f`, allowing you to see output as commands execute rather than waiting until completion. This is implemented in `src/docker-manager.ts:runAgentCommand()` which runs `docker logs -f` concurrently with `docker wait`.

**Note:** The container is configured with `tty: false` (line 202 in `src/docker-manager.ts`) to prevent ANSI escape sequences from appearing in log output. This provides cleaner, more readable streaming logs.

### Agent Logs Preservation

Agent logs (including GitHub Copilot CLI logs) are automatically preserved for debugging:

**Directory Structure:**
- Container writes logs to: `~/.copilot/logs/` (GitHub Copilot CLI's default location)
- Volume mount maps to: `${workDir}/agent-logs/`
- After cleanup: Logs moved to `/tmp/awf-agent-logs-<timestamp>` (if they exist)

**Automatic Preservation:**
- If agent creates logs, they're automatically moved to `/tmp/awf-agent-logs-<timestamp>/` before workDir cleanup
- Empty log directories are not preserved (avoids cluttering /tmp)
- You'll see: `[INFO] Agent logs preserved at: /tmp/awf-agent-logs-<timestamp>` when logs exist

**With `--keep-containers`:**
- Logs remain at: `${workDir}/agent-logs/`
- All config files and containers are preserved
- You'll see: `[INFO] Agent logs available at: /tmp/awf-<timestamp>/agent-logs/`

**Usage Examples:**
```bash
# Logs automatically preserved (if created)
awf --allow-domains github.com \
  "npx @github/copilot@0.0.347 -p 'your prompt' --log-level debug --allow-all-tools"
# Output: [INFO] Agent logs preserved at: /tmp/awf-agent-logs-1761073250147

# Increase log verbosity for debugging
awf --allow-domains github.com \
  "npx @github/copilot@0.0.347 -p 'your prompt' --log-level all --allow-all-tools"

# Keep everything for detailed inspection
awf --allow-domains github.com --keep-containers \
  "npx @github/copilot@0.0.347 -p 'your prompt' --log-level debug"
```

**Implementation Details:**
- Volume mount added in `src/docker-manager.ts:172`
- Log directory creation in `src/docker-manager.ts:247-252`
- Preservation logic in `src/docker-manager.ts:540-550` (cleanup function)

### Squid Logs Preservation

Squid proxy logs are automatically preserved for debugging network traffic:

**Directory Structure:**
- Container writes logs to: `/var/log/squid/` (Squid's default location)
- Volume mount maps to: `${workDir}/squid-logs/`
- After cleanup: Logs moved to `/tmp/squid-logs-<timestamp>` (if they exist)

**Automatic Preservation:**
- If Squid creates logs, they're automatically moved to `/tmp/squid-logs-<timestamp>/` before workDir cleanup
- Empty log directories are not preserved (avoids cluttering /tmp)
- You'll see: `[INFO] Squid logs preserved at: /tmp/squid-logs-<timestamp>` when logs exist

**With `--keep-containers`:**
- Logs remain at: `${workDir}/squid-logs/`
- All config files and containers are preserved
- You'll see: `[INFO] Squid logs available at: /tmp/awf-<timestamp>/squid-logs/`

**Log Files:**
- `access.log`: All HTTP/HTTPS traffic with custom format showing domains, IPs, and allow/deny decisions
- `cache.log`: Squid internal diagnostic messages

**Viewing Logs:**
```bash
# Logs are owned by the 'proxy' user (from container), requires sudo on host
sudo cat /tmp/squid-logs-<timestamp>/access.log

# Example log entries:
# Allowed: TCP_TUNNEL:HIER_DIRECT with status 200
# Denied: TCP_DENIED:HIER_NONE with status 403
```

**Usage Examples:**
```bash
# Check which domains were blocked
sudo grep "TCP_DENIED" /tmp/squid-logs-<timestamp>/access.log

# View all traffic
sudo cat /tmp/squid-logs-<timestamp>/access.log
```

**Implementation Details:**
- Volume mount in `src/docker-manager.ts:135`
- Log directory creation in `src/docker-manager.ts:254-261`
- Entrypoint script fixes permissions: `containers/squid/entrypoint.sh`
- Preservation logic in `src/docker-manager.ts:552-562` (cleanup function)

## Key Dependencies

- `commander`: CLI argument parsing
- `chalk`: Colored terminal output
- `execa`: Subprocess execution (docker-compose commands)
- `js-yaml`: YAML generation for Docker Compose config
- TypeScript 5.x, compiled to ES2020 CommonJS

## Testing Notes

- Tests use Jest (`npm test`)
- Currently no test files exist (tsconfig excludes `**/*.test.ts`)
- Integration testing: Run commands with `--log-level debug` and `--keep-containers` to inspect generated configs and container logs

## Logging Implementation

### Overview

The firewall implements comprehensive logging at two levels:

1. **Squid Proxy Logs (L7)** - All HTTP/HTTPS traffic (allowed and blocked)
2. **iptables Kernel Logs (L3/L4)** - Non-HTTP protocols and UDP traffic

### Key Files

- `src/squid-config.ts` - Generates Squid config with custom `firewall_detailed` logformat
- `containers/agent/setup-iptables.sh` - Configures iptables LOG rules for rejected traffic
- `src/squid-config.test.ts` - Tests for logging configuration

### Squid Log Format

Custom format defined in `src/squid-config.ts:40`:
```
logformat firewall_detailed %ts.%03tu %>a:%>p %{Host}>h %<a:%<p %rv %rm %>Hs %Ss:%Sh %ru "%{User-Agent}>h"
```

Captures:
- Timestamp with milliseconds
- Client IP:port
- Domain (Host header / SNI)
- Destination IP:port
- Protocol version
- HTTP method
- Status code (200=allowed, 403=blocked)
- Decision code (TCP_TUNNEL=allowed, TCP_DENIED=blocked)
- URL
- User agent

### iptables Logging

Two LOG rules in `setup-iptables.sh`:

1. **Line 80** - `[FW_BLOCKED_UDP]` prefix for blocked UDP traffic
2. **Line 95** - `[FW_BLOCKED_OTHER]` prefix for other blocked traffic

Both use `--log-uid` flag to capture process UID.

### Testing Logging

Run tests:
```bash
npm test -- squid-config.test.ts
```

Manual testing:
```bash
# Test blocked traffic
awf --allow-domains example.com --keep-containers 'curl https://github.com'

# View logs
docker exec awf-squid cat /var/log/squid/access.log
```

### Important Notes

- Squid logs use Unix timestamps (convert with `date -d @TIMESTAMP`)
- Decision codes: `TCP_DENIED:HIER_NONE` = blocked, `TCP_TUNNEL:HIER_DIRECT` = allowed
- SNI is captured via CONNECT method for HTTPS (no SSL inspection)
- iptables logs go to kernel buffer (view with `dmesg`)
- PID not directly available (UID can be used for correlation)

## Log Analysis Commands

The CLI includes built-in commands for aggregating and summarizing firewall logs.

### Commands

**`awf logs stats`** - Show aggregated statistics from firewall logs
- Default format: `pretty` (colorized terminal output)
- Outputs: total requests, allowed/denied counts, unique domains, per-domain breakdown

**`awf logs summary`** - Generate summary report (optimized for GitHub Actions)
- Default format: `markdown` (GitHub-flavored markdown)
- Designed for piping directly to `$GITHUB_STEP_SUMMARY`

### Output Formats

Both commands support `--format <format>`:
- `pretty` - Colorized terminal output with percentages and aligned columns
- `markdown` - GitHub-flavored markdown with collapsible details section
- `json` - Structured JSON for programmatic consumption

### Key Files

- `src/logs/log-aggregator.ts` - Aggregation logic (`aggregateLogs()`, `loadAllLogs()`, `loadAndAggregate()`)
- `src/logs/stats-formatter.ts` - Format output (`formatStatsJson()`, `formatStatsMarkdown()`, `formatStatsPretty()`)
- `src/commands/logs-stats.ts` - Stats command handler
- `src/commands/logs-summary.ts` - Summary command handler

### Data Structures

```typescript
// Per-domain statistics
interface DomainStats {
  domain: string;
  allowed: number;
  denied: number;
  total: number;
}

// Aggregated statistics
interface AggregatedStats {
  totalRequests: number;
  allowedRequests: number;
  deniedRequests: number;
  uniqueDomains: number;
  byDomain: Map<string, DomainStats>;
  timeRange: { start: number; end: number } | null;
}
```

### GitHub Actions Usage

```yaml
- name: Generate firewall summary
  if: always()
  run: awf logs summary >> $GITHUB_STEP_SUMMARY
```

This replaces 150+ lines of custom JavaScript parsing with a single command.
