# Architecture

## Overview

The firewall uses a containerized architecture with Squid proxy for L7 (HTTP/HTTPS) egress control. The system provides domain-based whitelisting while maintaining full filesystem access for the Copilot CLI and its MCP servers.

## High-Level Architecture

```
┌─────────────────────────────────────────┐
│  Host (GitHub Actions Runner / Local)   │
│                                          │
│  ┌────────────────────────────────────┐ │
│  │   Firewall CLI                    │ │
│  │   - Parse arguments                │ │
│  │   - Generate Squid config          │ │
│  │   - Start Docker Compose           │ │
│  └────────────────────────────────────┘ │
│           │                              │
│           ▼                              │
│  ┌──────────────────────────────────┐   │
│  │   Docker Compose                 │   │
│  │  ┌────────────────────────────┐  │   │
│  │  │  Squid Proxy Container     │  │   │
│  │  │  - Domain ACL filtering    │  │   │
│  │  │  - HTTP/HTTPS proxy        │  │   │
│  │  └────────────────────────────┘  │   │
│  │           ▲                       │   │
│  │  ┌────────┼───────────────────┐  │   │
│  │  │ Agent Container            │  │   │
│  │  │ - Full filesystem access   │  │   │
│  │  │ - iptables redirect        │  │   │
│  │  │ - Spawns MCP servers       │  │   │
│  │  │ - All traffic → Squid      │  │   │
│  │  └────────────────────────────┘  │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## Core Components

### 1. CLI Entry Point (`src/cli.ts`)
- Uses `commander` for argument parsing
- Orchestrates the entire workflow: config generation → container startup → command execution → cleanup
- Handles signal interrupts (SIGINT/SIGTERM) for graceful shutdown
- Main flow: `writeConfigs()` → `startContainers()` → `runAgentCommand()` → `stopContainers()` → `cleanup()`

### 2. Configuration Generation
- **`src/squid-config.ts`**: Generates Squid proxy configuration with domain ACL rules
- **`src/compose-generator.ts`**: Generates Docker Compose YAML with two services (squid-proxy, agent)
- All configs are written to a temporary work directory (default: `/tmp/awf-<timestamp>`)

### 3. Docker Management
- **`src/container-lifecycle.ts`**: Manages container startup and agent command execution using `execa`
- **`src/container-cleanup.ts`**: Handles container teardown, log collection, and cleanup
- **`src/host-env.ts`**: Host environment utilities (UID/GID mapping, env passthrough, filesystem helpers)
- **`src/services/`**: Service classes for each container (Squid, agent, API proxy, CLI proxy, DoH proxy)
- Fixed network topology: `172.30.0.0/24` subnet, Squid at `172.30.0.10`, Agent at `172.30.0.20`
- Squid container uses healthcheck; Agent waits for Squid to be healthy before starting
- `src/docker-manager.ts` re-exports the public API from the above modules for backward compatibility

### 4. Type Definitions (`src/types/`)
- `WrapperConfig`: Main configuration interface (`src/types/wrapper-config.ts`)
- API/CLI proxy port constants (`src/types/ports.ts`)
- Docker Compose types (`src/types/docker.ts`)
- Logging, policy, and PID types in separate modules

### 5. Logging (`src/logger.ts`)
- Singleton logger with configurable log levels (debug, info, warn, error)
- Uses `chalk` for colored output
- All logs go to stderr (console.error) to avoid interfering with command stdout

## Container Architecture

### Squid Container (`containers/squid/`)
- Based on `alpine:3.24` with Squid installed from Alpine packages
- Mounts dynamically-generated `squid.conf` from work directory
- Exposes port 3128 for proxy traffic
- Logs to shared volume `squid-logs:/var/log/squid`
- **Network:** Connected to `awf-net` at `172.30.0.10`
- **Firewall Exemption:** Allowed unrestricted outbound access via iptables rule `-s 172.30.0.10 -j ACCEPT`

### Agent Execution Container (`containers/agent/`)
- Based on `ubuntu:22.04` with iptables, curl, git, nodejs, npm
- Mounts entire host filesystem at `/host` and user home directory for full access
- `NET_ADMIN` capability required for iptables setup during initialization
- **Security:** `NET_ADMIN` is dropped via `capsh --drop=cap_net_admin` before executing user commands, preventing malicious code from modifying iptables rules
- **Chroot Mode:** User commands run inside `chroot /host` for transparent host binary access. See [Chroot Mode](./chroot-mode.md) for details.
- Two-stage entrypoint:
  1. `setup-iptables.sh`: Configures iptables NAT rules to redirect HTTP/HTTPS traffic to Squid (agent container only)
  2. `entrypoint.sh`: Drops NET_ADMIN capability, then executes user command as non-root user
- Key iptables rules (in `setup-iptables.sh`):
  - Allow localhost traffic (for stdio MCP servers)
  - Allow DNS queries
  - Allow traffic to Squid proxy itself
  - Redirect all HTTP (port 80) and HTTPS (port 443) to Squid via DNAT (NAT table)

## Traffic Flow

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

## How It Works

### 1. Configuration Generation
The wrapper generates:
- **Squid configuration** with domain ACLs
- **Docker Compose** configuration for both containers
- **Temporary work directory** for configs and logs

### 2. Container Startup
1. **Squid proxy starts first** with healthcheck
2. **Agent container waits** for Squid to be healthy
3. **iptables rules applied** in agent container to redirect all HTTP/HTTPS traffic

### 3. Traffic Routing
- All HTTP (port 80) and HTTPS (port 443) traffic → Squid proxy
- Squid filters based on domain whitelist
- Localhost traffic exempt (for stdio MCP servers)
- DNS queries allowed (for name resolution)

### 4. MCP Server Handling
- **Stdio MCP servers**: Run as child processes, no network needed
- **HTTP MCP servers**: Traffic routed through Squid proxy
- **Docker MCP servers**: Share network namespace, inherit restrictions

### 5. Log Streaming
- Container logs streamed in real-time using `docker logs -f`
- TTY disabled to prevent ANSI escape sequences
- Agent and Squid logs preserved to `/tmp/*-logs-<timestamp>/` (if created)

### 6. Cleanup
- Containers stopped and removed
- Logs moved to persistent locations:
  - Agent logs → `/tmp/awf-agent-logs-<timestamp>/` (if they exist)
  - Squid logs → `/tmp/squid-logs-<timestamp>/` (if they exist)
- Temporary files deleted (unless `--keep-containers` specified)
- Exit code propagated from agent command

## Cleanup Lifecycle

The system uses a defense-in-depth cleanup strategy across four stages to prevent Docker resource leaks:

### 1. Pre-Test Cleanup (CI/CD)
**Location:** CI/CD workflow scripts
**What:** Runs `cleanup.sh` to remove orphaned resources from previous failed runs
**Why:** Prevents Docker network subnet pool exhaustion and container name conflicts
**Critical:** Without this, `timeout` commands that kill the wrapper mid-cleanup leave networks/containers behind

### 2. Normal Exit Cleanup (Built-in)
**Location:** `src/cli.ts` (`performCleanup()`)
**What:**
- `stopContainers()` → `docker compose down -v` (stops containers, removes volumes)
- `cleanup()` → Deletes workDir (`/tmp/awf-<timestamp>`)
**Trigger:** Successful command completion

### 3. Signal/Error Cleanup (Built-in)
**Location:** `src/cli.ts` (SIGINT/SIGTERM handlers, catch blocks)
**What:** Same as normal exit cleanup
**Trigger:** User interruption (Ctrl+C), timeout signals, or errors
**Limitation:** Cannot catch SIGKILL (9) from `timeout` after grace period

### 4. CI/CD Always Cleanup
**Location:** `.github/workflows/test-*.yml` (`if: always()`)
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

## Domain Whitelisting

- Domains in `--allow-domains` are normalized (protocol/trailing slash removed)
- Both exact matches and subdomain matches are added to Squid ACL:
  - `github.com` → matches `github.com` and `.github.com` (subdomains)
  - `.github.com` → matches all subdomains
- Squid denies any domain not in the allowlist

## Exit Code Handling

The wrapper propagates the exit code from the agent container:
1. Command runs in agent container
2. Container exits with command's exit code
3. Wrapper inspects container: `docker inspect --format={{.State.ExitCode}}`
4. Wrapper exits with same code

## Configuration Files

All temporary files are created in `workDir` (default: `/tmp/awf-<timestamp>`):
- `squid.conf`: Generated Squid proxy configuration
- `docker-compose.yml`: Generated Docker Compose configuration
- `agent-logs/`: Directory for agent logs (automatically preserved if logs are created)
- `squid-logs/`: Directory for Squid proxy logs (automatically preserved if logs are created)

Use `--keep-containers` to preserve containers and files after execution for debugging.

## Key Dependencies

- `commander`: CLI argument parsing
- `chalk`: Colored terminal output
- `execa`: Subprocess execution (docker-compose commands)
- `js-yaml`: YAML generation for Docker Compose config
- TypeScript 5.x, compiled to ES2020 CommonJS
