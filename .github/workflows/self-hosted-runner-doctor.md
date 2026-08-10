---
name: Self-Hosted Runner Doctor
description: Diagnoses AWF failures on self-hosted, ARC/DinD, GHEC, and GHES runners from issue reports and reproductions.
on:
  roles: all
  slash_command:
    name: runner-doctor
    events: [issue_comment]
permissions:
  copilot-requests: write
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
- Copilot CLI exits immediately (exit code 1, ~0.5 s, zero stdout/stderr) after AWF upgrade on Docker or gVisor but not sbx → B14 (`~/.copilot/config.json` incorrectly added to credential deny list; fixed in github/gh-aw-firewall#6374)
- `copilot: command not found` inside `--container-runtime sbx` when binary is at `~/.local/bin/copilot` → D10 (`bash -lc` login init resets injected PATH in sbx; fixed by wrapping the executed command with `export PATH="$HOME/.local/bin${PATH:+:$PATH}"` in github/gh-aw-firewall#6407)
- `SIGABRT` / `signal=SIGABRT duration=0s stdout=0B` for Copilot CLI all retries under `--container-runtime gvisor`; or exit 139 / `Segmentation fault` on bash wrapper, often before any model or tool call → D11 (Node.js v22 V8 ESM decode assertion under gVisor; one-shot restart mitigation in github/gh-aw-firewall#6514; underlying Node/gVisor incompatibility unresolved in github/gh-aw-firewall#6558)
- `Model "auto" has no AI credits pricing and no default pricing is configured` together with `awf-reflect: request failed: fetch failed` under `--container-runtime gvisor` or `sbx` → D12 (isolated runtime cannot reach `/reflect` to pre-resolve `auto`; AI-credits guard rejected sentinel `auto`; fixed in github/gh-aw-firewall#6811)
- `TCP_DENIED` in Squid access log for a topology peer or `difcProxyHost` during agent run; in-session MCP/HTTP calls to those hosts fail in network-isolation mode → B13 (topology peer hostnames and `difcProxyHost` not added to `NO_PROXY`; fixed in github/gh-aw-firewall#6189 and github/gh-aw-firewall#6438; if block report still flags topology peer after github/gh-aw-firewall#6473, treat as audit/policy-manifest reporting false positive tracked in github/gh-aw-firewall#6652 / github/gh-aw-firewall#6658 — runtime traffic is not blocked)
- `⚠️ Firewall blocked N domain(s)` warning lists `awmgmcpg` or `172.30.0.x` as a blocked domain on every run, even with no actual external blocks → B13 (internal MCP gateway traffic counted by log aggregator as denied; fixed in github/gh-aw-firewall#6689 with `isInternalAwfDomain()` filter)
- `--network-isolation is not yet supported with --enable-host-access` → B15 (compiler auto-emits both flags when `localhost` in allowlist + topology; fixed in github/gh-aw-firewall#6657)
- AWF rejects `--mount` with "host path must be absolute" and the path visibly contains `${VAR_NAME}` unexpanded → B16 (single-quote wrapping by compiler prevents shell expansion of `${}` in mount specs; fixed in github/gh-aw-firewall#6655)
- `503 TCP_TUNNEL:HIER_NONE` (server field `-:-`) on an allowlisted API host in network-isolation/topology mode, specifically after a Tailscale-up step → B17 (Tailscale policy-routing captures the default route, making host-specific DNS servers unreachable; fixed in github/gh-aw-firewall#6705 with `filterForNetworkIsolation()` stripping non-portable DNS before Squid config is generated)
- Azure CLI / ADO MCP auth failures with `~/.azure` missing inside AWF sandbox, or `AZURE_CONFIG_DIR`/`ADO_MCP_AUTH_TOKEN` empty inside agent despite being set on the runner → B18 (`.azure` was in `home.forbiddenSubdirs` and auth env vars were not forwarded; fixed in github/gh-aw-firewall#6690 — note: pre-AWF `az login` is not inherited; agent must perform OIDC re-login inside the sandbox, see github/gh-aw-firewall#6686)
- `[WARN] Could not fix squid log permissions: ... Operation not permitted` appears as the last log after an unrelated primary AWF startup failure → B19 (benign rootless chmod cleanup error not demoted, obscuring the real failure; fixed in github/gh-aw-firewall#6939)
- `ENETUNREACH ... :18443` (or default bridge gateway IP) from `awf-cli-proxy` in `--network-isolation` mode → B20 (known unresolved; #7066 dual-home approach was reverted because it granted general external egress from `cli-proxy`)
- `unable to create native thread` / `Cannot create worker GC thread` inside the AWF agent from concurrent JVM builds → B21 (Docker `pids_limit` hardcoded to 1000 with no visibility/configurability; fixed in github/gh-aw-firewall#7150 with `--pids-limit`/`container.pidsLimit` plus `mount_host_cgroupfs()`)
- Strict-security workflow (no `--legacy-security`) cannot reach a GitHub Actions `services:` raw-protocol port via `--enable-host-access` → B22 (strict topology has neither a `host.docker.internal` route nor a host-access bypass, and raw clients cannot use Squid; AWF needs a supported topology path and gh-aw must derive service ports)
- `spawn /usr/local/bin/copilot ENOENT` specifically on a tool-cache **hit** (distinguish from the general PATH-resolution note already covered elsewhere) → B23 (gh-aw's cache-hit path skips the `/usr/local/bin/copilot` wrapper install while the compiler harness always spawns that hardcoded path; documentation-only fix in AWF, github/gh-aw-firewall#7151; durable fix tracked in github/gh-aw-firewall#7130, open)
- `EACCES` + `unlink` on `/tmp/awf-...-chroot-home/<path>` during AWF cleanup (not upload-artifact) → B7 (rootless UID-remapped chroot-home files)
- `EACCES: permission denied, mkdir '/tmp/gh-aw/...'` before containers start on a persistent runner → B8 (stale root-owned pre-flight dirs)
- `FATAL: http_port: IPv6 is not available` → B3
- `No CA certificates were loaded from the system` in chroot on RHEL/Fedora/Amazon Linux → B9 (missing /etc/pki/ mount)
- `[WARN] Rootless artifact permission repair failed` with each attempt taking ~30 s (timeout, not instant) → B10 (compound tag@digest ref causes Docker to attempt GHCR manifest verification even under `--pull never`; or, even with a tag-only ref, `docker run` missing `--entrypoint sh` causes AWF's own `entrypoint.sh` to run and wait ~30 s for iptables-init — fixed in github/gh-aw-firewall#6342/github/gh-aw-firewall#6356)
- `[WARN] Rootless artifact permission repair failed ... (exit 1)` with little/no stderr detail, plus cleanup warnings around chroot-home removal and `Command completed with exit code: 1` → B11 (repair warning lacked stderr context; non-zero exit originates from agent command, not cleanup)
- `none of the git remotes correspond to the GH_HOST environment variable` → C4
- `400 bad request: Authorization header is badly formatted` → C3
- `400 bad request: Authorization header is badly formatted` on `*.ghe.com` with `COPILOT_API_TARGET=api.business.githubcopilot.com` → C8 (platform-type guard short-circuits token-prefix catalog; also check for `COPILOT_PROVIDER_API_KEY=dummy-byok-key-for-offline-mode` sentinel suppressing GitHub-token auth path — fixed in github/gh-aw-firewall#6237)
- `400 bad request: Authorization header is badly formatted` on derived `copilot-api.*.ghe.com` target specifically (not `api.business.githubcopilot.com`) → C9 (derived GHEC Copilot API target missing GitHub `token` prefix; fixed in github/gh-aw-firewall#6991)
- `diagnosis=unknown` (proxy reachable, no connection error) or `reachable-but-api-error` from DIFC probe with `GITHUB_SERVER_URL=*.ghe.com` → C7 (DIFC proxy not enterprise-host-aware)
- `Error: invalid key 'build-tools'` with `--image-tag build-tools=sha256:...` → A17 (build-tools not in IMAGE_DIGEST_KEYS)
- `EACCES` / write failures from XDG-respecting tools (Flutter, etc.) writing directly under `/home/runner` (for example `/home/runner/tool_state`) under `runner.topology: arc-dind` → A18 (`XDG_CONFIG_HOME` captured stale root-owned home before `HOME` updated to writable arc-dind path; fixed in github/gh-aw#48658)
- `create_pull_request` fails with `No patch file found` on ARC/DinD despite safeoutputs reporting a successful write → A19 (safeoutputs `/tmp/gh-aw` mount not `docker-host-path-prefix`-translated; fixed in github/gh-aw-firewall#6959)
- `SIGSEGV` / `SIGABRT` crash with Claude Code (Bun runtime) under `--container-runtime gvisor`; retries all fail → D7 (JSC JIT incompatible with gVisor W^X restrictions; AWF ≥ github/gh-aw-firewall#6276 auto-injects `BUN_JSC_useJIT=0`; for older AWF pass `--env BUN_JSC_useJIT=0`)

### 4. Check for known gaps and notable fixes

If the best match is one of the known open gaps (Kata Containers runtime support, `--enable-dind` cleanup, enterprise header-injection extension points, or the remaining `GH_HOST` leak to user steps), say so explicitly instead of implying there is a shipped fix.

A13 / github/gh-aw-firewall#5693, github/gh-aw-firewall#5696 — ARC/DinD split-fs base-userland staging is **fixed in AWF v0.27.15**: set `runner.topology: "arc-dind"` in the AWF config JSON. The `sysroot-stage` init container copies the signed `build-tools` image filesystem into a `sysroot` volume mounted at `/host:ro` before the agent starts.

A16 / github/gh-aw-firewall#5739 — ARC/DinD sysroot filter over-broad (drops workspace mounts under `_work/`) is **fixed** in AWF version including github/gh-aw-firewall#5739. Filter now only drops dot-directories and the home root; workspace paths under `_work/` now pass through.

A17 / github/gh-aw-firewall#5985, github/gh-aw-firewall#5986 — `build-tools` digest pinning is **fixed** in AWF version including github/gh-aw-firewall#5986. `'build-tools'` is now a valid key for `--image-tag build-tools=sha256:<digest>`.

A18 / github/gh-aw-firewall#6684, github/gh-aw#48658 — Under `runner.topology: arc-dind`, XDG-respecting tools (Flutter, etc.) fail with `EACCES` writing directly under `/home/runner` (for example `/home/runner/tool_state`) because `XDG_CONFIG_HOME` is set to the stale, root-owned `/home/runner` before `HOME` is updated to the writable `${RUNNER_TEMP}/gh-aw/home` path. `engine.env` is sourced before this export, so `XDG_CONFIG_HOME` overrides there are silently overwritten. **Fixed in gh-aw (PR github/gh-aw#48658, merged 2026-07-28):** `XDG_CONFIG_HOME` is now exported after `HOME` is reassigned to the writable arc-dind path. Upgrade gh-aw to the version including github/gh-aw#48658. **Workaround (older gh-aw):** Setting `XDG_CONFIG_HOME` in `engine.env` is ineffective because the later shell export overwrites it; override `HOME` to the writable path instead (e.g. add `HOME=${RUNNER_TEMP}/gh-aw/home` to `engine.env`).

A19 / github/gh-aw#50217, github/gh-aw-firewall#6948, github/gh-aw-firewall#6958, github/gh-aw-firewall#6959 — On ARC/DinD, `create_pull_request` fails with `No patch file found` / `No patch or bundle files found in: /tmp/gh-aw` even though the safeoutputs MCP server inside the agent container reports it successfully wrote `aw-.patch`/`aw-.bundle`. The `/tmp/gh-aw:/tmp/gh-aw:rw` bind mount used for the safeoutputs patch/bundle handoff was not passed through AWF's existing `translateBindMountHostPath()` / `--docker-host-path-prefix` normalization (`src/services/agent-volumes.ts`), so in DinD split-filesystem topologies the Docker daemon resolves the bind source against its own filesystem rather than the runner's staged path, and writes made inside the container land somewhere the runner-side ingestion step never sees. **Fixed in AWF (PR github/gh-aw-firewall#6959, merged 2026-08-05):** the safeoutputs exchange mount source is now built through the same `docker-host-path-prefix` translation path as other agent bind mounts (container target stays `/tmp/gh-aw`; only the host-side bind source changes when a prefix is configured). Upgrade AWF to include github/gh-aw-firewall#6959.

B8 / github/gh-aw-firewall#5983 — Pre-flight EACCES on persistent runners from stale root-owned `/tmp/gh-aw/` dirs is **fixed** in AWF version including github/gh-aw-firewall#5983 (`preflight-reclaim.ts`). Workaround: `sudo rm -rf /tmp/gh-aw/sandbox`.

B9 / github/gh-aw-firewall#5783 — RHEL/Amazon Linux CA bundle not accessible in chroot is **fixed** in AWF version including github/gh-aw-firewall#5783. Workaround: copy `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem` to a chroot-visible path and set `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE`/`CURL_CA_BUNDLE`/`GIT_SSL_CAINFO`.

B10 / github/gh-aw-firewall#6025 — `fixArtifactPermissionsForRootless()` compound `tag@digest` ref timeout is **fixed** in AWF version including github/gh-aw-firewall#6025. `resolvePermFixerImageRef()` now returns tag-only refs, eliminating registry I/O during `--pull never` repair. **Additional fix (github/gh-aw-firewall#6342 / github/gh-aw-firewall#6356, merged 2026-07-18):** Even with a tag-only ref, `docker run` was missing `--entrypoint sh`, causing AWF's `entrypoint.sh` to run in place of the repair command and wait ~30 s for an iptables-init container that never starts in this context. The fix adds `--entrypoint sh`, passes the command via `-c`, and captures stdout alongside stderr.

B11 / github/gh-aw-firewall#6072 — Rootless permission-repair diagnostics were too opaque and could mislead triage when the agent already exited non-zero. **Improved in AWF (PR github/gh-aw-firewall#6072, merged 2026-07-10)**: repair-container stderr is now included in the `[WARN]` message, and chroot-home cleanup noise is reduced by downgrading that log to `debug`.

B12 / github/gh-aw-firewall#6326, github/gh-aw-firewall#6328 — On ARC/DinD, a topology-attached DIFC proxy addressed by Kubernetes Service name can remain unresolvable from DinD containers even after the ordering fix. `detectDnsResolutionFailure()` now augments the startup error with the unresolved host and recommends using the proxy IP or `dockerd --dns <cluster-dns-ip>`.

B13 / github/gh-aw-firewall#6189, github/gh-aw-firewall#6438, github/gh-aw-firewall#6473, github/gh-aw-firewall#6652, github/gh-aw-firewall#6658, github/gh-aw-firewall#6685, github/gh-aw-firewall#6689 — In `--network-isolation` mode, MCP tool calls to topology-attached peers or to a `difcProxyHost` were failing because those hosts were not included in `NO_PROXY`. **Fixed in AWF (PR github/gh-aw-firewall#6189, merged 2026-07-20):** topology peer hostnames are added to `NO_PROXY`. **Fixed in AWF (PR github/gh-aw-firewall#6438, merged 2026-07-20):** `config.difcProxyHost` (stripped of `:port`) is also added to `NO_PROXY`. **Fixed in AWF (PR github/gh-aw-firewall#6473, merged 2026-07-21):** topology peer hostnames and `difcProxyHost` are also auto-added to the Squid ACL allowlist. Upgrade to AWF including all three PRs. **Fixed in AWF (PR github/gh-aw-firewall#6658, merged 2026-07-27):** Topology-peer rules are now added to the policy manifest, closing the audit attribution gap. The block report no longer incorrectly flags `awmg-mcpg` as denied. Upgrade AWF to the version including github/gh-aw-firewall#6658. **Additional fix (PR github/gh-aw-firewall#6689):** `isInternalAwfDomain()` in `src/logs/internal-domain-filter.ts` filters `TCP_DENIED` log entries whose destination is a `172.30.0.0/24` IP or single-label hostname (Docker container names always single-label) from both the runtime `⚠️ Firewall blocked N domain(s)` warning and `awf logs stats/summary` output. Upgrade AWF to the version including github/gh-aw-firewall#6689.

B14 / github/gh-aw-firewall#6339, github/gh-aw-firewall#6374 — After the centralized mount-policy refactor (github/gh-aw-firewall#6339), `~/.copilot/config.json` was incorrectly added to the credential deny list, causing AWF to overlay it with a read-only `/dev/null` bind mount. The Copilot CLI atomically rewrites this file at startup via temp-file + rename; the read-only overlay makes the rename fail and the CLI exits silently (exit 1, ~0.5 s). **Fixed in AWF (PR github/gh-aw-firewall#6374, merged 2026-07-18):** `config.json` is removed from the deny list and restored to read-write. Workaround (older AWF): downgrade past github/gh-aw-firewall#6339 or pass `--keep-containers` and inspect for `EROFS`/rename errors.

B15 / github/gh-aw-firewall#6651, github/gh-aw-firewall#6657 — AWF startup fails with `--network-isolation is not yet supported with --enable-host-access` when `localhost` is in the domain allowlist. The gh-aw compiler (v0.82.x+) auto-enables `--enable-host-access` when `localhost` is in the allowlist and also emits `network.isolation: true` + `topologyAttach` unconditionally; the two flags are mutually exclusive in `src/cli.ts` with no overlap support. **Fixed in AWF (PR github/gh-aw-firewall#6657, merged 2026-07-28):** The mutual-exclusion guard is removed; `--enable-host-access` now coexists with `--network-isolation` in topology mode. In topology mode the agent is on an `internal` Docker network with no host route, so `--enable-host-access` only drives Squid port ACLs and the `host.docker.internal` hosts-file entry — no incompatible iptables changes. `allowHostServicePorts` (iptables-based GitHub Actions services) is still suppressed unconditionally. Upgrade AWF to version including github/gh-aw-firewall#6657.

B16 / github/gh-aw-firewall#6649, github/gh-aw-firewall#6655 — AWF rejects `--mount` entries whose host path contains an unexpanded `${VAR}` reference (for example `${TERRAFORM_CLI_PATH}/terraform:/usr/local/bin/terraform`) with a "host path must be absolute" error. The gh-aw compiler wraps `sandbox.agent.mounts` specs containing `${}` in single quotes in the generated shell invocation; Bash single quotes prevent variable substitution, so the literal string reaches AWF's volume validator instead of the resolved path. **Fixed in AWF (PR github/gh-aw-firewall#6655, merged 2026-07-27):** `expandEnvVarsInMount()` in `src/parsers/volume-parsers.ts` now expands `${VAR_NAME}` and `$VAR_NAME` patterns from `process.env` before path validation. If the variable is undefined, AWF emits a precise error (`Environment variable is not set: ${VAR_NAME}`) rather than a misleading path-absoluteness failure. Upgrade AWF to the version including github/gh-aw-firewall#6655.

B17 / github/gh-aw-firewall#6704, github/gh-aw-firewall#6705 — In `--network-isolation`/topology mode, Tailscale can install a policy-routing rule covering `0.0.0.0/0`, capturing the default route and making host-specific DNS servers (Azure DHCP DNS `168.63.129.16`, Tailscale Magic DNS `100.100.100.100`, link-local `169.254.x.x`) unreachable from the Docker bridge network. Squid's DNS queries black-hole and every CONNECT fails with `503 TCP_TUNNEL:HIER_NONE` (server field `-:-`). **Fixed in AWF (PR github/gh-aw-firewall#6705, merged 2026-07-29):** `filterForNetworkIsolation()` in `src/dns-resolver.ts` strips non-portable DNS servers before generating `squid.conf` when `config.networkIsolation` is true; falls back to `8.8.8.8`/`8.8.4.4` if all detected servers are non-portable. Override via `--dns-servers` if specific DNS is required in isolation mode. Upgrade AWF to version including github/gh-aw-firewall#6705.

B18 / github/gh-aw-firewall#6686, github/gh-aw-firewall#6690 — Azure CLI, Azure DevOps CLI, and Azure/ADO MCP servers fail inside the AWF agent sandbox because `.azure` was in `home.forbiddenSubdirs` (not `home.toolSubdirs`) in the canonical sandbox mount policy, and `AZURE_CONFIG_DIR`/`ADO_MCP_AUTH_TOKEN` were absent from the always-forwarded env var list. **Fixed in AWF (PR github/gh-aw-firewall#6690, merged 2026-07-28):** `.azure` added to `home.toolSubdirs` and removed from `home.forbiddenSubdirs` (applies to both compose and sbx runtimes); `AZURE_CONFIG_DIR` and `ADO_MCP_AUTH_TOKEN` added to the always-forwarded env vars in `src/services/agent-environment/env-passthrough.ts`. **Authentication caveat:** #6690 deliberately scrubs Azure token cache files (`msal_token_cache*`, `accessTokens.json`, `service_principal_entries.json`) — a pre-AWF `az login` session is **not** inherited by the sandbox; only account metadata (tenant IDs, subscription list) is mounted. The agent must perform OIDC re-login inside the sandbox using a fresh writable `AZURE_CONFIG_DIR` (e.g. `az login --federated-token $ARM_OIDC_TOKEN --service-principal --username $ARM_CLIENT_ID --tenant $ARM_TENANT_ID`); see github/gh-aw-firewall#6686 for the working pattern. Upgrade AWF to version including github/gh-aw-firewall#6690 to enable this in-sandbox re-login.

B19 / github/gh-aw#50384, github/gh-aw-firewall#6934, github/gh-aw-firewall#6939 — AWF fails on a primary error (e.g. topology-peer attach failure: `Failed to connect container "awmg-mcpg" to network "awf-net": ... No such container`), but the last prominent diagnostic consumers see is instead a large `[WARN] Could not fix squid log permissions: Error: Command failed with exit code 1: chmod -R a+rX ... Operation not permitted` dump from best-effort cleanup, obscuring the real root cause. `preserveDirectory()` in `src/artifact-preservation.ts` ran a direct host-side `chmod -R a+rX` on Squid-owned log directories during cleanup and logged the full `execa` error object at `warn` level whenever it failed with `EPERM`/`EACCES` — even though this is an expected, benign outcome on rootless runners. The existing Docker-based rootless permission repair (`fixArtifactPermissionsForRootless()`) already classified these as benign debug output, but the direct chmod path did not reuse that classifier. **Fixed in AWF (PR github/gh-aw-firewall#6939, merged 2026-08-04):** `preserveDirectory()` now reuses the same benign-permission-error classifier as `fixArtifactPermissionsForRootless()`, demoting expected `EPERM`/`EACCES` chmod cleanup failures to concise `debug` output while still surfacing unexpected cleanup failures as warnings. This preserves the primary startup error as the last prominent diagnostic. Upgrade AWF to include github/gh-aw-firewall#6939.

B20 / github/gh-aw-firewall#7063, github/gh-aw-firewall#7066 — On `ubuntu-latest`/GitHub-hosted or plain self-hosted runners (no Tailscale/custom routing) in `--network-isolation` mode, `awf-cli-proxy` never becomes healthy because tcp-tunnel dials `ENETUNREACH 172.17.0.1:18443` against `host.docker.internal`, exhausting the DIFC liveness probe before the agent starts. `awf-net` is `internal: true` with no outbound route. Squid and api-proxy were already dual-homed onto `awf-ext`, but `cli-proxy` was attached only to `awf-net` even though it uses `host.docker.internal` to reach the external DIFC proxy. **Known unresolved:** the dual-home attempt in github/gh-aw-firewall#7066 was reverted because attaching `cli-proxy` to `awf-ext` grants general external egress from that sidecar. A constrained host-reachability fix has not merged yet, so upgrading to #7066 does not resolve this mode.

B21 / github/gh-aw-firewall#7148, github/gh-aw-firewall#7150 — Concurrent JVM-heavy builds (javac, Android manifest merger) inside the AWF agent container fail with `unable to create native thread` / `Cannot create worker GC thread`, and `/sys/fs/cgroup` inside the sandbox exposes no `pids.max`/`pids.current` (`ulimit -u` reports unlimited), so JVM tools have no way to discover or size against the real process/thread ceiling. AWF hardcoded Docker's `pids_limit` to 1000 with no visibility or configurability. **Fixed in AWF (PR github/gh-aw-firewall#7150, merged 2026-08-09):** a new `--pids-limit <n>` CLI flag (default 1000, matching prior behavior) with `container.pidsLimit` config-file support is plumbed through `cli-options.ts` → `validators/log-and-limits.ts` (`parsePidsLimit`) → `build-config.ts` → `services/agent-service.ts`. `containers/agent/entrypoint.sh` adds `mount_host_cgroupfs()` (best-effort) to bind-mount the container's delegated `/sys/fs/cgroup` read-only onto `/host/sys/fs/cgroup` so `pids.max`/`pids.current` are visible inside chroot. Upgrade AWF to include github/gh-aw-firewall#7150; raise the ceiling with `--pids-limit 4000` (or similar) for concurrent JVM builds.

B22 / github/gh-aw-firewall#7149, github/gh-aw-firewall#7152, github/gh-aw-firewall#7132 — Strict-security (`--network-isolation`, no `--legacy-security`) workflows cannot directly reach a GitHub Actions `services:` container that uses a raw protocol (for example Postgres on 5432) through `--enable-host-access` / `--allow-host-ports`. Strict topology omits the agent's `host.docker.internal` mapping and host-access iptables bypass, while raw clients such as `psql` cannot use Squid's HTTP `CONNECT` protocol. **Known unresolved:** AWF needs a supported strict-topology route for raw service protocols, and gh-aw must derive the required service ports. Until then, run direct service clients outside strict topology (for example with `--legacy-security`) or use a separately verified tunnel.

B23 / github/gh-aw-firewall#7130 (still open), github/gh-aw-firewall#7147, github/gh-aw-firewall#7151 — Copilot-engine workflows fail with `spawn /usr/local/bin/copilot ENOENT` specifically when the runner's tool-cache already has `copilot-cli` installed (a cache hit). This is **not an AWF defect**: gh-aw's `install_copilot_cli.sh` `activate_cached_copilot_bin()` prepends the cached dir to `PATH` and returns early on cache hits, skipping the wrapper install to `/usr/local/bin/copilot`, while the compiler-emitted harness (`copilot_harness.cjs`) always spawns the hardcoded absolute path `/usr/local/bin/copilot`. AWF's agent container mounts host `/usr`/`/usr/local` read-only, reflecting host state at container *start*, so a workaround symlink must exist on the host before `awf` is invoked. **No AWF code change (documentation only, PR github/gh-aw-firewall#7151, merged 2026-08-09)**: `docs/troubleshooting.md` gains a "Harness Binary Resolution Issues" section explaining the read-only `/usr` mount timing and that `chroot.binariesSourcePath` only helps `PATH`-based lookups, not hardcoded-absolute-path harness bugs. The durable fix belongs in gh-aw's installer/harness, tracked as github/gh-aw-firewall#7130 (open). Workaround: `sudo ln -sf "$(command -v copilot)" /usr/local/bin/copilot` on the **host**, before invoking `awf`.

D8 / github/gh-aw-firewall#6401, github/gh-aw-firewall#6326 — Under `--container-runtime gvisor` or raw `runsc`, MCP calls to the gateway at `172.30.0.1:8080` could be misrouted through Squid and fail with `403 ERR_ACCESS_DENIED` because gVisor's userspace netstack does not use the host iptables DNAT bypass. **Fixed in AWF (PR github/gh-aw-firewall#6401)**: `runtimeUsesIptables()` now skips `awf-iptables-init` for `gvisor`, its `runsc` alias, and `sbx`, and the MCP gateway plus `host.docker.internal` are added to `NO_PROXY` for proxy-aware clients. Caveat: proxy-unaware raw sockets (for example `/dev/tcp`) still fail with `No route to host` under gVisor.

D9 / github/gh-aw-firewall#6336 — sbx microVMs previously mounted the entire host `$HOME`, exposing credentials such as `~/.aws/credentials`, `~/.ssh/id_rsa`, and `~/.docker/config.json`. **Fixed in AWF (PR github/gh-aw-firewall#6336)**: sbx now mounts only whitelisted home subdirectories, and `scrubHomeCredentials()` / `restoreHomeCredentials()` temporarily move nested credential files out of the mounted tree during sandbox lifetime.

D10 / github/gh-aw-firewall#6407 — On `--container-runtime sbx`, the Copilot CLI installed rootless to `~/.local/bin` was not found because sbx executes commands via `bash -lc` (login shell), and login initialization can reset PATH and discard `--env PATH=...`. **Fixed in AWF (PR github/gh-aw-firewall#6407, merged 2026-07-19):** sbx now wraps the executed command with `export PATH="$HOME/.local/bin${PATH:+:$PATH}"` after login initialization (`withLocalBinOnPath()` in `sbx-manager.ts`). Workaround (older AWF): invoke `$HOME/.local/bin/copilot` directly, or prefix the agent command with `export PATH="$HOME/.local/bin${PATH:+:$PATH}"; ...`.

D12 / github/gh-aw-firewall#6810, github/gh-aw-firewall#6811 — Copilot runs using `model: auto` under isolated runtimes (`--container-runtime gvisor` or `sbx`) could fail before agent start with `awf-reflect: request failed: fetch failed` plus `Model "auto" has no AI credits pricing and no default pricing is configured` when `apiProxy.maxAiCredits` was enabled. **Fixed in AWF (PR github/gh-aw-firewall#6811, merged 2026-08-01):** api-proxy `checkUnknownModelRejection` now allows Copilot `auto` through pre-flight (`provider === 'copilot' && model.toLowerCase() === 'auto'`) and charges credits from the response's resolved model metadata. Non-Copilot providers still reject unresolved `auto`. Workaround (older AWF): pin a concrete priced model (for example `model: claude-sonnet-4.6`).

C7 / #5615 — DIFC proxy enterprise-host awareness for `*.ghe.com` data-residency is not yet implemented in the companion projects; AWF ≥ v0.27.12 provides improved diagnostics (HTTP status + targeted hint) but the underlying cause remains unresolved.

C8 / github/gh-aw-firewall#5872 — Copilot Business `token` prefix short-circuit on GHEC is **fixed** in AWF version including github/gh-aw-firewall#5872. **Additional fix (github/gh-aw-firewall#6237):** `gh-aw`'s offline mode sets `COPILOT_PROVIDER_API_KEY=dummy-byok-key-for-offline-mode` as a sentinel. In AWF before github/gh-aw-firewall#6237, this sentinel was treated as a real BYOK key, suppressing the GitHub-token auth path and producing `400` on Business/Enterprise targets. Fixed by treating `dummy-byok-key-for-offline-mode` as a non-credential sentinel (same class as AWF placeholder tokens).

C9 / github/gh-aw-firewall#6989, github/gh-aw-firewall#6991 — `400 bad request: Authorization header is badly formatted` on the derived GHEC data-residency Copilot target `copilot-api.<tenant>.ghe.com` is distinct from C8's `api.business.githubcopilot.com` case. `copilotTargetRequiresGitHubTokenPrefix()` did not recognize inferred `copilot-api.*.ghe.com` endpoints as GitHub-hosted GHEC data-residency targets requiring the `token` prefix, so GitHub OAuth/PAT credentials were sent as `Bearer`. **Fixed in AWF (PR github/gh-aw-firewall#6991, merged 2026-08-08):** `isGhecCopilotApiTarget()` sends GitHub OAuth/PAT credentials with `token` for derived `copilot-api.*.ghe.com` targets while preserving `Bearer` for BYOK credentials and the standard Copilot endpoint. Upgrade AWF to include github/gh-aw-firewall#6991.

D7 / github/gh-aw-firewall#6260, github/gh-aw-firewall#6261, github/gh-aw-firewall#6276 — Claude Code (Bun/JSC) crashes with `SIGSEGV`/`SIGABRT` under `--container-runtime gvisor` because JSC JIT is incompatible with gVisor's W^X memory restrictions. **AWF (PR github/gh-aw-firewall#6276) automatically sets `BUN_JSC_useJIT=0`** at runtime via `buildToolEnvironment()` when Claude runs under gVisor — no workflow change required. For older AWF builds without github/gh-aw-firewall#6276, pass `--env BUN_JSC_useJIT=0` as a manual fallback.

D11 / github/gh-aw-firewall#6558 — gVisor + Node.js v22 V8 ESM startup crash root cause remains unresolved (`SIGABRT` `StringBytes::Encode` assertion and occasional exit 139). **Mitigated in AWF (PR github/gh-aw-firewall#6514, merged 2026-07-23):** `runAgentCommand()` does a one-shot retry (`MAX_GVISOR_AGENT_RETRIES = 1`) when gVisor exits 134/139 within `GVISOR_STARTUP_CRASH_WINDOW_MS = 30_000`, but this does not prevent the underlying crash.

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
