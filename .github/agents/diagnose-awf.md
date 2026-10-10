---
name: diagnose-awf
description: Diagnose AWF failures from symptoms, workflow runs, or errors using the canonical diagnostics registry.
---

# AWF Diagnosis Agent Playbook

Use this playbook to diagnose a GitHub Agentic Workflow Firewall (AWF) failure
from an error string, a workflow run URL, or a described symptom.

This playbook is **authored**; the finding catalog below it is **generated**
from the canonical registry in `docs/diagnostics/findings/`. Never edit the
generated section by hand.

## Procedure

1. **Fingerprint** — establish AWF version (`awf --version`), runner type
   (GitHub-hosted / self-hosted / ARC+DinD / GHES / GHEC), `DOCKER_HOST`,
   `GITHUB_SERVER_URL`, container runtime, provider, and auth mode. Record
   `unknown` for anything you cannot establish; do not guess.
2. **Classify the failing boundary** — `runner`, `runtime`, `network`, `auth`,
   `ci`, or `security`. Use the phase at which the run failed (container
   create, egress, credential exchange, post-agent safe output).
3. **Match the narrowest finding** — use the symptom lookup table, then confirm
   the discriminating conditions. Prefer one specific ID over several loose
   matches. Check the finding's version scope against the fingerprint.
4. **Probe** — if the match is ambiguous, ask for the finding's read-only probe
   output. One probe at a time.
5. **Report** — always answer in this shape:
   - Observed symptom
   - Matched finding ID (or "no match") and the evidence that selected it
   - Affected version / topology scope
   - Safe next probe
   - Fix or workaround
   - Citations (finding provenance links)

## Safety rules

- Never ask for API keys, tokens, JWTs, `Authorization` headers, full
  environment dumps, or any token exchange or inference probe. Configuration
  **presence and shape**, route/health status, and redacted error classes only.
- Never recommend `--env-all`, disabling isolation or the firewall, or
  broadening the domain allowlist as a default remedy.
- A suspected isolation or credential-boundary regression routes to `SEC-001`
  and the repository security review process, not to a bypass.
- If no finding matches, say so, name the smallest missing evidence, and stop.
  Never invent a fix.

## Auth routing

Distinguish these three auth surfaces before matching:

1. **AWF api-proxy sidecar / provider token exchange** — provider credentials
   and OIDC exchange live in the sidecar (`AUTH-001`, `AUTH-002`).
2. **GitHub / Copilot enterprise and BYOK routing** — target host selection and
   Authorization prefix rules (`AUTH-001`, see `docs/auth-matrix.md`).
3. **gh-aw-launched mcpg HTTP MCP GitHub OIDC** — runner-to-gateway OIDC
   propagation (`AUTH-003`).

## Specialist references

Reuse these instead of duplicating their commands:

- `docs/diagnostics/README.md` — registry index and boundary routing
- `.github/workflows/shared/self-hosted-failure-modes.md` — full runner catalog
- `.github/skills/debug-firewall/SKILL.md` — Squid/iptables/container inspection
- `.github/skills/awf-debug-tools/SKILL.md` — log parsing helpers
- `.github/skills/debugging-workflows/SKILL.md` — GitHub Actions log retrieval
- `docs/auth-matrix.md` — supported auth combinations (authoritative)
- `docs/compatibility.md` — supported platforms (authoritative)
- `docs/troubleshooting.md` — broad troubleshooting guide

<!-- BEGIN GENERATED: docs/diagnostics/findings -->

<!-- Generated from docs/diagnostics/findings by scripts/diagnostics/cli.ts render. Do not edit by hand. -->

## Symptom lookup

| Observable symptom | Finding | Boundary | Status |
|---|---|---|---|
| Bind-mounted workspace or config files are empty or missing inside the agent container | A1 | runner | workaround |
| docker compose starts but the mounted path resolves to an empty directory | A1 | runner | workaround |
| no such file or directory for a path that exists on the runner | A1 | runner | workaround |
| Streaming log write fails with read-only file system | A28 | runner | workaround |
| A successful engine run becomes a failure under arc-dind | A28 | runner | workaround |
| Safe outputs are missing after a streaming engine run | A28 | runner | workaround |
| token-usage.jsonl is missing for post-run consumers on arc-dind | A29 | runner | workaround |
| gh-aw.aic / gen_ai.usage.* telemetry is absent on arc-dind | A29 | runner | workaround |
| The run succeeds but token-usage telemetry is missing | A29 | runner | workaround |
| capsh: not found | A4 | runner | workaround |
| /bin/bash: no such file or directory during chroot startup | A4 | runner | workaround |
| node: not found when the harness binary starts | A4 | runner | workaround |
| uv Permission denied under UV_CACHE_DIR | B36 | runner | fixed |
| uv Permission denied under UV_PYTHON_INSTALL_DIR | B36 | runner | fixed |
| The agent repeatedly chooses its own uv cache directory | B36 | runner | fixed |
| OCI runtime create failed | RT-001 | runtime | needs-evidence |
| unknown capability reported by the container runtime at start | RT-001 | runtime | needs-evidence |
| unsupported mount reported by the container runtime at start | RT-001 | runtime | needs-evidence |
| The agent container never starts while Squid is healthy | RT-001 | runtime | needs-evidence |
| TCP_DENIED | NET-001 | network | workaround |
| 403 Forbidden returned by the proxy for an outbound request | NET-001 | network | workaround |
| curl: (56) Received HTTP code 403 from proxy after CONNECT | NET-001 | network | workaround |
| Could not resolve host | NET-002 | network | workaround |
| Temporary failure in name resolution | NET-002 | network | workaround |
| getaddrinfo EAI_AGAIN inside the agent container | NET-002 | network | workaround |
| 400 Bad Request: Authorization header is badly formatted | AUTH-001 | auth | fixed |
| Copilot requests fail immediately against api.enterprise.githubcopilot.com or api.business.githubcopilot.com | AUTH-001 | auth | fixed |
| api-proxy reports that no OIDC token could be minted | AUTH-002 | auth | workaround |
| Provider requests fail with 401 while AWF_AUTH_TYPE=github-oidc is set | AUTH-002 | auth | workaround |
| ACTIONS_ID_TOKEN_REQUEST_URL is not available to the sidecar | AUTH-002 | auth | workaround |
| mcpg / HTTP MCP GitHub server returns 401 for github-oidc authentication | AUTH-003 | auth | workaround |
| Gateway configuration contains no OIDC auth metadata | AUTH-003 | auth | workaround |
| MCP GitHub tool calls fail while provider inference still works | AUTH-003 | auth | workaround |
| safe output validation failed in the workflow run | CI-001 | ci | workaround |
| The agent job succeeds but the safe-output collection step exits non-zero | CI-001 | ci | workaround |
| create-pull-request rejected: file not in allowed-files | CI-001 | ci | workaround |
| The agent container can reach a domain that is not allowlisted | SEC-001 | security | needs-evidence |
| A provider credential is observable inside the agent environment while the api-proxy is enabled | SEC-001 | security | needs-evidence |
| Egress succeeds without a corresponding Squid access-log entry | SEC-001 | security | needs-evidence |

## Boundary: runner

### A1 — Bind-mounted files are missing inside containers on ARC / DinD split filesystems

- **Boundary:** runner · **Status:** workaround
- **Affects:** runner=arc-dind, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Bind-mounted workspace or config files are empty or missing inside the agent container · docker compose starts but the mounted path resolves to an empty directory · no such file or directory for a path that exists on the runner
- **Discriminating conditions:** Runner and Docker daemon do not share a filesystem (ARC with a DinD sidecar) · DOCKER_HOST points at the sidecar daemon rather than the runner's own socket · No --docker-host-path-prefix / container.dockerHostPathPrefix is configured
- **Root cause:** Bind-mount sources are runner filesystem paths that the DinD Docker daemon cannot resolve, so the daemon creates empty directories instead of mounting the runner's content.
- **Safe probe:** `docker -H "$DOCKER_HOST" run --rm -v /tmp:/tmp alpine ls /tmp` → The listing is missing a sentinel file created on the runner under /tmp, confirming a split filesystem.
- **Action:** Set --docker-host-path-prefix (for example /tmp/gh-aw) or container.dockerHostPathPrefix so bind-mount sources are rewritten to paths the daemon can resolve. Kernel virtual filesystems (/dev, /sys, /proc) are intentionally not prefixed.
- **Related:** A4
- **Provenance:** issue: ARC split-filesystem bind mounts (https://github.com/github/gh-aw-firewall/issues/5753) · doc: ARC / DinD split filesystem support (docs/arc-dind.md) · code: translateBindMountHostPath() (src/services/agent-volumes.ts) · test: src/services/agent-volumes-arc-dind-staging.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### A28 — ARC/DinD streaming logs target a read-only parent mount

- **Boundary:** runner · **Status:** workaround
- **Affects:** runner=arc-dind, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Streaming log write fails with read-only file system · A successful engine run becomes a failure under arc-dind · Safe outputs are missing after a streaming engine run
- **Discriminating conditions:** runner.topology is arc-dind · The engine writes a streaming log directly beneath ${RUNNER_TEMP}/gh-aw · The parent ${RUNNER_TEMP}/gh-aw mount is read-only
- **Root cause:** The streaming log path is beneath a read-only parent mount, so the engine cannot create or append its log even when the engine itself succeeds.
- **Safe probe:** `findmnt -T "${RUNNER_TEMP}/gh-aw" -o TARGET,OPTIONS; findmnt -T "${RUNNER_TEMP}/gh-aw/sandbox/agent" -o TARGET,OPTIONS` → The parent mount is read-only and the sandbox/agent mount is writable; no files are created or modified.
- **Action:** Use ${RUNNER_TEMP}/gh-aw/sandbox/agent/pi-streaming.jsonl consistently for the streaming-log writer, parser, and artifact upload. Upgrade AWF to the version containing github/gh-aw-firewall#9188; relocating Pi's log in the gh-aw compiler remains unresolved.
- **Provenance:** issue: ARC/DinD streaming log write failure (https://github.com/github/gh-aw-firewall/issues/9183) · pull-request: Retain writable sandbox/agent mount (https://github.com/github/gh-aw-firewall/pull/9188) · doc: ARC / DinD documentation (docs/arc-dind.md) · test: src/services/agent-volumes-arc-dind-staging.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### A29 — ARC/DinD api-proxy token-usage log not found at /tmp/gh-aw

- **Boundary:** runner · **Status:** workaround
- **Affects:** runner=arc-dind, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** token-usage.jsonl is missing for post-run consumers on arc-dind · gh-aw.aic / gen_ai.usage.* telemetry is absent on arc-dind · The run succeeds but token-usage telemetry is missing
- **Discriminating conditions:** runner.topology is arc-dind · The compiler passes ${RUNNER_TEMP}/gh-aw log directories but the consumer hardcodes /tmp/gh-aw · A second sub-case uses --docker-host-path-prefix /tmp with --proxy-logs-dir outside /tmp, rewriting the bind source to /tmp<dir>
- **Root cause:** The token-usage file lives under the runner/daemon-visible log directory, not a fixed /tmp/gh-aw path. Consumers cannot predict that path. With a shared /tmp prefix and a log directory outside /tmp, AWF also reported and repaired the original, empty directory rather than the rewritten bind source.
- **Safe probe:** `printf '%s\n' "${AWF_TOKEN_USAGE_LOG:-unset}"; ls -l "${AWF_TOKEN_USAGE_LOG:-/dev/null}"` → After a patched AWF run that writes token usage, AWF_TOKEN_USAGE_LOG is set in a later job step and the file exists; no file contents or credentials are printed.
- **Action:** Upgrade AWF to v0.28.31 or newer, which includes github/gh-aw-firewall#9357. Read $AWF_TOKEN_USAGE_LOG (or the 'Token usage log available at:' log line) instead of hardcoding /tmp/gh-aw. AWF exports the path to $GITHUB_ENV only when the file exists and pre-creates the rewritten api-proxy log directory with mode 0777 and a warning. gh-aw's parse_token_usage.cjs must still adopt AWF_TOKEN_USAGE_LOG; the end-to-end fix remains unresolved.
- **Provenance:** issue: Missing token-usage telemetry on ARC/DinD (https://github.com/github/gh-aw-firewall/issues/9352) · pull-request: Report and export the api-proxy token-usage log path (released in v0.28.31) (https://github.com/github/gh-aw-firewall/pull/9357) · doc: Locating API proxy token-usage logs (docs/arc-dind.md#locating-api-proxy-token-usage-logs) · test: src/artifact-preservation-token-usage.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### A4 — capsh, /bin/bash, or node missing inside the DinD chroot

- **Boundary:** runner · **Status:** workaround
- **Affects:** runner=arc-dind, runtime=chroot, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** capsh: not found · /bin/bash: no such file or directory during chroot startup · node: not found when the harness binary starts
- **Discriminating conditions:** The Docker daemon host image is Alpine/musl based · Chroot mode is active (default agent execution mode)
- **Root cause:** The musl-based daemon host lacks the glibc tooling that chroot mode expects to bind into the agent container.
- **Safe probe:** `docker -H "$DOCKER_HOST" run --rm alpine cat /etc/os-release` → Shows an Alpine/musl daemon host, which chroot mode cannot satisfy.
- **Action:** Use a glibc DinD image such as ghcr.io/github/gh-aw-firewall/dind-ubuntu:latest for the Docker-in-Docker sidecar.
- **Related:** A1
- **Provenance:** doc: DinD image requirements (docs/arc-dind.md) · doc: Runner failure-mode catalog (A4) (.github/workflows/shared/self-hosted-failure-modes.md) · code: chroot setup (containers/agent/entrypoint.sh)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### B36 — setup-uv paths under RUNNER_TEMP are unwritable with --env-all

- **Boundary:** runner · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** uv Permission denied under UV_CACHE_DIR · uv Permission denied under UV_PYTHON_INSTALL_DIR · The agent repeatedly chooses its own uv cache directory
- **Discriminating conditions:** The workflow uses runtimes: uv and AWF is invoked with --env-all · setup-uv sets UV_CACHE_DIR or UV_PYTHON_INSTALL_DIR beneath RUNNER_TEMP outside the mounted gh-aw subtree
- **Root cause:** --env-all forwarded setup-uv cache and Python-install paths beneath RUNNER_TEMP into the agent, but only RUNNER_TEMP/gh-aw is mounted and that mount is read-only, leaving those paths unwritable.
- **Safe probe:** `printf '%s\n' "${UV_CACHE_DIR:-unset}" "${UV_PYTHON_INSTALL_DIR:-unset}"` → On unpatched AWF, the variables point beneath RUNNER_TEMP outside the mounted gh-aw subtree; on patched AWF they are unset unless explicitly overridden. When unset on Linux without XDG overrides, UV_CACHE_DIR defaults to $HOME/.cache/uv and UV_PYTHON_INSTALL_DIR defaults to $HOME/.local/share/uv/python. No files are written.
- **Action:** Upgrade AWF to include github/gh-aw-firewall#9705. AWF drops unmounted absolute paths beneath RUNNER_TEMP when forwarding host variables; explicit --env values still override the filter. Keep these cache directories unwritable so setup-uv cannot save agent-written files into the repository-wide Actions cache. Disabling setup-uv caching is tracked on the gh-aw compiler side.
- **Provenance:** issue: setup-uv cache paths are unwritable inside AWF (https://github.com/github/gh-aw-firewall/issues/9701) · pull-request: Drop unmounted RUNNER_TEMP paths from --env-all (https://github.com/github/gh-aw-firewall/pull/9705) · code: Filter unmounted runner-temp environment paths (src/services/agent-environment/env-passthrough.ts) · test: Covers setup-uv paths and --env-all filtering (src/services/agent-environment/env-passthrough.test.ts)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

## Boundary: runtime

### RT-001 — Alternative container runtime rejects the AWF agent container configuration

- **Boundary:** runtime · **Status:** needs-evidence
- **Affects:** runner=self-hosted, runtime=gvisor|kata, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** OCI runtime create failed · unknown capability reported by the container runtime at start · unsupported mount reported by the container runtime at start · The agent container never starts while Squid is healthy
- **Discriminating conditions:** The Docker daemon default runtime is not runc (for example gVisor runsc or Kata) · The failure happens at container create/start time, before any user command runs
- **Root cause:** unknown - alternative runtimes implement mounts, capabilities, and seccomp differently from runc; the specific unsupported feature must be identified from the runtime error before a fix is asserted.
- **Safe probe:** `docker info --format '{{.DefaultRuntime}} {{range $k,$v := .Runtimes}}{{$k}} {{end}}'` → Shows the active default runtime so the failure can be attributed to a non-runc runtime.
- **Action:** Record the exact runtime error and the runtime version, then consult docs/gvisor-integration.md for the supported configuration. Collect evidence rather than disabling seccomp or capabilities.
- **Related:** A4
- **Provenance:** doc: gVisor integration (docs/gvisor-integration.md) · doc: Supported platforms (docs/compatibility.md) · code: Runtime detection (src/container-runtime.ts) · test: src/container-lifecycle-gvisor.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

## Boundary: network

### NET-001 — Squid denies a request because the domain is not in the allowlist

- **Boundary:** network · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** TCP_DENIED · 403 Forbidden returned by the proxy for an outbound request · curl: (56) Received HTTP code 403 from proxy after CONNECT
- **Discriminating conditions:** The destination host resolves but Squid logs TCP_DENIED:HIER_NONE for it · The domain (or its parent domain) is absent from --allow-domains / network.allowDomains
- **Root cause:** Egress filtering is working as designed: the requested domain is not covered by the generated Squid domain ACL.
- **Safe probe:** `docker exec awf-squid awk '/TCP_DENIED/ { print $1, $2, $3, $7, $8 }' /var/log/squid/access.log | tail -20` → Shows timestamp, client, host, status, and decision for denied traffic; the host is absent from the allowlist.
- **Action:** Add the specific required domain (not a broad wildcard) to the allowlist after confirming it is expected traffic. Keep egress filtering on; if the denial looks like exfiltration, route to SEC-001.
- **Related:** NET-002, SEC-001
- **Provenance:** doc: Domain allowlisting (docs/egress-filtering.md) · doc: Squid log queries (docs/logging_quickref.md) · code: generateSquidConfig() domain ACLs (src/squid-config.ts) · test: src/squid-config-domains.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### NET-002 — DNS resolution fails because the resolver is not in the trusted DNS server list

- **Boundary:** network · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** Could not resolve host · Temporary failure in name resolution · getaddrinfo EAI_AGAIN inside the agent container
- **Discriminating conditions:** The configured resolver is not 127.0.0.11 and not listed in --dns-servers / AWF_DNS_SERVERS · HTTP/HTTPS to allowlisted domains also fails before any proxy log entry appears
- **Root cause:** Host and container iptables rules only permit DNS to the trusted resolvers configured through --dns-servers, so traffic to any other resolver is dropped to prevent DNS-based exfiltration.
- **Safe probe:** `docker exec awf-agent cat /etc/resolv.conf` → Lists a resolver that is not among the configured trusted DNS servers.
- **Action:** Pass the environment's resolver explicitly with --dns-servers (for example an internal corporate resolver) instead of disabling DNS filtering.
- **Related:** NET-001
- **Provenance:** doc: Network issues (docs/troubleshooting.md) · code: DNS restriction rules (src/host-iptables.ts) · code: AWF_DNS_SERVERS handling (containers/agent/setup-iptables.sh) · test: src/host-iptables-network.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

## Boundary: auth

### AUTH-001 — Enterprise or Business Copilot target rejects the Authorization header prefix

- **Boundary:** auth · **Status:** fixed
- **Affects:** runner=any, runtime=any, provider=copilot, auth=github-token
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** 400 Bad Request: Authorization header is badly formatted · Copilot requests fail immediately against api.enterprise.githubcopilot.com or api.business.githubcopilot.com
- **Discriminating conditions:** The resolved Copilot target is the enterprise or business host, or GHES is detected (AWF_PLATFORM_TYPE=ghes, or GITHUB_SERVER_URL is neither github.com nor *.ghe.com) · A classic PAT or OAuth GitHub token is used (fine-grained github_pat_* tokens and BYOK keys always use Bearer)
- **Root cause:** The enterprise and business Copilot targets require the 'token' Authorization prefix for classic PAT/OAuth tokens; AWF selects the prefix in copilotTargetRequiresGitHubTokenPrefix(), so a target or platform-type misdetection produces the wrong prefix.
- **Safe probe:** `awf --version && server_url=${GITHUB_SERVER_URL:-} && server_host=${server_url#*://} && server_host=${server_host%%/*} && echo "GITHUB_SERVER_URL host: ${server_host:-unset}" && echo "AWF_PLATFORM_TYPE is ghes: $([ "${AWF_PLATFORM_TYPE:-}" = ghes ] && echo yes || echo no)"` → Shows the AWF version, parsed server host, and whether AWF_PLATFORM_TYPE explicitly selects GHES. Never print token values or Authorization headers.
- **Action:** Confirm the target host and platform detection inputs (AWF_PLATFORM_TYPE, GITHUB_SERVER_URL) are set for the enterprise/GHES deployment so the documented prefix is selected. See docs/auth-matrix.md for the supported combinations; do not paste tokens into the diagnosis.
- **Related:** AUTH-002
- **Provenance:** doc: Provider: GitHub Copilot (docs/auth-matrix.md) · pull-request: Fine-grained PATs always use Bearer (https://github.com/github/gh-aw-firewall/pull/8038) · code: copilotTargetRequiresGitHubTokenPrefix() (containers/api-proxy/providers/copilot-auth.js) · test: containers/api-proxy/copilot-adapter-enterprise.test.js
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### AUTH-002 — API-proxy OIDC mode is configured but the Actions token request variables are missing

- **Boundary:** auth · **Status:** workaround
- **Affects:** runner=github-hosted, runtime=any, provider=any, auth=github-oidc
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** api-proxy reports that no OIDC token could be minted · Provider requests fail with 401 while AWF_AUTH_TYPE=github-oidc is set · ACTIONS_ID_TOKEN_REQUEST_URL is not available to the sidecar
- **Discriminating conditions:** AWF_AUTH_TYPE=github-oidc with AWF_AUTH_PROVIDER set · The workflow job does not declare permissions: id-token: write, or the lock file predates runner-to-sidecar propagation of the Actions OIDC variables
- **Root cause:** The sidecar mints the GitHub OIDC JWT itself, so it needs the Actions token-request variables forwarded to it; without permissions.id-token: write those variables never exist, and the agent is intentionally excluded from receiving them.
- **Safe probe:** `grep -n 'id-token' .github/workflows/<workflow>.lock.yml` → Shows whether the job declares permissions: id-token: write. Check configuration shape only - never print the token or perform a token exchange.
- **Action:** Declare permissions: id-token: write on the job and recompile the workflow so the Actions OIDC request variables reach the api-proxy sidecar. Never work around this by exposing those variables to the agent container or by widening the agent environment.
- **Related:** AUTH-003, SEC-001
- **Provenance:** doc: OIDC authentication (keyless credential exchange) (docs/authentication-architecture.md) · doc: OIDC providers (docs/auth-matrix.md) · code: Sidecar token provider (containers/api-proxy/github-oidc.js) · test: containers/api-proxy/providers/cloud-oidc-init.test.js
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

### AUTH-003 — gh-aw-launched HTTP MCP GitHub server fails the OIDC boundary check

- **Boundary:** auth · **Status:** workaround
- **Affects:** runner=any, runtime=any, provider=github-mcp, auth=github-oidc
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** mcpg / HTTP MCP GitHub server returns 401 for github-oidc authentication · Gateway configuration contains no OIDC auth metadata · MCP GitHub tool calls fail while provider inference still works
- **Discriminating conditions:** The GitHub MCP server is configured as an HTTP MCP server with github-oidc auth · The lock file was compiled before the runner-to-gateway OIDC propagation fix, or the job lacks permissions: id-token: write
- **Root cause:** The Actions OIDC request variables must travel from the runner to the gh-aw-launched gateway, never through the AWF agent; stale lock files or a missing id-token permission break that path.
- **Safe probe:** `grep -n 'id-token\|github-oidc' .github/workflows/<workflow>.lock.yml` → Shows whether the compiled lock declares id-token: write and github-oidc auth metadata. Inspect shape only - no JWTs, headers, or token exchanges.
- **Action:** Recompile the workflow with a gh-aw version that enforces the runner-to-gateway OIDC path and declare permissions: id-token: write. Never edit lock files by hand and never forward the Actions OIDC variables into the agent container.
- **Related:** AUTH-002
- **Provenance:** issue: HTTP MCP github-oidc boundary (https://github.com/github/gh-aw/issues/50053) · pull-request: Enforce runner-to-gateway OIDC path (https://github.com/github/gh-aw/pull/50054) · doc: OIDC-authenticated MCP servers (docs/authentication-architecture.md)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

## Boundary: ci

### CI-001 — gh-aw safe-output step fails because the emitted payload violates the declared contract

- **Boundary:** ci · **Status:** workaround
- **Affects:** runner=github-hosted, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** safe output validation failed in the workflow run · The agent job succeeds but the safe-output collection step exits non-zero · create-pull-request rejected: file not in allowed-files
- **Discriminating conditions:** The workflow declares safe-outputs in its .md source · The failure occurs in the post-agent safe-output step, not inside the AWF sandbox
- **Root cause:** Safe outputs are validated against the compiled contract (max counts, labels, title prefix, allowed-files); an agent that writes outside that contract fails the step rather than the GitHub API call.
- **Safe probe:** `gh aw logs <workflow-name>` → Shows the safe-output validation error and which declared constraint was violated.
- **Action:** Fix the workflow .md source (safe-outputs constraints or prompt) and recompile with gh aw compile; never hand-edit the .lock.yml. Widening permissions is not a fix for a contract violation.
- **Provenance:** doc: AWF in GitHub Actions (docs/github_actions.md) · doc: Debugging agentic workflows (.github/skills/debugging-workflows/SKILL.md) · test: Compiled workflow contract checks (scripts/ci/ready-for-aw-workflows.test.ts)
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

## Boundary: security

### SEC-001 — Suspected isolation or credential-boundary regression must go to security review, not a bypass

- **Boundary:** security · **Status:** needs-evidence
- **Affects:** runner=any, runtime=any, provider=any, auth=any
- **Versions:** introduced=unknown, fixed=unknown
- **Symptoms:** The agent container can reach a domain that is not allowlisted · A provider credential is observable inside the agent environment while the api-proxy is enabled · Egress succeeds without a corresponding Squid access-log entry
- **Discriminating conditions:** The observed behaviour weakens an AWF isolation guarantee rather than blocking legitimate work · The failure is a capability that should not exist, not a missing allowlist entry
- **Root cause:** unknown - a suspected regression in the egress or credential-isolation boundary requires verification against current main before any cause is asserted.
- **Safe probe:** `docker exec awf-squid awk '{ print $1, $2, $3, $7, $8 }' /var/log/squid/access.log | tail -50` → Shows timestamp, client, host, status, and decision only; absence of a matching entry for successful egress indicates a bypass worth escalating.
- **Action:** Escalate through the repository security review process with the redacted evidence. Remediation is never a bypass: do not widen the agent environment, weaken isolation, or broaden the domain allowlist.
- **Related:** NET-001, AUTH-002
- **Provenance:** doc: Security model (docs/security.md) · doc: Trust boundaries (docs/architecture.md) · code: Generated egress policy (src/squid-config.ts) · test: src/squid-config-security.test.ts
- **Owner:** @github/gh-aw-firewall-maintainers · **Review by:** 2027-03-31

<!-- END GENERATED: docs/diagnostics/findings -->
