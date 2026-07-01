# Self-Hosted Runner Failure Modes

Use this catalog when diagnosing AWF failures on self-hosted, ARC/DinD, GHEC, and GHES environments.

## Platform fingerprint checklist

Establish these facts before matching a failure mode:

- `DOCKER_HOST` scheme and socket path
- ARC markers: `ACTIONS_RUNNER_POD_NAME`, `ACTIONS_RUNNER_CONTAINER_HOOKS`
- `GITHUB_SERVER_URL`
- runner `HOME`
- daemon libc / runtime (`glibc`, `musl`, `runc`, `runsc`, `kata`)
- Docker IPv6 state

## Category A — ARC / DinD

| ID | Signal | Root cause | Fix / flag | Probe | Citations |
|---|---|---|---|---|---|
| A1 | Bind-mounted files are missing in DinD containers | Bind mounts point at runner paths that the DinD daemon cannot see | `--docker-host-path-prefix /tmp/gh-aw`, `container.dockerHostPathPrefix`, `AWF_DIND=1` | Create a `/tmp` sentinel on the runner, then `docker run -v /tmp:/tmp ... ls <sentinel>` | #2833, #2945, #3553, #3845, #3906, #4023, #4271, #4399, #4727, #4737, #4787 |
| A2 | `DOCKER_HOST=tcp://...` disappears and compose falls back to `/var/run/docker.sock` | TCP `DOCKER_HOST` was stripped instead of propagated | Preserve `DOCKER_HOST` into compose and container env | `docker -H "$DOCKER_HOST" info` and inspect generated compose env | #4830 |
| A3 | Non-standard unix `DOCKER_HOST` does not trigger split-fs handling | Split-filesystem auto-detection only keyed on `tcp://` | Treat non-default unix sockets and ARC fingerprints as split-fs | Check whether `DOCKER_HOST` uses a unix socket outside `/var/run/docker.sock` | #3553, #3906, #4023 |
| A4 | `capsh` missing, `/bin/bash` missing, or `node` missing in DinD chroot | Alpine/musl daemon host lacks glibc tooling expected by chroot mode | Use `ghcr.io/github/gh-aw-firewall/dind-ubuntu:latest`; fail fast on musl | `ldd --version`, inspect daemon `/etc/os-release`, verify `capsh` | #3393, #3397, #4567, #4737, #4787, #2535 |
| A5 | `one-shot-token.so ... __fprintf_chk: symbol not found` | The token-protection shared object was built for glibc, not musl | Use the build with `_FORTIFY_SOURCE=0`; expect graceful fallback warning | `ldd --version`, set `AWF_ONE_SHOT_TOKEN_DEBUG=1` | #2535 |
| A6 | `getent passwd <UID>` fails, `HOME=/`, `USER=root` inside chroot | DinD daemon lacks the runner UID in `/etc/passwd` and `/host/etc` is read-only | Use staged passwd/group synthesis; set `chroot.identity.*` when needed | `docker run --rm <dind-image> getent passwd $(id -u)` | #4829, #4831 |
| A7 | `HOME`, `USER`, or `LOGNAME` do not survive into the engine command | `capsh` user switching resets identity variables | Re-apply `chroot.identity.{home,user,uid,gid}` after `capsh` | Inspect `env` inside chroot after the user switch | #4567, #4787 |
| A8 | `/host/usr/local/bin/copilot` missing or `node: command not found` | Runner-installed binaries are not visible from the daemon filesystem | `chroot.binariesSourcePath`; `dind.stageEngineBinary.{path,targetPath}` | Test visibility of runner-installed binaries in a DinD container | #4271, #4399, #4727, #4737, #4787 |
| A9 | GitHub MCP tools disappear under `--disable-builtin-mcps` | `mount_mcp_as_cli.cjs` hardcoded the GitHub server as internal | Remove or make the internal-server list configurable | Check generated `mcp-*` shims and `INTERNAL_SERVERS` in the image | #4271, #4399, #4727, #4737, #4787 |
| A10 | `Docker socket not found` plus `Invalid container ID format: arc-...` | MCP gateway assumed `/var/run/docker.sock`, group 0, and Docker-style container IDs | Propagate `DOCKER_HOST`, detect socket GID, relax pod-name handling | `stat -c '%g' ${DOCKER_HOST#unix://}`, `cat /proc/self/cgroup` | #2267, #2292, #2664, #2706, #2808 |
| A11 | Threat detection passes even though the engine binary is missing | `GH_AW_DETECTION_CONTINUE_ON_ERROR` suppressed a real setup failure | Reconsider default or log the skipped check explicitly | `printenv GH_AW_DETECTION_CONTINUE_ON_ERROR`; inspect agent logs for `ENOENT` | #4787 |
| A12 | `mkdirat ... : read-only file system` during agent chroot startup on ARC/DinD | `chroot.binariesSourcePath` set to the same root as `--docker-host-path-prefix` (e.g. both `/tmp/gh-aw`); Docker mounts `/tmp/gh-aw/usr:/host/usr:ro` first, then the attempt to mkdir `/host/usr/local/bin` as a nested overlay mount point fails because the parent is read-only | **Fixed in firewall v0.27.10**: upgrade AWF; the overlay is now mounted at `/host/tmp/awf-runner-bin:ro` (writable `/host/tmp` parent) instead of `/host/usr/local/bin:ro` | Check `awf --version`; inspect agent container logs for `mkdirat`; verify `chroot.binariesSourcePath` equals `docker-host-path-prefix` root | #5481, #5482 |
| A13 | `chroot: failed to run command '/bin/sh': No such file or directory` or `[entrypoint][ERROR] capsh not found on host system` on a **glibc/Debian daemon** (not musl/Alpine) | ARC/DinD split-fs: system-mount source dirs (`/tmp/gh-aw/{usr,bin,lib,...}`) are empty because nothing populates them. The entrypoint "musl/Alpine" warning is **misleading** — it fires because no dynamic loader is found, not because the daemon is musl. | **Fixed in AWF v0.27.15**: set `runner.topology: "arc-dind"` in the AWF config JSON. AWF emits a `sysroot-stage` init container that copies the signed `build-tools` image filesystem (`bash`, `capsh`, `gcc`, dev libs, coreutils) into a named `sysroot` volume mounted at `/host:ro` before the agent starts. Use `runner.sysrootImage` to pin a specific image. | Check `awf --version` ≥ v0.27.15; verify `runner.topology: "arc-dind"` is set; inspect compose output for `sysroot-stage` service and `sysroot` volume | #5541, github/gh-aw-firewall#5693, github/gh-aw-firewall#5696 |

## Category B — Self-hosted runners

| ID | Signal | Root cause | Fix / flag | Probe | Citations |
|---|---|---|---|---|---|
| B1 | `/home/runner/...` paths are wrong on a custom runner home | The runner uses a non-standard `HOME` | Use the real `HOME`; when configuring stdin, set `chroot.identity.home` | `echo "$HOME"` and inspect mounted home paths | #2109, #2290 |
| B2 | All outbound traffic fails behind a mandatory corporate proxy | AWF must chain Squid through the upstream proxy | Set `https_proxy` / `http_proxy` on the host or use `--upstream-proxy` | `env | grep -i proxy`; inspect Squid config for `cache_peer` | #1975 |
|| B3 | Squid exits with `FATAL: http_port: IPv6 is not available` | Docker IPv6 is disabled but Squid tries to bind an IPv6 listener | Enable Docker/kernel IPv6 (required with current AWF builds), or use a custom AWF build that removes the `[::]` listener | `docker info | grep -i ipv6`; inspect `/proc/sys/net/ipv6/conf/all/disable_ipv6` | #2139 |
| B4 | `node: command not found` after `actions/setup-node` on self-hosted | Node was installed in `$HOME/work/_tool` and that toolcache is not visible | Mount / expose the runner toolcache; use `AWF_EXTRA_TOOLCACHE_DIRS` if needed | `which node`; inspect `$HOME/work/_tool/node` | #3544, #3545 |
| B5 | `getaddrinfo EAI_AGAIN <awmg-cli-proxy>` → `awf-cli-proxy could not connect to the external DIFC proxy` → `The agent was never invoked` in `--network-isolation` + `--topology-attach` runs | Startup ordering deadlock: `connectTopologyContainers()` runs only after `startContainers()` succeeds, but `startContainers()` blocks on the cli-proxy health gate that requires the topology peer to be reachable on `awf-net` (which `internal: true`). The peer is never attached → EAI_AGAIN → fail-fast → deadlock. Deterministic, not flaky. | Resolved in AWF: attach topology peers to `awf-net` before the health-gated bring-up (Fix A: split `up -d`, network first → attach → remaining); also harden cli-proxy to treat `EAI_AGAIN`/`ENOTFOUND` as not-yet-ready (Fix B) | Confirm `topologyAttach` is non-empty; check the cli-proxy logs for `EAI_AGAIN`; verify AWF version includes the ordering fix | #5543, #5542 |
| B6 | `EACCES` in `upload-artifact` step after a `sudo: false` (`--network-isolation`) AWF run; firewall log/audit dirs present but unreadable | Sidecars write files as non-runner UIDs (squid → uid 13, cli-proxy → `cliproxy`, agent/iptables-init → root). AWF's `chmod -R a+rX` repair runs as the unprivileged runner and silently fails at `debug` level on files it doesn't own | Resolved in AWF: (a) run Node sidecars as runner UID via compose `user:`; (b) root perm-fixer container at cleanup (daemon-run, mounts log dir, chowns to runner UID, skipped when `--keep-containers`); (c) promote swallowed-`chmod` failure from `debug` to `warn` | `ls -la <firewall-logs-dir>` after run — look for root or uid-13 owned files; check AWF logs for the swallowed `chmod` warning | #5545, #5542 |
| B7 | AWF < v0.27.13: unhandled `EACCES` stack trace shows `unlink ... /tmp/awf-<ts>-chroot-home/<path>` (e.g. `.aws/config`, cloud credentials). AWF ≥ v0.27.13: `removeWorkDirectories()` catches the error and emits `[WARN] Failed to remove chroot home directory after permission repair` instead of crashing | In rootless Docker mode the agent container runs with UID namespace remapping. Files created by the agent inside the `chroot-home` temp directory are owned by remapped UIDs. AWF's `removeWorkDirectories()` runs as the unprivileged host runner and `fs.rmSync` fails on these files. | **Partially fixed in AWF v0.27.13** (repair container with CHOWN/DAC_OVERRIDE/FOWNER capabilities); **further fix merged post-v0.27.15** (#5717): in rootless Docker the repair container's `chown` operates within the user namespace and may not change host-level ownership. The post-v0.27.15 fix adds `chmod -R a+rwX` so the host can delete the directory regardless of ownership. Non-fatal if unfixed — leaves an orphan `/tmp/awf-*-chroot-home` dir. | `ls -la /tmp/awf-*-chroot-home/` after a rootless run — files owned by non-runner UIDs confirm the mode; upgrade to AWF ≥ v0.27.13; check AWF logs for `[WARN] Failed to remove chroot home directory after permission repair` | #5653, github/gh-aw-firewall#5708, github/gh-aw-firewall#5717 |

## Category C — GHES / GHEC / `ghe.com`

| ID | Signal | Root cause | Fix / flag | Probe | Citations |
|---|---|---|---|---|---|
| C1 | DR-origin PAT authenticates, then `/close` fails with `invalid API key` | Data-residency Copilot token exchange must target tenant-specific endpoints | Route to `copilot-api.<tenant>.ghe.com`; verify PAT scope on the DR tenant | Check `GITHUB_SERVER_URL` and api-proxy routing logs | #1421 |
| C2 | Copilot auth fails on `*.ghe.com` at startup | The API proxy did not use the tenant-specific Copilot endpoint | Derive `copilot-api.<tenant>.ghe.com` from `GITHUB_SERVER_URL` | Inspect api-proxy and Squid logs for the target host | #1315 |
| C3 | `400 bad request: Authorization header is badly formatted` | AWF v0.27.0 assembled GHES Copilot auth headers incorrectly | Upgrade AWF to v0.27.2 or newer | `awf --version`; inspect api-proxy logs for 400s | #4867 |
| C4 | `none of the git remotes correspond to the GH_HOST environment variable` | `GH_HOST` leaked as `localhost:18443` instead of the real enterprise host | Derive `GH_HOST` from `GITHUB_SERVER_URL` even with `--env-all` | Print `GH_HOST` in the agent and compare to `git remote -v` | #1452, #1460, #1492, #1499 |
| C5 | `malformed version:` from `gh --repo` in later user steps | `GH_HOST=localhost:18443` leaked into non-AWF steps via `$GITHUB_ENV` | Primary fix belongs in gh-aw; cli-proxy can mitigate only partially | Check `$GITHUB_ENV` and `curl http://localhost:18443/api/v3/meta` | #3937 |
| C6 | Safe-outputs post-processing talks to github.com instead of GHES | gh-aw emitted `GH_HOST` to the wrong channel for later jobs | Fix the compiler / environment propagation in gh-aw | Inspect `$GITHUB_OUTPUT` and `$GITHUB_ENV` for `GH_HOST` | #1460, #1566 |
| C7 | `awf-cli-proxy` DIFC-proxy liveness probe loops retrying; cli-proxy logs show `diagnosis=unknown` (AWF < v0.27.12) or `diagnosis=reachable-but-api-error (HTTP NNN)` with a `*.ghe.com` hint (AWF ≥ v0.27.12); AWF fails to start | DIFC proxy is reachable but the forwarded `gh api rate_limit` call returns an HTTP error because the DIFC proxy is not enterprise-host-aware on data-residency `*.ghe.com` tenants | **Partially mitigated**: upgrade to AWF ≥ v0.27.12 for a targeted `*.ghe.com` hint and HTTP status in cli-proxy logs; root cause (DIFC proxy enterprise-host awareness) is **unresolved** in companion projects (github/gh-aw-mcpg#8202, github/gh-aw#41911) | Check `GITHUB_SERVER_URL` for `*.ghe.com`; inspect cli-proxy logs for `diagnosis=unknown` or `reachable-but-api-error (HTTP NNN)`; confirm AWF ≥ v0.27.12 for the targeted hint | #5615, #5616 |

## Category D — Alternative runtimes and adjacent gaps

| ID | Signal | Root cause | Status | Probe | Citations |
|---|---|---|---|---|---|
| D1 | AWF does not start or isolation is ineffective under gVisor / Kata | These runtimes do not support AWF's expected netns / capability model | Known unresolved research area | `docker info | grep -i runtime`; inspect NAT rules in `awf-iptables-init` | #3264 |
| D2 | cli-proxy fails on IPv6-enabled runners | The tunnel was bound only to `127.0.0.1` | Fixed by dual-stack binding | Check `ss -tlnp` inside `awf-cli-proxy` | #4626 |
| D3 | `--enable-dind` still exists after DinD removal | Legacy flag cleanup is incomplete | Known unresolved cleanup item | `awf --help | grep enable-dind` | #1727 |
| D4 | Enterprise LLM gateway needs an injected auth header | API proxy lacks a user extension point for that hop | Known unresolved proposal | No general probe; capture the required header flow in the report | #4849 |

## Error-string quick lookup

| Observable | Likely mode |
|---|---|
| `Docker socket not found at /var/run/docker.sock` with `Invalid container ID format` | A10 |
| `chroot: failed to run command 'capsh'` or `capsh not found` | A4 |
| `AWF chroot mode requires a glibc-based daemon host` | A4 |
| `one-shot-token.so ... __fprintf_chk: symbol not found` | A5 |
| `FATAL: http_port: IPv6 is not available` or `Bungled ... [::]:3128` | B3 |
| `node: command not found` on self-hosted or DinD | A8 or B4 |
| `none of the git remotes correspond to the GH_HOST environment variable` | C4 |
| `malformed version:` from `gh --repo` | C5 |
| `400 bad request: Authorization header is badly formatted` | C3 |
| `ENOENT ... /host/usr/local/bin/copilot` | A8 |
| `mkdirat ... : read-only file system` during chroot agent startup | A12 |
| `getaddrinfo EAI_AGAIN <topology-peer>` with `awf-cli-proxy could not connect to the external DIFC proxy` | B5 |
| `EACCES` in `upload-artifact` after `sudo: false` (`--network-isolation`) AWF run | B6 |
| `EACCES` / `unlink` on path containing `/tmp/awf-...-chroot-home/` during AWF cleanup (not in an `upload-artifact` step) | B7 |
| `chroot: failed to run command '/bin/sh'` on glibc daemon (not musl — confirmed by `ldd --version`) | A13 |
| `getent passwd <UID>` fails or `HOME=/`, `USER=root` in chroot | A6 |
| Bind-mounted `/tmp/...` files are missing inside DinD containers | A1 |
| `diagnosis=unknown` from `awf-cli-proxy` DIFC probe (proxy reachable, no connection error) with `GITHUB_SERVER_URL=*.ghe.com`, or `diagnosis=reachable-but-api-error (HTTP NNN)` | C7 |

## Known unresolved items

Flag these explicitly instead of implying there is a complete fix:

- D1 / #3264 — gVisor and Kata compatibility research
- D3 / #1727 — lingering `--enable-dind` cleanup
- D4 / #4849 — enterprise header injection extension point
- C5 / #3937 — full `GH_HOST` leak fix still requires gh-aw changes
- C7 / #5615 — DIFC proxy enterprise-host awareness for `*.ghe.com` data-residency (root cause unresolved; tracked in github/gh-aw-mcpg#8202 and github/gh-aw#41911)
