# AGENTS.md

This file provides guidance to coding agent when working with code in this repository.

## Project Overview

This is a firewall for GitHub Copilot CLI (package name: `@github/awf`) that provides L7 (HTTP/HTTPS) egress control using Squid proxy and Docker containers. The tool restricts network access to a whitelist of approved domains while maintaining full filesystem access for the Copilot CLI and its MCP servers.

### Documentation Files

- **[README.md](README.md)** - Main project documentation and usage guide
- **[docs/chroot-mode.md](docs/chroot-mode.md)** - Chroot mode for transparent host binary access
- **[docs/logging_quickref.md](docs/logging_quickref.md)** - Quick reference for log queries and monitoring
- **[docs/environment.md](docs/environment.md)** - Environment variable configuration and security best practices
- **[docs/releasing.md](docs/releasing.md)** - Release process and versioning instructions

## Development Workflow

### GitHub Actions Best Practices

**IMPORTANT:** When writing or modifying GitHub Actions workflows:

1. **Use TypeScript for workflow scripts, not bash** - All scripts that run in GitHub Actions workflows should be written in TypeScript and executed with `npx tsx`. This ensures:
   - Type safety and better IDE support
   - Consistency with the rest of the codebase
   - Easier testing and maintenance
   - Better error handling

2. **Inline script execution** - Run TypeScript scripts directly in workflow steps using `npx tsx path/to/script.ts`, rather than creating bash wrapper scripts. Example:
   ```yaml
   - name: Generate test summary
     run: |
       npx tsx scripts/ci/generate-test-summary.ts "test-file.ts" "Test Name" test-output.log
   ```

3. **Place scripts in `scripts/ci/`** - All CI/CD-related scripts should be in the `scripts/ci/` directory and written as TypeScript modules with proper type definitions.

**Example:**
- ❌ Bad: `scripts/ci/generate-summary.sh` (bash script)
- ✅ Good: `scripts/ci/generate-test-summary.ts` (TypeScript script called with `npx tsx`)

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

### Commit Message Format

**IMPORTANT:** This repository enforces [Conventional Commits](https://www.conventionalcommits.org/) via commitlint and husky hooks.

**Format:** `type(scope): subject` (scope is optional)

**Rules:**
- `type` and `subject` must be lowercase
- No period at end of subject
- Header (entire commit message first line) max 72 characters
- `scope` is optional but can help clarify the area of change
- Both commit messages AND PR titles must follow this format
- PR descriptions should be 1-2 sentences max

**Allowed scopes for PR titles:** `cli`, `docker`, `squid`, `proxy`, `ci`, `deps`
- Using scopes not in this list will cause the PR Title Check to fail with an error like:
  `Error: Unknown scope "security" found in pull request title. Scope must match one of: cli, docker, squid, proxy, ci, deps.`
- Common invalid scopes: `security`, `test`, `docs`, `core` - these are NOT allowed as scopes
- If unsure, omit the scope entirely (e.g., `fix: replace .* regex with safer patterns` instead of `fix(security): replace .* regex with safer patterns`)

**Common types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `chore`: Maintenance tasks
- `test`: Test changes
- `refactor`: Code refactoring
- `ci`: CI/CD changes

**Examples:**
- ✅ `docs: fix duplicate heading in release template`
- ✅ `docs(template): fix duplicate heading in release template`
- ✅ `feat: add new domain whitelist option`
- ✅ `fix(cleanup): resolve container cleanup race condition`
- ✅ `fix: replace .* regex with safer patterns` (no scope - preferred for security fixes)
- ✅ `test: add NET_ADMIN capability verification tests`
- ❌ `Fix bug` (missing type)
- ❌ `docs: Fix template.` (uppercase subject, period at end)
- ❌ `fix(security): replace .* regex with safer patterns` (scope `security` not in allowed list)
- ❌ `test(security): add new tests` (scope `security` not in allowed list for PR titles)

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
sudo tee /usr/local/bin/awf > /dev/null <<'EOF'
#!/bin/bash
exec ~/.nvm/versions/node/v22.13.0/bin/node \
     ~/developer/gh-aw-firewall/dist/cli.js "$@"
EOF

sudo chmod +x /usr/local/bin/awf

# Verify it works
sudo awf --help
```

**Note:** After each `npm run build`, the wrapper automatically uses the latest compiled code. Update the paths in the wrapper script to match your node installation and project directory.

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

### Localhost Keyword

The `localhost` keyword provides simplified access to host services for Playwright testing and local development:

**Usage:**
```bash
sudo awf --allow-domains localhost,playwright.dev -- npx playwright test
```

**Automatic configuration when `localhost` is specified:**
1. Maps `localhost` to `host.docker.internal` (Docker's host gateway)
2. Enables `--enable-host-access` automatically
3. Allows common development ports: 3000, 3001, 4000, 4200, 5000, 5173, 8000, 8080, 8081, 8888, 9000, 9090
4. Preserves protocol prefixes (`http://localhost` → `http://host.docker.internal`)

**Customization:**
- Use `--allow-host-ports` to override the default port list
- Example: `--allow-domains localhost --allow-host-ports 3000,8080`

**Security note:** The localhost keyword enables access to host services. Only use for trusted workloads like local testing and development.

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

## MCP Server Configuration for Copilot CLI

### Overview

GitHub Copilot CLI v0.0.347+ includes a **built-in GitHub MCP server** that connects to a read-only remote endpoint (`https://api.enterprise.githubcopilot.com/mcp/readonly`). This built-in server takes precedence over local MCP configurations by default, which prevents write operations like creating issues or pull requests.

To use a local, writable GitHub MCP server with Copilot CLI, you must:
1. Configure the MCP server in the correct location with the correct format
2. Disable the built-in GitHub MCP server
3. Ensure proper environment variable passing

### Correct MCP Configuration

**Location:** The MCP configuration must be placed at:
- `~/.copilot/mcp-config.json` (primary location)

The agent container mounts the HOME directory, so this config file is automatically accessible to GitHub Copilot CLI running inside the container.

**Format (stdio-based with npx):**
```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github-mcp-custom@1.0.20", "stdio"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

**Alternative (using Go binary):**
```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "/usr/local/bin/github-mcp-server",
      "args": ["stdio"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

**Key Requirements:**
- ✅ **`"type": "stdio"`** - Uses stdio transport (not Docker)
- ✅ **`"env"` section** - Environment variables must be declared here with `${VAR}` syntax for interpolation
- ✅ **Shell environment** - Variables must be exported in the shell before running awf
- ✅ **MCP server name** - Use `"github"` as the server name (must match `--allow-tool` flag)
- ✅ **npx availability** - The agent container includes Node.js 22 with npx pre-installed

**Note:** As of v0.9.1, Docker-in-Docker support was removed ([PR #205](https://github.com/github/gh-aw-firewall/pull/205)). Use stdio-based MCP servers instead of Docker-based ones.

### Running Copilot CLI with Local MCP Through Firewall

**Required setup:**
```bash
# Export environment variables (both required)
export GITHUB_TOKEN="<your-copilot-cli-token>"           # For Copilot CLI authentication
export GITHUB_PERSONAL_ACCESS_TOKEN="<your-github-pat>"  # For GitHub MCP server

# Run awf with sudo -E to preserve environment variables
sudo -E awf \
  --allow-domains raw.githubusercontent.com,api.github.com,github.com,registry.npmjs.org,api.enterprise.githubcopilot.com \
  "npx @github/copilot@0.0.347 \
    --disable-builtin-mcps \
    --allow-tool github \
    --prompt 'your prompt here'"
```

**Critical requirements:**
- `sudo -E` - **REQUIRED** to pass environment variables through sudo to the agent container
- `--disable-builtin-mcps` - Disables the built-in read-only GitHub MCP server
- `--allow-tool github` - Grants permission to use all tools from the `github` MCP server (must match server name in config)
- MCP config at `~/.copilot/mcp-config.json` - Automatically accessible since agent container mounts HOME directory

**Why `sudo -E` is required:**
1. `awf` needs sudo for iptables manipulation
2. `-E` preserves GITHUB_TOKEN and GITHUB_PERSONAL_ACCESS_TOKEN
3. These variables are passed into the agent container via the HOME directory mount
4. The stdio-based MCP server (running via npx) inherits them from the agent container's environment

### Troubleshooting

**Problem:** MCP server starts but says "GITHUB_PERSONAL_ACCESS_TOKEN not set"
- **Cause:** Environment variable not passed correctly through sudo
- **Solution:** Use `sudo -E` when running awf, and ensure the variable is exported before running the command

**Problem:** MCP config validation error: "Invalid input"
- **Cause:** Invalid configuration format or missing required fields
- **Solution:** Ensure `"type": "stdio"` and `"env"` section are properly configured

**Problem:** Copilot uses read-only remote MCP instead of local
- **Cause:** Built-in MCP not disabled
- **Solution:** Add `--disable-builtin-mcps` flag to the copilot command

**Problem:** Tools not available even with local MCP
- **Cause:** Wrong server name in `--allow-tool` flag
- **Solution:** Use `--allow-tool github` (must match the server name in mcp-config.json)

**Problem:** Permission denied when running awf
- **Cause:** iptables requires root privileges
- **Solution:** Use `sudo -E awf` (not just `sudo awf`)

### Verifying Local MCP Usage

Check GitHub Copilot CLI logs (use `--log-level debug`) for these indicators:

**Local MCP working:**
```
Starting MCP client for github with command: npx
GitHub MCP Server running on stdio
readOnly=false
MCP client for github connected
```

**Built-in remote MCP (not what you want):**
```
Using Copilot API endpoint: https://api.enterprise.githubcopilot.com/mcp/readonly
Starting remote MCP client for github-mcp-server
```

### CI/CD Configuration

For GitHub Actions workflows:
1. Create MCP config script that writes to `~/.copilot/mcp-config.json` (note: `~` = `/home/runner` in GitHub Actions)
2. Export both `GITHUB_TOKEN` (for GitHub Copilot CLI) and `GITHUB_PERSONAL_ACCESS_TOKEN` (for GitHub MCP server) as environment variables
3. Use stdio-based MCP configuration (npx or Go binary) - Docker-based MCP servers are no longer supported as of v0.9.1
4. Run awf with `sudo -E` to preserve environment variables
5. Always use `--disable-builtin-mcps` and `--allow-tool github` flags when running GitHub Copilot CLI

**Example workflow step:**
```yaml
- name: Test GitHub Copilot CLI with GitHub MCP through firewall
  env:
    GITHUB_TOKEN: ${{ secrets.COPILOT_CLI_TOKEN }}
    GITHUB_PERSONAL_ACCESS_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    sudo -E awf \
      --allow-domains raw.githubusercontent.com,api.github.com,github.com,registry.npmjs.org,api.enterprise.githubcopilot.com \
      "npx @github/copilot@0.0.347 \
        --disable-builtin-mcps \
        --allow-tool github \
        --log-level debug \
        --prompt 'your prompt here'"
```

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
