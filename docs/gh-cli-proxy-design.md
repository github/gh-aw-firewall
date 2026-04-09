# Design: `gh` CLI Proxy for Agent Container

> **Updated**: The CLI proxy now connects to an **external** DIFC proxy (mcpg) started by the gh-aw compiler on the host, instead of managing the mcpg container internally. See [Architecture Changes](#architecture-external-difc-proxy) below.

## Problem Statement

Today, agents access GitHub data exclusively through the GitHub MCP server, which is spawned by mcpg in a separate container and communicates via the MCP protocol. This has three costs:

1. **Context bloat** — Every GitHub MCP tool (issue_read, list_commits, search_code, get_file_contents, etc.) adds its JSON schema to the agent's prompt. With 30+ tools, this is thousands of tokens per turn that never change.
2. **Result processing overhead** — MCP tool-call results are structured JSON that must be parsed in the agent's context window, adding token cost for every GitHub interaction.
3. **Unnatural interface** — Agents (especially Copilot CLI) are trained to use `gh` CLI commands. Forcing them through MCP tools requires extra prompt engineering and sometimes leads to wrong tool selection.

The constraint that makes this necessary today: `gh` CLI requires authentication (`GITHUB_TOKEN`), and the AWF security architecture deliberately keeps auth tokens out of the agent container.

## Proposed Solution

Place a **`gh` wrapper script** in the agent container that forwards each invocation over HTTP to a **cli-proxy sidecar container** on the `awf-net`. Inside the sidecar, the `gh` CLI's API calls are routed through an **mcpg proxy** (the same `gh-aw-mcpg` image used for the MCP gateway, running in `proxy` mode). This reuses the existing DIFC proxy pattern that the compiler already uses to proxy `gh` CLI calls in pre-agent steps (`compiler_difc_proxy.go` / `start_difc_proxy.sh`).

```
Agent Container                CLI-Proxy Sidecar (172.30.0.50)
(172.30.0.20)                 ┌──────────────────────────────────────────────┐
┌─────────────────┐           │                                              │
│                 │  HTTP     │  ┌────────────┐      ┌──────────────────┐   │
│  /usr/local/    │  POST     │  │ HTTP Server │      │  mcpg proxy      │   │
│  bin/gh         │──────────→│  │ (exec gh)  │─────→│  localhost:18443  │   │
│  (wrapper)      │           │  │            │      │  --tls            │   │
│                 │  stdout + │  │ GH_HOST=   │      │  --policy {...}   │   │
│  No tokens      │←──────────│  │ localhost: │      │  GH_TOKEN held    │   │
│                 │  exitCode │  │ 18443      │      │  Guard policies   │   │
└─────────────────┘           │  └────────────┘      │  Audit logging    │   │
                              │                      └────────┬─────────┘   │
                              │                               │              │
                              └───────────────────────────────┼──────────────┘
                                                              │ HTTPS
                                                              ▼
                                                    Squid (172.30.0.10:3128)
                                                              │
                                                              ▼
                                                        GitHub API
```

### Why mcpg proxy instead of direct `gh` auth

The gh-aw compiler already proxies pre-agent `gh` CLI calls through mcpg's proxy mode (see `pkg/workflow/compiler_difc_proxy.go` and `actions/setup/sh/start_difc_proxy.sh`). That pattern:

1. Runs mcpg with `proxy --policy ... --tls --guards-mode filter --listen 0.0.0.0:18443`
2. Sets `GH_HOST=localhost:18443` so `gh` CLI routes through the proxy
3. The proxy holds `GH_TOKEN`, injects auth, and applies DIFC guard policies (min-integrity, repos)
4. Generates a self-signed TLS CA cert (required because `gh` CLI enforces HTTPS)
5. Logs all proxied API calls to `/tmp/gh-aw/mcp-logs/rpc-messages.jsonl`

By reusing this same pattern inside the cli-proxy sidecar, we get guard policies, audit logging, and credential isolation "for free" — without building a new auth-injection mechanism.

## Architecture: External DIFC Proxy {#architecture-external-difc-proxy}

The DIFC proxy (mcpg) is now started **externally** by the gh-aw compiler on the host. AWF only launches the cli-proxy container and connects it to the external proxy.

### New Architecture

```
Host (managed by gh-aw compiler):
  difc-proxy (mcpg in proxy mode) on 0.0.0.0:18443, --network host

AWF docker-compose:
  squid-proxy (172.30.0.10)
  cli-proxy (172.30.0.50) → host difc-proxy via host.docker.internal:18443
  agent (172.30.0.20) → cli-proxy at http://172.30.0.50:11000
```

### TLS Hostname Matching

The difc-proxy's self-signed TLS cert has SANs for `localhost` and `127.0.0.1`, but not `host.docker.internal`. The cli-proxy container runs a **Node.js TCP tunnel** (`tcp-tunnel.js`):

```
localhost:18443 (inside cli-proxy) → TCP tunnel → host.docker.internal:18443 (host difc-proxy)
```

The `gh` CLI uses `GH_HOST=localhost:18443`, which matches the cert's SAN.

### CLI Flags

| Flag | Description |
|---|---|
| `--difc-proxy-host <host:port>` | Connect to external DIFC proxy (e.g., `host.docker.internal:18443`) |
| `--difc-proxy-ca-cert <path>` | Path to TLS CA cert written by the DIFC proxy |

### Key Properties

- **No internal mcpg container**: The mcpg process runs on the host, started by the gh-aw compiler
- **TCP tunnel for TLS**: `tcp-tunnel.js` forwards localhost traffic to the host DIFC proxy
- **Guard policy enforcement**: Handled by the external DIFC proxy, not by AWF
- **Write control**: Delegated to the DIFC guard policy (no read-only mode in cli-proxy)
- **Credential isolation**: Tokens held by the external DIFC proxy, excluded from agent env
- **Audit logging**: mcpg logs all proxied API calls on the host
- **Squid routing**: The external DIFC proxy's traffic is not routed through Squid

---

<details>
<summary>Historical: Original internal mcpg architecture (deprecated)</summary>

## Architecture: AWF Sidecar with mcpg Proxy (deprecated)

A new container on the `awf-net`, managed by `docker-manager.ts`, that runs two processes internally:

1. **HTTP server** (port 11000) — receives `gh` CLI invocations from the agent wrapper, executes `gh` locally, returns stdout/stderr/exitCode
2. **mcpg proxy** (port 18443, TLS) — the same `ghcr.io/github/gh-aw-mcpg` image running with the `proxy` subcommand, holding `GH_TOKEN` and applying guard policies

The `gh` CLI inside the sidecar has `GH_HOST=localhost:18443` set, so all its API calls route through the mcpg proxy. The proxy injects the token, applies DIFC guard policies, and logs the traffic. The proxy's outbound traffic goes through Squid for domain allowlisting.

**Pros:**
- Reuses the proven DIFC proxy pattern (same mcpg image, same `proxy` subcommand)
- Guard policies (min-integrity, repos) enforced at the proxy layer — identical guarantees to what the agent gets via the GitHub MCP server through the gateway
- Audit logging via mcpg's existing JSONL output
- Credential isolation: `GH_TOKEN` lives in the mcpg proxy process, never in the agent container, never directly in the `gh` CLI environment
- Direct HTTP on awf-net (agent → cli-proxy), minimal latency
- Single container simplifies lifecycle management

**Key difference from the pre-agent DIFC proxy:**
The pre-agent DIFC proxy runs on the host (`--network host`, `localhost:18443`). This sidecar version runs on the `awf-net` (`172.30.0.50`), isolated from the host. The mcpg proxy runs as a process inside the sidecar container, listening on the container's localhost.

## Detailed Design (Option A)

### 1. Network Topology

| Component | IP | Port | Role |
|---|---|---|---|
| Squid | 172.30.0.10 | 3128 | Domain allowlist proxy |
| Agent | 172.30.0.20 | — | User command |
| API Proxy | 172.30.0.30 | 10000-10004 | LLM credential injection |
| DoH Proxy | 172.30.0.40 | 53 | DNS-over-HTTPS |
| **CLI Proxy** | **172.30.0.50** | **11000** | **gh CLI forwarding** |

Port 11000 chosen to avoid collision with API proxy ports (10000-10004).

### 2. CLI Proxy Container (`containers/cli-proxy/`)

A container that runs two processes: an HTTP server for agent requests, and an mcpg proxy for DIFC-filtered `gh` CLI calls.

```
containers/cli-proxy/
├── Dockerfile           # Based on ghcr.io/github/gh-aw-mcpg + gh CLI
├── server.js            # HTTP server that executes gh commands
├── entrypoint.sh        # Starts mcpg proxy, waits for TLS cert, starts HTTP server
├── package.json
└── healthcheck.sh
```

#### Internal Architecture

The entrypoint script orchestrates two processes:

1. **mcpg proxy** — Starts first, generates TLS cert, listens on `localhost:18443`:
   ```bash
   mcpg proxy \
     --policy "$AWF_GH_GUARD_POLICY" \
     --listen 127.0.0.1:18443 \
     --tls --tls-dir /tmp/proxy-tls \
     --guards-mode filter \
     --trusted-bots github-actions[bot],copilot \
     --log-dir /var/log/cli-proxy/mcpg &
   ```

2. **HTTP server** — Starts after mcpg proxy is healthy, executes `gh` with `GH_HOST=localhost:18443`:
   ```bash
   export GH_HOST=localhost:18443
   export GH_REPO="$GITHUB_REPOSITORY"
   export NODE_EXTRA_CA_CERTS=/tmp/proxy-tls/ca.crt
   node server.js
   ```

The `gh` CLI never sees `GH_TOKEN` directly — it's passed only to the mcpg proxy process. The CLI connects to the proxy via `GH_HOST`, and the proxy injects the token for upstream API calls.

#### Server Behavior

```
POST /exec
Content-Type: application/json

{
  "args": ["pr", "list", "--repo", "owner/repo", "--json", "number,title"],
  "cwd": "/home/runner/work/repo/repo",
  "stdin": null,
  "env": {
    "GH_REPO": "owner/repo"
  }
}
```

Response (streamed via chunked transfer encoding):

```
HTTP/1.1 200 OK
Content-Type: application/json
Transfer-Encoding: chunked

{
  "stdout": "[{\"number\":42,\"title\":\"Fix bug\"}]\n",
  "stderr": "",
  "exitCode": 0
}
```

#### Key Properties

- **Authentication**: `GH_TOKEN` passed to container env, but only the mcpg proxy process uses it. The `gh` CLI talks to the proxy via `GH_HOST=localhost:18443` (TLS, self-signed CA)
- **Guard policies**: mcpg's `--guards-mode filter` applies the same DIFC integrity policies used by the MCP gateway — min-integrity checks, repo restrictions, trusted-bot allowlists
- **Audit logging**: mcpg logs all proxied API calls to JSONL files in `/var/log/cli-proxy/mcpg/`
- **Read-only mode**: Default behavior; reject `gh pr create`, `gh issue create`, etc. unless explicitly allowed by AWF config
- **Command allowlist**: Only `gh` subcommands are permitted (no shell injection)
- **Workspace access**: Mounted read-only at same path as agent sees it
- **Squid routing**: `HTTP_PROXY`/`HTTPS_PROXY` set to Squid, so mcpg proxy's upstream calls respect domain allowlisting
- **Timeout**: Per-command timeout (default 30s) to prevent hanging
- **No shell**: Commands are exec'd directly, not via `/bin/sh -c`

#### Security Hardening

```yaml
# docker-compose.yml (generated)
cli-proxy:
  cap_drop: [ALL]
  security_opt: [no-new-privileges:true]
  mem_limit: 256m
  pids_limit: 50
  read_only: true  # Read-only root filesystem
  tmpfs:
    - /tmp:rw,noexec,nosuid,size=64m
```

#### Subcommand Allowlist / Denylist

Two modes, configurable via AWF flags:

**Default (read-only)** — only data-retrieval commands allowed:
```
ALLOWED: api, browse, cache, codespace, gist view, issue list/view/comment,
         label list, org list, pr list/view/diff/checks/review,
         release list/view, repo list/view/clone,
         run list/view/watch, search, secret list, variable list,
         workflow list/view
DENIED:  everything else (pr create/merge, issue create/close, repo create/delete, etc.)
```

**Write-enabled** (opt-in via `--cli-proxy-writable`):
```
ALLOWED: all gh subcommands
DENIED:  auth, config set, extension install (meta-commands that modify gh itself)
```

### 3. Agent-Side Wrapper (`/usr/local/bin/gh`)

A small shell script placed in the agent container image:

```bash
#!/bin/sh
# /usr/local/bin/gh — Forwards to CLI proxy sidecar
set -e

CLI_PROXY="${AWF_CLI_PROXY_URL:-http://172.30.0.50:11000}"

# Build JSON payload
ARGS_JSON=$(printf '%s\n' "$@" | jq -Rs '[split("\n")[] | select(length>0)]')
CWD_JSON=$(printf '%s' "$(pwd)" | jq -Rs '.')

# Read stdin if piped
STDIN_DATA=""
if [ ! -t 0 ]; then
  STDIN_DATA=$(cat | base64)
fi

# Send to CLI proxy
RESPONSE=$(curl -sf --max-time 60 \
  -X POST "${CLI_PROXY}/exec" \
  -H "Content-Type: application/json" \
  -d "{\"args\":${ARGS_JSON},\"cwd\":${CWD_JSON},\"stdin\":\"${STDIN_DATA}\"}")

# Extract and output
printf '%s' "$RESPONSE" | jq -r '.stdout' 2>/dev/null
printf '%s' "$RESPONSE" | jq -r '.stderr' >&2 2>/dev/null
EXIT_CODE=$(printf '%s' "$RESPONSE" | jq -r '.exitCode' 2>/dev/null)
exit "${EXIT_CODE:-1}"
```

**Placement**: The wrapper must be at a PATH location that precedes any host-mounted `gh` binary. In chroot mode, the host's `/usr/bin/gh` is mounted at `/host/usr/bin/gh`; the wrapper at `/usr/local/bin/gh` takes precedence.

**Dependencies**: Requires `curl` and `jq` in the agent container (both already available — `curl` is in the base image, `jq` is installed in the Dockerfile).

### 4. AWF Code Changes

#### `src/types.ts`

```typescript
// New port constant
export const CLI_PROXY_PORT = 11000;

// New config fields
export interface WrapperConfig {
  // ... existing fields ...
  enableCliProxy?: boolean;      // --enable-cli-proxy
  cliProxyWritable?: boolean;    // --cli-proxy-writable (allow write ops)
  githubToken?: string;          // Token for CLI proxy (from GITHUB_TOKEN)
}
```

#### `src/docker-manager.ts`

Changes parallel the api-proxy sidecar (lines 1403-1487):

1. **Container definition** (~40 lines): New `cli-proxy` service with:
   - IP: 172.30.0.50
   - Environment: `GH_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`, `HTTP_PROXY`, `HTTPS_PROXY`, `AWF_GH_GUARD_POLICY`
   - Volume: workspace directory (read-only), log directory
   - Healthcheck: `curl -f http://localhost:11000/health`
   - Depends on: squid-proxy (healthy)
   - Image: Custom image based on `ghcr.io/github/gh-aw-mcpg` + `gh` CLI + Node.js HTTP server

2. **Agent dependency**: `agent.depends_on['cli-proxy'] = { condition: 'service_healthy' }`

3. **Agent environment**: `AWF_CLI_PROXY_URL=http://172.30.0.50:11000`

4. **Network config** (line 1757): Add `cliProxyIp: '172.30.0.50'`

5. **Token exclusion**: When cli-proxy enabled, add `GITHUB_TOKEN`/`GH_TOKEN` to `EXCLUDED_ENV_VARS`

6. **Guard policy generation**: Build guard policy JSON (min-integrity, repos) from workflow config, pass as `AWF_GH_GUARD_POLICY` env var to cli-proxy container

#### `src/cli.ts`

New CLI flags (following the `--enable-api-proxy` pattern):
```
--enable-cli-proxy     Enable gh CLI proxy sidecar (default: false)
--cli-proxy-writable   Allow write operations through CLI proxy (default: false)
--cli-proxy-policy     Guard policy JSON for mcpg proxy (optional; default: restrict to current repo)
```

The flag is **opt-in only** — the cli-proxy sidecar is never started unless `--enable-cli-proxy` is explicitly passed. This mirrors how `--enable-api-proxy` works: the api-proxy sidecar only starts when the flag is present.

```typescript
// In the commander option definition (parallel to --enable-api-proxy at line 1368)
.option(
  '--enable-cli-proxy',
  'Enable gh CLI proxy sidecar for secure GitHub CLI access.\n' +
  '                                       Routes gh commands through mcpg DIFC proxy with guard policies.',
  false
)
.option(
  '--cli-proxy-writable',
  'Allow write operations through the CLI proxy (default: read-only)',
  false
)
.option(
  '--cli-proxy-policy <json>',
  'Guard policy JSON for the mcpg DIFC proxy inside the CLI proxy sidecar',
)
```

#### `containers/agent/setup-iptables.sh`

Add NAT RETURN rule for cli-proxy IP (parallel to api-proxy at lines 169-174):
```bash
if [ -n "$AWF_CLI_PROXY_IP" ]; then
  iptables -t nat -A OUTPUT -d "$AWF_CLI_PROXY_IP" -j RETURN
fi
```

#### `containers/agent/Dockerfile`

Install the `gh` wrapper script:
```dockerfile
COPY gh-wrapper.sh /usr/local/bin/gh
RUN chmod +x /usr/local/bin/gh
```

### 5. gh-aw Compiler Feature Flag

The compiler controls whether `--enable-cli-proxy` is passed to AWF via a **feature flag** in workflow frontmatter. This follows the existing `features:` pattern (e.g., `difc-proxy: true`, `copilot-requests: true`).

#### Workflow frontmatter

```yaml
---
on:
  issues:
    types: [opened]
engine: copilot
features:
  cli-proxy: true          # Enable gh CLI proxy in the AWF sandbox
  # cli-proxy-writable: true  # Optional: allow write operations (default: read-only)
---
```

#### How the compiler uses it

When `features: cli-proxy: true` is set:

1. **Add `--enable-cli-proxy`** to the AWF invocation in the lock file's agent execution step
2. **Generate guard policy JSON** — same as `getDIFCProxyPolicyJSON()` in `compiler_difc_proxy.go` — and pass it via `--cli-proxy-policy`
3. **Pass `GH_TOKEN`** (or `GITHUB_MCP_SERVER_TOKEN`) to AWF via `--env` so it reaches the cli-proxy container
4. **Optionally reduce GitHub MCP toolsets** — when `cli-proxy` is enabled, the compiler can omit read-only GitHub toolsets (repos, issues, pull_requests) from the MCP gateway since the agent can use `gh` instead

#### Lock file output (example)

```yaml
# In the AWF execution step:
sudo -E awf \
  --enable-api-proxy \
  --enable-cli-proxy \
  --cli-proxy-policy '{"repos":["owner/repo"],"min-integrity":"public"}' \
  --allow-domains api.github.com,github.com,... \
  ...
```

#### Testing the feature flag

For initial testing before general availability:
- Enable `cli-proxy: true` on a **single test workflow** in this repo (e.g., a new `smoke-cli-proxy.md`)
- The compiler generates the flag → AWF starts the sidecar → agent can use `gh` natively
- Other workflows are unaffected (no flag = no sidecar)
- Can be rolled out incrementally: enable on one workflow, validate, expand

This is a **gh-aw compiler change** (separate repo). AWF just needs `--enable-cli-proxy` and the sidecar implementation.

### 6. Transition Strategy

The GitHub MCP server and `gh` CLI proxy can **coexist**:

| Phase | GitHub MCP | gh CLI Proxy | Notes |
|-------|-----------|-------------|-------|
| **Phase 1** | ✅ Active | ✅ Active | Both available; agent can use either |
| **Phase 2** | ⚠️ Reduced toolset | ✅ Primary | MCP limited to write-sink tools only |
| **Phase 3** | ❌ Removed | ✅ Primary | Full migration complete |

Phase 1 is risk-free: agents that know about `gh` will use it, others fall back to MCP tools.

## Token Flow Comparison

### Current (MCP)

```
GITHUB_MCP_SERVER_TOKEN
    │
    ├──→ lock.yml step env (exclude-env from AWF)
    ├──→ mcpg container env (-e GITHUB_MCP_SERVER_TOKEN)
    └──→ GitHub MCP server container (GITHUB_PERSONAL_ACCESS_TOKEN)
         └──→ GitHub API (Authorization: token ...)
```

Agent never sees `GITHUB_MCP_SERVER_TOKEN`. ✅

### Proposed (CLI Proxy with mcpg DIFC Proxy)

```
GITHUB_TOKEN (or GITHUB_MCP_SERVER_TOKEN)
    │
    ├──→ lock.yml step env (exclude-env from AWF)
    └──→ cli-proxy container env (GH_TOKEN)
         └──→ mcpg proxy process (GH_TOKEN)
              │   Runs: proxy --policy {...} --tls --guards-mode filter
              │   Listens: localhost:18443 (TLS, self-signed CA)
              │   Applies: guard policies, integrity filtering, audit logging
              │
              └──→ gh CLI (GH_HOST=localhost:18443, no direct token)
                   └──→ mcpg proxy → Squid → GitHub API
```

Agent never sees `GITHUB_TOKEN`. ✅
Guard policies enforced. ✅
Audit logging via mcpg's existing JSONL output. ✅
Same isolation as MCP approach, with native CLI ergonomics.

## Estimated Context Token Savings

| Component | Tokens (approx) | With CLI Proxy |
|-----------|-----------------|----------------|
| GitHub MCP tool schemas (30 tools) | ~8,000-12,000 | 0 |
| MCP tool-call JSON framing per call | ~200-400 | 0 |
| gh CLI output (raw, compact) | — | ~same as MCP results |
| gh wrapper (no schema needed) | — | 0 |
| **Net savings per agent run** | | **~8,000-12,000 tokens** |

The exact savings depend on which GitHub toolsets are enabled. Workflows with `"GITHUB_TOOLSETS": "context,repos,issues,pull_requests,actions"` will see the largest gains.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Command injection via args | Exec `gh` directly (no shell), validate args are strings |
| Workspace data exfiltration | Mount workspace read-only; output goes through Squid |
| Token theft via /proc inspection | Token only in mcpg proxy process; agent can't inspect sidecar |
| Bypassing guard policies | mcpg proxy enforces policies before forwarding; same as MCP gateway |
| Uncontrolled write operations | Subcommand allowlist + mcpg guard policies; default to read-only |
| gh CLI version drift | Pin version in Dockerfile; update with AWF releases |
| mcpg version drift | Pin mcpg image version; update in lockstep with gh-aw releases |
| Streaming large outputs | Chunked transfer encoding; configurable max output size |
| Agent expects MCP tools | Phase 1 coexistence; both available simultaneously |
| TLS cert generation at startup | Same proven pattern as pre-agent DIFC proxy; 30s timeout |

## Open Questions

1. **Should the cli-proxy also support `git` commands?** The agent currently can't `git push` (no auth). A `git` proxy would enable PR creation without safe-outputs, which may conflict with the SafeOutputs security model.

2. **Guard policy source**: The mcpg proxy needs a policy JSON. In pre-agent DIFC, the compiler generates this from the workflow frontmatter (`min-integrity`, `repos` fields). For AWF, who generates the policy? Options:
   - AWF reads it from a config file passed via `--cli-proxy-policy`
   - The gh-aw compiler generates it and injects it as an env var in the lock file
   - AWF generates a default restrictive policy based on `GITHUB_REPOSITORY`

3. **Opt-in mechanism (resolved)**: Use `features: cli-proxy: true` in workflow frontmatter. The compiler generates `--enable-cli-proxy` in the lock file. This follows the existing `features:` pattern (`difc-proxy`, `copilot-requests`, etc.).

4. **What about GHES/GHEC?** The mcpg proxy supports `GITHUB_SERVER_URL` for upstream routing. The `gh` CLI handles GHES/GHEC natively via `GH_HOST`.

5. **Should we stream output?** For large `gh api` responses (e.g., listing thousands of issues), streaming avoids buffering the entire response. The wrapper can use `curl --no-buffer` and the server can pipe `gh` stdout directly to the HTTP response.

6. **mcpg image dependency**: The cli-proxy Dockerfile needs the mcpg binary. Options:
   - Base the image on `ghcr.io/github/gh-aw-mcpg` and add `gh` + Node.js
   - Use a multi-stage build: copy the mcpg binary from the mcpg image, layer `gh` + Node.js on top
   - Build mcpg from source (heavyweight, not recommended)

## Implementation Plan

### Phase 1: CLI Proxy Container (2-3 days)

- [ ] Create `containers/cli-proxy/` directory structure
- [ ] Write `Dockerfile` (multi-stage: mcpg binary from `ghcr.io/github/gh-aw-mcpg` + `node:22-alpine` + `gh` CLI)
- [ ] Write `entrypoint.sh` (start mcpg proxy → wait for TLS cert → start HTTP server)
- [ ] Implement HTTP server (`server.js`) with `/exec` and `/health` endpoints
- [ ] Implement subcommand allowlist/denylist
- [ ] Test mcpg proxy mode locally: verify TLS cert generation, guard policies, audit logging
- [ ] Write unit tests for server

### Phase 2: AWF Integration (1-2 days)

- [ ] Add `CLI_PROXY_PORT` to `src/types.ts`
- [ ] Add `--enable-cli-proxy`, `--cli-proxy-writable`, `--cli-proxy-policy` flags to `src/cli.ts`
- [ ] Add cli-proxy service to `generateDockerCompose()` in `src/docker-manager.ts`
- [ ] Add iptables RETURN rule for cli-proxy IP in `setup-iptables.sh`
- [ ] Add `cliProxyIp` to network config
- [ ] Update `EXCLUDED_ENV_VARS` when cli-proxy enabled
- [ ] Generate guard policy JSON from config/env and pass as `AWF_GH_GUARD_POLICY`
- [ ] Add mcpg audit log preservation (parallel to Squid log preservation)

### Phase 3: Agent Wrapper (0.5 day)

- [ ] Create `gh-wrapper.sh` script
- [ ] Add to agent container Dockerfile
- [ ] Test in chroot mode (wrapper must precede host `/usr/bin/gh` in PATH)

### Phase 4: Testing (1-2 days)

- [ ] Unit tests for cli-proxy server
- [ ] Integration test: `awf --enable-cli-proxy 'gh pr list'`
- [ ] Integration test: verify write operations are blocked in read-only mode
- [ ] Integration test: verify token isolation (agent can't access GH_TOKEN)
- [ ] Integration test: verify Squid domain allowlisting applies to cli-proxy traffic
- [ ] Integration test: verify mcpg guard policies are applied (test with policy violation)
- [ ] Integration test: verify mcpg audit logs capture all proxied API calls

### Phase 5: gh-aw Compiler (separate PR to gh-aw)

- [ ] Add `cli-proxy` to known feature flags in `features:` frontmatter parsing
- [ ] When `features: cli-proxy: true`, inject `--enable-cli-proxy` into the AWF command in the execution step
- [ ] Generate guard policy JSON (reuse `getDIFCProxyPolicyJSON()` from `compiler_difc_proxy.go`)
- [ ] Pass `--cli-proxy-policy` with the generated policy to AWF
- [ ] Optionally reduce GitHub MCP toolsets when `cli-proxy` is enabled (remove read-only toolsets)
- [ ] Add `cli-proxy-writable` feature flag support for write-enabled mode
- [ ] Documentation updates in the gh-aw instructions file

### Reference: DIFC Proxy Source Files (in `github/gh-aw`)

- `pkg/workflow/compiler_difc_proxy.go` — Compiler generates the start/stop steps and policy JSON
- `actions/setup/sh/start_difc_proxy.sh` — Runtime startup: `docker run mcpg proxy ...`, TLS cert wait, env var injection
- `actions/setup/sh/stop_difc_proxy.sh` — Cleanup: stop container, restore env vars, remove CA cert

</details>
