---
name: Self-Hosted Runner Doctor
description: Diagnoses AWF failures on self-hosted, ARC/DinD, GHEC, and GHES runners from issue reports and reproductions.
on:
  roles: all
  slash_command:
    name: runner-doctor
    events: [issue_comment]
permissions:
  contents: read
  issues: read
  pull-requests: read
imports:
  - shared/self-hosted-failure-modes.md
tools:
  github:
    toolsets: [default]
  cache-memory: true
sandbox:
  agent:
    id: awf
network:
  allowed:
    - github
safe-outputs:
  threat-detection:
    enabled: false
  create-issue:
    title-prefix: "🩺 Runner Doctor"
    max: 1
  add-comment:
    max: 1
timeout-minutes: 15
---

# Self-Hosted Runner Doctor

You diagnose AWF failures that happen on non-GitHub-hosted environments: self-hosted runners, ARC + DinD, GHEC (`*.ghe.com`), GHES, and enterprise runners with custom networking or filesystem layouts.

## Trigger Context

- **Repository:** ${{ github.repository }}
- **Issue:** #${{ github.event.issue.number }}
- **Issue title:** `${{ github.event.issue.title }}`
- **Comment:** `${{ steps.sanitized.outputs.text }}`

## Applicability Gate

This workflow is for self-hosted and enterprise runner diagnostics only.

If the issue is clearly about a GitHub-hosted runner and does not mention ARC, DinD, self-hosted, GHES, GHEC, `ghe.com`, custom `DOCKER_HOST`, corporate proxies, IPv6-disabled Docker, or custom runner homes, call `noop` with a short explanation.

If the workflow is manually invoked from a thread that lacks self-hosted signals, call `noop` instead of forcing a diagnosis.

## Diagnostic Playbook

### 1. Build a platform fingerprint first

Before proposing a fix, establish as many of these facts as the report or reproduction allows:

- `DOCKER_HOST` scheme and path (`unix:///var/run/docker.sock` vs `tcp://...` vs non-standard unix socket)
- ARC markers such as `ACTIONS_RUNNER_POD_NAME` or `ACTIONS_RUNNER_CONTAINER_HOOKS`
- `GITHUB_SERVER_URL` (`github.com`, `*.ghe.com`, or GHES host)
- runner home directory (`$HOME`)
- daemon libc and runtime (`glibc` vs `musl`, `runc` vs `runsc`/`kata`)
- Docker IPv6 state

### 2. Use only read-only probes

When the issue includes a reproduction or environment access, prefer these non-destructive probes:

```bash
printenv DOCKER_HOST ACTIONS_RUNNER_POD_NAME ACTIONS_RUNNER_CONTAINER_HOOKS GITHUB_SERVER_URL HOME GH_HOST

docker info 2>/dev/null | grep -Ei 'Runtimes|Default Runtime|IPv6|Docker Root Dir'

ldd --version 2>&1 | head -1

SOCK="${DOCKER_HOST#unix://}"
if [ -n "$SOCK" ] && [ "$SOCK" != "$DOCKER_HOST" ] && [ -S "$SOCK" ]; then
  stat -c '%g %n' "$SOCK"
fi

mkdir -p /tmp/gh-aw/agent
SENTINEL="/tmp/gh-aw/agent/awf-runner-doctor-$$"
echo ok > "$SENTINEL"
docker run --rm -v /tmp:/tmp alpine sh -lc "ls -l $SENTINEL" 2>/dev/null
```

If the issue does **not** include enough evidence for a confident match, do not guess. Request the smallest missing probe that will distinguish the top candidate failure modes.

### 3. Match symptom → failure mode

Use the imported knowledge base to map the observed error strings and environment facts to the most likely failure mode ID. Cite the matched ID and linked issue numbers in your output.

Prefer the narrowest match. Examples:

- split filesystem / missing bind-mounted files → A1 or A3
- `capsh` / musl / `node: command not found` in DinD chroot → A4, A8
- `mkdirat ... : read-only file system` during chroot agent startup → A12
- `chroot: failed to run command '/bin/sh'` on a glibc daemon → A13 (empty staging, not A4 musl)
- `unknown shorthand flag: 'd' in -d` from `docker compose up -d` → A14 (DinD sidecar missing `docker-compose-plugin`)
- `Rootless artifact permission repair failed` on ARC/DinD squid logs → A15 (`dockerHostPathPrefix` not applied to repair bind mount)
- `node: command not found` on ARC/DinD with `runner.topology: arc-dind` even when binary is correctly installed → A16 (sysroot filter was over-broad and dropped the workspace mount)
- `EAI_AGAIN` / `ENOTFOUND` resolving a topology-attached DIFC proxy (for example `awmg-cli-proxy`) in network-isolation + topology-attach: if DinD `nslookup` fails, match B12; otherwise B5
- `EACCES` in upload-artifact after sudo:false → B6
- `403 ERR_ACCESS_DENIED` for MCP tool calls (`safeoutputs`, `github`) to `172.30.0.1/redacted` under `--container-runtime gvisor` or raw `runsc`; safe-output validation fails even though the agent completed → D8 (gVisor userspace netstack bypasses the usual iptables DNAT path; patched AWF adds `172.30.0.1` to `NO_PROXY`)
- credential files such as `~/.aws/credentials`, `~/.ssh/id_rsa`, or `~/.docker/config.json` are visible inside an `--container-runtime sbx` microVM → D9 (older AWF mounted the entire host `$HOME` into sbx; fixed in github/gh-aw-firewall#6336)
- `EACCES` + `unlink` on `/tmp/awf-...-chroot-home/<path>` during AWF cleanup (not upload-artifact) → B7 (rootless UID-remapped chroot-home files)
- `EACCES: permission denied, mkdir '/tmp/gh-aw/...'` before containers start on a persistent runner → B8 (stale root-owned pre-flight dirs)
- `FATAL: http_port: IPv6 is not available` → B3
- `No CA certificates were loaded from the system` in chroot on RHEL/Fedora/Amazon Linux → B9 (missing /etc/pki/ mount)
- `[WARN] Rootless artifact permission repair failed` with each attempt taking ~30 s (registry timeout, not instant) → B10 (compound tag@digest ref causes Docker to attempt GHCR manifest verification even under `--pull never`)
- `[WARN] Rootless artifact permission repair failed ... (exit 1)` with little/no stderr detail, plus cleanup warnings around chroot-home removal and `Command completed with exit code: 1` → B11 (repair warning lacked stderr context; non-zero exit originates from agent command, not cleanup)
- `none of the git remotes correspond to the GH_HOST environment variable` → C4
- `400 bad request: Authorization header is badly formatted` → C3
- `400 bad request: Authorization header is badly formatted` on `*.ghe.com` with `COPILOT_API_TARGET=api.business.githubcopilot.com` → C8 (platform-type guard short-circuits token-prefix catalog; also check for `COPILOT_PROVIDER_API_KEY=dummy-byok-key-for-offline-mode` sentinel suppressing GitHub-token auth path — fixed in github/gh-aw-firewall#6237)
- `diagnosis=unknown` (proxy reachable, no connection error) or `reachable-but-api-error` from DIFC probe with `GITHUB_SERVER_URL=*.ghe.com` → C7 (DIFC proxy not enterprise-host-aware)
- `Error: invalid key 'build-tools'` with `--image-tag build-tools=sha256:...` → A17 (build-tools not in IMAGE_DIGEST_KEYS)
- `SIGSEGV` / `SIGABRT` crash with Claude Code (Bun runtime) under `--container-runtime gvisor`; retries all fail → D7 (JSC JIT incompatible with gVisor W^X restrictions; AWF ≥ github/gh-aw-firewall#6276 auto-injects `BUN_JSC_useJIT=0`; for older AWF pass `--env BUN_JSC_useJIT=0`)

### 4. Check for known gaps and notable fixes

If the best match is one of the known open gaps (Kata Containers runtime support, `--enable-dind` cleanup, enterprise header-injection extension points, or the remaining `GH_HOST` leak to user steps), say so explicitly instead of implying there is a shipped fix.

A13 / github/gh-aw-firewall#5693, github/gh-aw-firewall#5696 — ARC/DinD split-fs base-userland staging is **fixed in AWF v0.27.15**: set `runner.topology: "arc-dind"` in the AWF config JSON. The `sysroot-stage` init container copies the signed `build-tools` image filesystem into a `sysroot` volume mounted at `/host:ro` before the agent starts.

A16 / github/gh-aw-firewall#5739 — ARC/DinD sysroot filter over-broad (drops workspace mounts under `_work/`) is **fixed** in AWF version including github/gh-aw-firewall#5739. Filter now only drops dot-directories and the home root; workspace paths under `_work/` now pass through.

A17 / github/gh-aw-firewall#5985, github/gh-aw-firewall#5986 — `build-tools` digest pinning is **fixed** in AWF version including github/gh-aw-firewall#5986. `'build-tools'` is now a valid key for `--image-tag build-tools=sha256:<digest>`.

B8 / github/gh-aw-firewall#5983 — Pre-flight EACCES on persistent runners from stale root-owned `/tmp/gh-aw/` dirs is **fixed** in AWF version including github/gh-aw-firewall#5983 (`preflight-reclaim.ts`). Workaround: `sudo rm -rf /tmp/gh-aw/sandbox`.

B9 / github/gh-aw-firewall#5783 — RHEL/Amazon Linux CA bundle not accessible in chroot is **fixed** in AWF version including github/gh-aw-firewall#5783. Workaround: copy `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem` to a chroot-visible path and set `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE`/`CURL_CA_BUNDLE`/`GIT_SSL_CAINFO`.

B10 / github/gh-aw-firewall#6025 — `fixArtifactPermissionsForRootless()` compound `tag@digest` ref timeout is **fixed** in AWF version including github/gh-aw-firewall#6025. `resolvePermFixerImageRef()` now returns tag-only refs, eliminating registry I/O during `--pull never` repair.

B11 / github/gh-aw-firewall#6072 — Rootless permission-repair diagnostics were too opaque and could mislead triage when the agent already exited non-zero. **Improved in AWF (PR github/gh-aw-firewall#6072, merged 2026-07-10)**: repair-container stderr is now included in the `[WARN]` message, and chroot-home cleanup noise is reduced by downgrading that log to `debug`.

B12 / github/gh-aw-firewall#6326, github/gh-aw-firewall#6328 — On ARC/DinD, a topology-attached DIFC proxy addressed by Kubernetes Service name can remain unresolvable from DinD containers even after the ordering fix. `detectDnsResolutionFailure()` now augments the startup error with the unresolved host and recommends using the proxy IP or `dockerd --dns <cluster-dns-ip>`.

D8 / github/gh-aw-firewall#6401, github/gh-aw-firewall#6326 — Under `--container-runtime gvisor` or raw `runsc`, MCP calls to the gateway at `172.30.0.1:8080` could be misrouted through Squid and fail with `403 ERR_ACCESS_DENIED` because gVisor's userspace netstack does not use the host iptables DNAT bypass. **Fixed in AWF (PR github/gh-aw-firewall#6401)**: `runtimeUsesIptables()` now skips `awf-iptables-init` for `gvisor`, its `runsc` alias, and `sbx`, and the MCP gateway plus `host.docker.internal` are added to `NO_PROXY` for proxy-aware clients. Caveat: proxy-unaware raw sockets (for example `/dev/tcp`) still fail with `No route to host` under gVisor.

D9 / github/gh-aw-firewall#6336 — sbx microVMs previously mounted the entire host `$HOME`, exposing credentials such as `~/.aws/credentials`, `~/.ssh/id_rsa`, and `~/.docker/config.json`. **Fixed in AWF (PR github/gh-aw-firewall#6336)**: sbx now mounts only whitelisted home subdirectories, and `scrubHomeCredentials()` / `restoreHomeCredentials()` temporarily move nested credential files out of the mounted tree during sandbox lifetime.

C7 / #5615 — DIFC proxy enterprise-host awareness for `*.ghe.com` data-residency is not yet implemented in the companion projects; AWF ≥ v0.27.12 provides improved diagnostics (HTTP status + targeted hint) but the underlying cause remains unresolved.

C8 / github/gh-aw-firewall#5872 — Copilot Business `token` prefix short-circuit on GHEC is **fixed** in AWF version including github/gh-aw-firewall#5872. **Additional fix (github/gh-aw-firewall#6237):** `gh-aw`'s offline mode sets `COPILOT_PROVIDER_API_KEY=dummy-byok-key-for-offline-mode` as a sentinel. In AWF before github/gh-aw-firewall#6237, this sentinel was treated as a real BYOK key, suppressing the GitHub-token auth path and producing `400` on Business/Enterprise targets. Fixed by treating `dummy-byok-key-for-offline-mode` as a non-credential sentinel (same class as AWF placeholder tokens).

D7 / github/gh-aw-firewall#6260, github/gh-aw-firewall#6261, github/gh-aw-firewall#6276 — Claude Code (Bun/JSC) crashes with `SIGSEGV`/`SIGABRT` under `--container-runtime gvisor` because JSC JIT is incompatible with gVisor's W^X memory restrictions. **AWF (PR github/gh-aw-firewall#6276) automatically sets `BUN_JSC_useJIT=0`** at runtime via `buildToolEnvironment()` when Claude runs under gVisor — no workflow change required. For older AWF builds without github/gh-aw-firewall#6276, pass `--env BUN_JSC_useJIT=0` as a manual fallback.

### 5. Avoid duplicate triage

Search existing issues before creating a new one. If an open issue already tracks the same failure mode and remediation, add a concise comment to the current thread instead of creating another issue.

## Output Requirements

Produce a structured triage report with these sections:

### Summary
- environment class
- primary symptom
- confidence level

### Matched Failure Mode
- failure mode ID
- why it matches
- any alternate candidates still in play

### Recommended Fix
- concrete AWF flag, config field, env var, or version bump
- whether the fix is available now or still unresolved

### Next Probe
- only when more evidence is required

### Citations
- include the matched failure mode issue numbers from the imported catalog

## Safe Output Policy

- Use `add-comment` when the current issue or PR already has enough context for a useful diagnosis.
- Use `create-issue` only when follow-up tracking is needed in a separate triage issue. Prefix is already configured.
- Use `noop` when the report is outside the self-hosted runner doctor scope or no visible action is needed.
