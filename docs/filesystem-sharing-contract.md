# Filesystem Sharing Contract

This is the review contract for AWF host-to-component sharing. The tables below
describe **observed implementation**, not permission grants requested by this
document. Changes to the access policy require separate security review.
`src/config/sandbox-mount-policy.json` is the Compose/sbx home-path policy,
**not** the inventory of all components and **not** the Cloud Hypervisor or NVX
export policy.

## Interpretation and trust boundaries

Visibility means a source can be reached at *any* destination, including a
second bind, a symlink, an overlapping child, or a writable alias. Mount access
is the bind/export mode (`ro`, `rw`), tmpfs, named volume, or overlay, not the
process's effective permission. A writable bind does not override host DAC,
ACLs, parent traversal, or a read-only underlying filesystem. Conversely, a
read-only bind does not globally protect a host source also exposed through a
writable alias. Process authority is the *final* workload UID/GID, supplementary
groups and capabilities, not the setup process's credentials. Host permission
is source ownership/mode plus any setup or entrypoint mutation; neither Compose
nor virtio-fs export metadata specifies it. Socket access may confer authority
beyond reading ordinary files.

In the generated inventory, `<FIXTURE>` is a temporary synthetic fixture root
(including its `workspace`, `tools`, and `work` children), `<HOME>` is the
invoking user's resolved home, and `<REPO>` is the checked-out source tree.
`chroot-<ID>/hosts` replaces only the random `mkdtemp` suffix of the generated
hosts-file directory; the source location and target remain visible.
No secrets, live home directories, or user-specific paths are embedded in the
document. `<WORKDIR>` below means the per-run work directory; `<UID>:<GID>`
means the invoking user's recovered IDs. A `:ro` parent with a narrower `:rw`
child grants writes through the child only. A target beginning `/host` becomes
the path without that prefix after the agent entrypoint chroots to `/host`.
Direct-path binds may also exist before chroot; treat each row separately.

### Identities (startup → final workload)

| Component / activation | Identity and authority | Source / limitation |
| --- | --- | --- |
| Compose agent (Docker, gVisor) | Image root sets up host-mapped UID/GID (`SUDO_UID`/`SUDO_GID` when available, otherwise process IDs with safe fallback); entrypoint chroots to `/host`, drops `SYS_CHROOT`/`SYS_ADMIN` and executes as that user. Supplementary groups depend on host passwd/group synthesis and privilege-drop chain; verify with `id` in the workload. Rootless Docker/user namespaces can remap container IDs; do not equate them to host IDs without inspection. | `src/host-env.ts`, `src/services/agent-service.ts`, `containers/agent/entrypoint.sh` |
| Squid (all backends using Compose infrastructure) | Image `proxy` user (UID/GID 13 in host setup); entrypoint may preflight/chown logs; not the invoking user. Container ID-to-host mapping is runtime-dependent. | `containers/squid/Dockerfile`, `src/services/squid-service.ts`, `src/log-directory-setup.ts` |
| iptables-init (Compose when iptables enabled) | Root init container with `NET_ADMIN`/`NET_RAW`, `cap_drop: ALL`; no agent workload. Shares network namespace but not mount namespace with agent. | `src/services/agent-service.ts` |
| API / CLI / DoH proxies (feature-dependent) | API image `apiproxy`, CLI image `cliproxy`, DoH image-defined user; startup and post-entrypoint IDs must be checked in the running image, not inferred from mounts. API/CLI logs use host directories accessible to their service users. | `containers/api-proxy/Dockerfile`, `src/services/{api-proxy,cli-proxy,doh-proxy}-service.ts` |
| enclave MCP broker / image preparation (enclaves enabled) | Broker starts with narrowly granted `CHOWN`, `DAC_OVERRIDE`, `FOWNER` for setup; executor identity and private path ownership are independently enforced. Image-only services do not run agent commands. | `src/services/enclave-mcp-service.ts`, `src/enclave/manager.ts` |
| script / agent enclave (enabled per executor) | Separate ephemeral executor, not the primary agent's identity or mount namespace. Docker and Cloud Hypervisor executor paths differ; final image-defined user, groups and mount enforcement require role-specific live checks. | `src/enclave/`, `src/cloud-hypervisor/enclave-export-plan.ts` |
| sysroot-stage (ARC/DinD), model router (experimental routing) | Sysroot setup process populates a named volume; router's workload user follows its image/entrypoint. No primary-agent identity should be inferred from either. | `src/services/{sysroot,router}-service.ts` |
| sbx primary agent | `sbx create shell` launches a daemon-managed guest; guest image/daemon determine IDs, not Compose's omitted agent object. Final IDs/groups must be observed with `sbx exec ... id`; host ID mapping unverified. | `src/sbx-manager.ts` |
| Cloud Hypervisor primary agent / enclaves | Host VMM/virtiofsd launch under per-run non-root accounts with device ACLs and launcher confinement; guest supervisor refuses UID 0 commands; virtiofsd squashes guest IDs to the workspace owner (floor 1000). Guest IDs differ from host VMM IDs. | `src/cloud-hypervisor/{vmm-identity,launcher}.ts`, `scripts/ci/cloud-hypervisor-live-smoke.sh` |
| NVX primary agent | Host VMM uses a per-run non-root account and `/dev/kvm` ACL; guest home is scratch and guest tool seed is immutable. Guest/host identity mapping needs runtime inspection. | `src/nvx/{runtime-lifecycle,workspace-export}.ts` |

### Source ownership and lifecycle (not derivable from mount plans)

| Source | Creation / final ownership and modes | Cleanup |
| --- | --- | --- |
| Existing workspace, system dirs, custom binds, `/dev`, `/sys`, sockets | Existing ownership/modes/ACLs preserved unless an explicitly documented setup or entrypoint operation changes them. `mkdir` mode is limited by umask; existing paths are not retroactively given a requested creation mode. Docker daemon may create missing bind sources in its *own* filesystem view on ARC/DinD. | Host-owned; not removed by AWF |
| `<WORKDIR>-chroot-home` and whitelisted `<HOME>` tool directories | Empty home is chowned `<UID>:<GID>`; newly created missing tool path segments get invoking-user ownership, existing paths normally retain mode/owner (Gemini source ownership is repaired). Placeholder children are chowned and chmodded `0755`; optional Gemini settings file is `0644`. | Per-run empty home removed; real tool paths preserved (`src/chroot-home-setup.ts`) |
| Agent logs / session state, init signal | Logs/session directories are best-effort chowned `<UID>:<GID>`; init signal is ensured, with existing mode preserved. | Workdir artifacts removed or preserved depending on flags and artifact handling (`src/workdir-setup.ts`, `src/log-directory-setup.ts`) |
| Squid logs | Created `0755`, best-effort chown `13:13`; failed chown falls back to `0777`, container preflight retries. Stop-time ownership/readability adjustment may change existing children. | Logs may be preserved (`src/log-directory-setup.ts`, `src/container-stop.ts`) |
| API/CLI log parents; `/tmp/gh-aw/mcp-logs` | New API/CLI parents explicitly chmod `0777`; existing ones retain modes. MCP log parent chmod `0777` even if pre-existing (best effort for EPERM/EROFS). **Do not infer child file modes**: payload-bearing API audit records are created `0600`. | MCP stale subdirectories pruned; log artifacts conditional (`src/log-directory-setup.ts`, `containers/api-proxy/token-persistence.js`) |
| Enclave private roots / control capability | AWF-owned per-run protected paths and channel, never a generic agent scratch share. Ownership and mode enforced during staging, not by Compose. | Reconciled on reuse; see `src/enclave/{paths,manager}.ts` |

## Implementation-derived relationships

The following rows are extracted from the *final* Compose service list (after
optional assembly, filtering, and prefix processing), and from actual primary
Cloud Hypervisor / NVX export resolvers. One row represents one
component/source/destination, including duplicate-source aliases. The scenario
is the activation condition; the identity is the corresponding row above.
Host ownership is **preserved** unless the source is named in the lifecycle
table. Mode is the mount boundary, not proof of effective write permission.
The generator intentionally does not infer final host modes or post-entrypoint
IDs from the plans.

<!-- sharing-plan:start -->
| Scenario | Source | Component / destination | Mount access | Mechanism |
| --- | --- | --- | --- | --- |
| compose/default | <FIXTURE>/work/squid-logs | squid-proxy → /var/log/squid | rw | Compose bind/volume |
| compose/default | /tmp | agent → /tmp | rw | Compose bind/volume |
| compose/default | <FIXTURE>/workspace | agent → <FIXTURE>/workspace | rw | Compose bind/volume |
| compose/default | <FIXTURE>/work/agent-logs | agent → <HOME>/.copilot/logs | rw | Compose bind/volume |
| compose/default | <FIXTURE>/work/agent-session-state | agent → <HOME>/.copilot/session-state | rw | Compose bind/volume |
| compose/default | <FIXTURE>/work/init-signal | agent → /run/awf-init | rw | Compose bind/volume |
| compose/default | <FIXTURE>/work/init-signal | agent → /tmp/awf-init | ro | Compose bind/volume |
| compose/default | /usr | agent → /host/usr | ro | Compose bind/volume |
| compose/default | /bin | agent → /host/bin | ro | Compose bind/volume |
| compose/default | /sbin | agent → /host/sbin | ro | Compose bind/volume |
| compose/default | /lib | agent → /host/lib | ro | Compose bind/volume |
| compose/default | /lib64 | agent → /host/lib64 | ro | Compose bind/volume |
| compose/default | /opt | agent → /host/opt | ro | Compose bind/volume |
| compose/default | /sys | agent → /host/sys | ro | Compose bind/volume |
| compose/default | /dev | agent → /host/dev | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host/dev/null | rw | Compose bind/volume |
| compose/default | <FIXTURE>/workspace | agent → /host<FIXTURE>/workspace | rw | Compose bind/volume |
| compose/default | /tmp | agent → /host/tmp | rw | Compose bind/volume |
| compose/default | <FIXTURE>/work-chroot-home | agent → /host<HOME> | rw | Compose bind/volume |
| compose/default | <FIXTURE>/work/agent-session-state | agent → /host<HOME>/.copilot/session-state | rw | Compose bind/volume |
| compose/default | <FIXTURE>/work/agent-logs | agent → /host<HOME>/.copilot/logs | rw | Compose bind/volume |
| compose/default | <HOME>/.cache | agent → /host<HOME>/.cache | rw | Compose bind/volume |
| compose/default | <HOME>/.config | agent → /host<HOME>/.config | rw | Compose bind/volume |
| compose/default | <HOME>/.local/bin | agent → /host<HOME>/.local/bin | rw | Compose bind/volume |
| compose/default | <HOME>/.local/lib | agent → /host<HOME>/.local/lib | rw | Compose bind/volume |
| compose/default | <HOME>/.local/lib64 | agent → /host<HOME>/.local/lib64 | rw | Compose bind/volume |
| compose/default | <HOME>/.local/share | agent → /host<HOME>/.local/share | rw | Compose bind/volume |
| compose/default | <HOME>/.local/pipx | agent → /host<HOME>/.local/pipx | rw | Compose bind/volume |
| compose/default | <HOME>/.azure | agent → /host<HOME>/.azure | rw | Compose bind/volume |
| compose/default | <HOME>/.anthropic | agent → /host<HOME>/.anthropic | rw | Compose bind/volume |
| compose/default | <HOME>/.claude | agent → /host<HOME>/.claude | rw | Compose bind/volume |
| compose/default | <HOME>/.cargo | agent → /host<HOME>/.cargo | rw | Compose bind/volume |
| compose/default | <HOME>/.rustup | agent → /host<HOME>/.rustup | rw | Compose bind/volume |
| compose/default | <HOME>/.npm | agent → /host<HOME>/.npm | rw | Compose bind/volume |
| compose/default | <HOME>/.nvm | agent → /host<HOME>/.nvm | rw | Compose bind/volume |
| compose/default | /opt/hostedtoolcache | agent → /host/opt/hostedtoolcache | ro | Compose bind/volume |
| compose/default | /etc/ssl | agent → /host/etc/ssl | ro | Compose bind/volume |
| compose/default | /etc/ca-certificates | agent → /host/etc/ca-certificates | ro | Compose bind/volume |
| compose/default | /etc/alternatives | agent → /host/etc/alternatives | ro | Compose bind/volume |
| compose/default | /etc/ld.so.cache | agent → /host/etc/ld.so.cache | ro | Compose bind/volume |
| compose/default | /etc/nsswitch.conf | agent → /host/etc/nsswitch.conf | ro | Compose bind/volume |
| compose/default | /etc/passwd | agent → /host/etc/passwd | ro | Compose bind/volume |
| compose/default | /etc/group | agent → /host/etc/group | ro | Compose bind/volume |
| compose/default | <FIXTURE>/work/chroot-<ID>/hosts | agent → /host/etc/hosts | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host/var/run/docker.sock | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host/run/docker.sock | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.docker/config.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.npmrc | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.composer/auth.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.ssh/id_rsa | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.ssh/id_ed25519 | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.ssh/id_ecdsa | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.ssh/id_dsa | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.aws/credentials | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.aws/config | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.kube/config | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.azure/credentials | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.azure/msal_token_cache.bin | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.azure/msal_token_cache.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.azure/accessTokens.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.azure/service_principal_entries.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.cargo/credentials | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.cargo/credentials.toml | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.claude/.credentials.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.gemini/oauth_creds.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.gemini/google_accounts.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.gemini/access_tokens.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.config/gh/hosts.yml | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.config/gcloud/credentials.db | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.config/gcloud/access_tokens.db | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.config/gcloud/application_default_credentials.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.config/doctl/config.yaml | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.config/rclone/rclone.conf | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.config/containers/auth.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.config/pulumi/credentials.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → <HOME>/.config/helm/repositories.yaml | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.docker/config.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.npmrc | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.composer/auth.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.ssh/id_rsa | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.ssh/id_ed25519 | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.ssh/id_ecdsa | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.ssh/id_dsa | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.aws/credentials | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.aws/config | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.kube/config | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.azure/credentials | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.azure/msal_token_cache.bin | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.azure/msal_token_cache.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.azure/accessTokens.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.azure/service_principal_entries.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.cargo/credentials | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.cargo/credentials.toml | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.claude/.credentials.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.gemini/oauth_creds.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.gemini/google_accounts.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.gemini/access_tokens.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.config/gh/hosts.yml | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.config/gcloud/credentials.db | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.config/gcloud/access_tokens.db | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.config/gcloud/application_default_credentials.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.config/doctl/config.yaml | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.config/rclone/rclone.conf | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.config/containers/auth.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.config/pulumi/credentials.json | ro | Compose bind/volume |
| compose/default | /dev/null | agent → /host<HOME>/.config/helm/repositories.yaml | ro | Compose bind/volume |
| compose/default | ephemeral tmpfs | agent → /tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host/tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → <FIXTURE>/work:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host<FIXTURE>/work:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/audit:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/audit:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host/dev/shm:rw,noexec,nosuid,nodev,size=65536k | rw (tmpfs) | Compose tmpfs |
| compose/default | <FIXTURE>/work/init-signal | iptables-init → /run/awf-init | rw | Compose bind/volume |
| compose/default | <FIXTURE>/work/init-signal | iptables-init → /tmp/awf-init | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/squid-logs | squid-proxy → /var/log/squid | rw | Compose bind/volume |
| compose/api-proxy | /tmp | agent → /tmp | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/workspace | agent → <FIXTURE>/workspace | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/agent-logs | agent → <HOME>/.copilot/logs | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/agent-session-state | agent → <HOME>/.copilot/session-state | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/init-signal | agent → /run/awf-init | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/init-signal | agent → /tmp/awf-init | ro | Compose bind/volume |
| compose/api-proxy | <REPO>/containers/agent/api-proxy-health-check.sh | agent → /usr/local/bin/api-proxy-health-check.sh | ro | Compose bind/volume |
| compose/api-proxy | /usr | agent → /host/usr | ro | Compose bind/volume |
| compose/api-proxy | /bin | agent → /host/bin | ro | Compose bind/volume |
| compose/api-proxy | /sbin | agent → /host/sbin | ro | Compose bind/volume |
| compose/api-proxy | /lib | agent → /host/lib | ro | Compose bind/volume |
| compose/api-proxy | /lib64 | agent → /host/lib64 | ro | Compose bind/volume |
| compose/api-proxy | /opt | agent → /host/opt | ro | Compose bind/volume |
| compose/api-proxy | /sys | agent → /host/sys | ro | Compose bind/volume |
| compose/api-proxy | /dev | agent → /host/dev | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host/dev/null | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/workspace | agent → /host<FIXTURE>/workspace | rw | Compose bind/volume |
| compose/api-proxy | /tmp | agent → /host/tmp | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work-chroot-home | agent → /host<HOME> | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/agent-session-state | agent → /host<HOME>/.copilot/session-state | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/agent-logs | agent → /host<HOME>/.copilot/logs | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.cache | agent → /host<HOME>/.cache | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.config | agent → /host<HOME>/.config | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.local/bin | agent → /host<HOME>/.local/bin | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.local/lib | agent → /host<HOME>/.local/lib | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.local/lib64 | agent → /host<HOME>/.local/lib64 | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.local/share | agent → /host<HOME>/.local/share | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.local/pipx | agent → /host<HOME>/.local/pipx | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.azure | agent → /host<HOME>/.azure | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.anthropic | agent → /host<HOME>/.anthropic | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.claude | agent → /host<HOME>/.claude | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.cargo | agent → /host<HOME>/.cargo | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.rustup | agent → /host<HOME>/.rustup | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.npm | agent → /host<HOME>/.npm | rw | Compose bind/volume |
| compose/api-proxy | <HOME>/.nvm | agent → /host<HOME>/.nvm | rw | Compose bind/volume |
| compose/api-proxy | /opt/hostedtoolcache | agent → /host/opt/hostedtoolcache | ro | Compose bind/volume |
| compose/api-proxy | /etc/ssl | agent → /host/etc/ssl | ro | Compose bind/volume |
| compose/api-proxy | /etc/ca-certificates | agent → /host/etc/ca-certificates | ro | Compose bind/volume |
| compose/api-proxy | /etc/alternatives | agent → /host/etc/alternatives | ro | Compose bind/volume |
| compose/api-proxy | /etc/ld.so.cache | agent → /host/etc/ld.so.cache | ro | Compose bind/volume |
| compose/api-proxy | /etc/nsswitch.conf | agent → /host/etc/nsswitch.conf | ro | Compose bind/volume |
| compose/api-proxy | /etc/passwd | agent → /host/etc/passwd | ro | Compose bind/volume |
| compose/api-proxy | /etc/group | agent → /host/etc/group | ro | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/chroot-<ID>/hosts | agent → /host/etc/hosts | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host/var/run/docker.sock | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host/run/docker.sock | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.docker/config.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.npmrc | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.composer/auth.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.ssh/id_rsa | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.ssh/id_ed25519 | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.ssh/id_ecdsa | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.ssh/id_dsa | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.aws/credentials | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.aws/config | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.kube/config | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.azure/credentials | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.azure/msal_token_cache.bin | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.azure/msal_token_cache.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.azure/accessTokens.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.azure/service_principal_entries.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.cargo/credentials | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.cargo/credentials.toml | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.claude/.credentials.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.gemini/oauth_creds.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.gemini/google_accounts.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.gemini/access_tokens.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.config/gh/hosts.yml | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.config/gcloud/credentials.db | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.config/gcloud/access_tokens.db | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.config/gcloud/application_default_credentials.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.config/doctl/config.yaml | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.config/rclone/rclone.conf | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.config/containers/auth.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.config/pulumi/credentials.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → <HOME>/.config/helm/repositories.yaml | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.docker/config.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.npmrc | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.composer/auth.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.ssh/id_rsa | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.ssh/id_ed25519 | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.ssh/id_ecdsa | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.ssh/id_dsa | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.aws/credentials | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.aws/config | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.kube/config | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.azure/credentials | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.azure/msal_token_cache.bin | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.azure/msal_token_cache.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.azure/accessTokens.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.azure/service_principal_entries.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.cargo/credentials | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.cargo/credentials.toml | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.claude/.credentials.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.gemini/oauth_creds.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.gemini/google_accounts.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.gemini/access_tokens.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.config/gh/hosts.yml | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.config/gcloud/credentials.db | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.config/gcloud/access_tokens.db | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.config/gcloud/application_default_credentials.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.config/doctl/config.yaml | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.config/rclone/rclone.conf | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.config/containers/auth.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.config/pulumi/credentials.json | ro | Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host<HOME>/.config/helm/repositories.yaml | ro | Compose bind/volume |
| compose/api-proxy | ephemeral tmpfs | agent → /tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host/tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → <FIXTURE>/work:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host<FIXTURE>/work:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/audit:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/audit:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host/dev/shm:rw,noexec,nosuid,nodev,size=65536k | rw (tmpfs) | Compose tmpfs |
| compose/api-proxy | <FIXTURE>/work/init-signal | iptables-init → /run/awf-init | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/init-signal | iptables-init → /tmp/awf-init | rw | Compose bind/volume |
| compose/api-proxy | <FIXTURE>/work/api-proxy-logs | api-proxy → /var/log/api-proxy | rw | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work/squid-logs | squid-proxy → /var/log/squid | rw | Compose bind/volume |
| compose/allowWrite-empty | /tmp | agent → /tmp | ro | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/workspace | agent → <FIXTURE>/workspace | ro | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work/agent-logs | agent → <HOME>/.copilot/logs | rw | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work/agent-session-state | agent → <HOME>/.copilot/session-state | rw | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work/init-signal | agent → /run/awf-init | rw | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work/init-signal | agent → /tmp/awf-init | ro | Compose bind/volume |
| compose/allowWrite-empty | /usr | agent → /host/usr | ro | Compose bind/volume |
| compose/allowWrite-empty | /bin | agent → /host/bin | ro | Compose bind/volume |
| compose/allowWrite-empty | /sbin | agent → /host/sbin | ro | Compose bind/volume |
| compose/allowWrite-empty | /lib | agent → /host/lib | ro | Compose bind/volume |
| compose/allowWrite-empty | /lib64 | agent → /host/lib64 | ro | Compose bind/volume |
| compose/allowWrite-empty | /opt | agent → /host/opt | ro | Compose bind/volume |
| compose/allowWrite-empty | /sys | agent → /host/sys | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev | agent → /host/dev | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host/dev/null | rw | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/workspace | agent → /host<FIXTURE>/workspace | ro | Compose bind/volume |
| compose/allowWrite-empty | /tmp | agent → /host/tmp | ro | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work-chroot-home | agent → /host<HOME> | ro | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work/agent-session-state | agent → /host<HOME>/.copilot/session-state | rw | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work/agent-logs | agent → /host<HOME>/.copilot/logs | rw | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.cache | agent → /host<HOME>/.cache | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.config | agent → /host<HOME>/.config | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.local/bin | agent → /host<HOME>/.local/bin | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.local/lib | agent → /host<HOME>/.local/lib | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.local/lib64 | agent → /host<HOME>/.local/lib64 | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.local/share | agent → /host<HOME>/.local/share | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.local/pipx | agent → /host<HOME>/.local/pipx | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.azure | agent → /host<HOME>/.azure | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.anthropic | agent → /host<HOME>/.anthropic | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.claude | agent → /host<HOME>/.claude | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.cargo | agent → /host<HOME>/.cargo | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.rustup | agent → /host<HOME>/.rustup | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.npm | agent → /host<HOME>/.npm | ro | Compose bind/volume |
| compose/allowWrite-empty | <HOME>/.nvm | agent → /host<HOME>/.nvm | ro | Compose bind/volume |
| compose/allowWrite-empty | /opt/hostedtoolcache | agent → /host/opt/hostedtoolcache | ro | Compose bind/volume |
| compose/allowWrite-empty | /etc/ssl | agent → /host/etc/ssl | ro | Compose bind/volume |
| compose/allowWrite-empty | /etc/ca-certificates | agent → /host/etc/ca-certificates | ro | Compose bind/volume |
| compose/allowWrite-empty | /etc/alternatives | agent → /host/etc/alternatives | ro | Compose bind/volume |
| compose/allowWrite-empty | /etc/ld.so.cache | agent → /host/etc/ld.so.cache | ro | Compose bind/volume |
| compose/allowWrite-empty | /etc/nsswitch.conf | agent → /host/etc/nsswitch.conf | ro | Compose bind/volume |
| compose/allowWrite-empty | /etc/passwd | agent → /host/etc/passwd | ro | Compose bind/volume |
| compose/allowWrite-empty | /etc/group | agent → /host/etc/group | ro | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work/chroot-<ID>/hosts | agent → /host/etc/hosts | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host/var/run/docker.sock | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host/run/docker.sock | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.docker/config.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.npmrc | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.composer/auth.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.ssh/id_rsa | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.ssh/id_ed25519 | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.ssh/id_ecdsa | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.ssh/id_dsa | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.aws/credentials | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.aws/config | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.kube/config | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.azure/credentials | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.azure/msal_token_cache.bin | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.azure/msal_token_cache.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.azure/accessTokens.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.azure/service_principal_entries.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.cargo/credentials | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.cargo/credentials.toml | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.claude/.credentials.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.gemini/oauth_creds.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.gemini/google_accounts.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.gemini/access_tokens.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.config/gh/hosts.yml | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.config/gcloud/credentials.db | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.config/gcloud/access_tokens.db | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.config/gcloud/application_default_credentials.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.config/doctl/config.yaml | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.config/rclone/rclone.conf | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.config/containers/auth.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.config/pulumi/credentials.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → <HOME>/.config/helm/repositories.yaml | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.azure/credentials | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.azure/msal_token_cache.bin | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.azure/msal_token_cache.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.azure/accessTokens.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.azure/service_principal_entries.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.cargo/credentials | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.cargo/credentials.toml | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.claude/.credentials.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.config/gh/hosts.yml | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.config/gcloud/credentials.db | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.config/gcloud/access_tokens.db | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.config/gcloud/application_default_credentials.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.config/doctl/config.yaml | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.config/rclone/rclone.conf | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.config/containers/auth.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.config/pulumi/credentials.json | ro | Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host<HOME>/.config/helm/repositories.yaml | ro | Compose bind/volume |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host/tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → <FIXTURE>/work:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host<FIXTURE>/work:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/logs:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/audit:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/audit:rw,noexec,nosuid,size=1m | rw (tmpfs) | Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host/dev/shm:rw,noexec,nosuid,nodev,size=65536k | rw (tmpfs) | Compose tmpfs |
| compose/allowWrite-empty | <FIXTURE>/work/init-signal | iptables-init → /run/awf-init | rw | Compose bind/volume |
| compose/allowWrite-empty | <FIXTURE>/work/init-signal | iptables-init → /tmp/awf-init | rw | Compose bind/volume |
| cloud-hypervisor/workspace-only | <FIXTURE>/workspace | primary agent → /workspace | rw | virtio-fs export (write narrowing separate) |
| cloud-hypervisor/workspace-and-tool-cache | <FIXTURE>/workspace | primary agent → /workspace | rw | virtio-fs export (write narrowing separate) |
| cloud-hypervisor/workspace-and-tool-cache | <FIXTURE>/tools | primary agent → <FIXTURE>/tools | ro | virtio-fs export (write narrowing separate) |
| nvx/workspace-only | <FIXTURE>/workspace | primary agent → /workspace | rw | virtio-fs export (write narrowing separate) |
| nvx/workspace-and-tool-cache | <FIXTURE>/workspace | primary agent → /workspace | rw | virtio-fs export (write narrowing separate) |
| nvx/workspace-and-tool-cache | <FIXTURE>/tools | primary agent → <FIXTURE>/tools | ro | virtio-fs export (write narrowing separate) |
<!-- sharing-plan:end -->

### Other conditional relationships and gaps

| Runtime / activation | Source → consumer / destination | Ownership / access / lifecycle / source |
| --- | --- | --- |
| sbx (`--container-runtime sbx`) | workspace, explicit extra directories, `/tmp`, `/usr/local/bin`, and existing whitelisted home tool paths → primary agent at identical absolute paths | `sbx create shell` positional arguments; workspace and omitted-mode paths writable at share boundary, `:ro` optional for extras. Existing DAC preserved. Known credentials under shared tool directories are moved aside before creation and restored **after** sandbox removal; failure/interruption can leave backups requiring recovery (`src/sbx-manager.ts`). Compose's agent volumes are unused. Exact runtime mount enforcement and IDs unverified here. |
| ARC/DinD (`runnerTopology=arc-dind`) | daemon-visible prefixed sources → sysroot stage `sysroot` named volume and filtered agent `/host` subtree | Sources outside shared filesystem can be dropped; sysroot replaces `/host/usr`, `/host/bin`, `/host/sbin`, `/host/lib*`, `/host/opt` and home tool mounts. Prefix applies to daemon bind sources but not kernel VFS or `/dev/null`; see `src/services/optional-services.ts`, `src/services/host-path-prefix.ts`. Check runner *and* daemon paths. |
| Cloud Hypervisor `filesystem.allowWrite` | declared exports → guest paths in table | `src/cloud-hypervisor/filesystem-write-enforcement.ts` builds host mount trees: staged read-only parents with writable allowed submounts, possibly publishing a workspace export `ro` for deny-all. Export mode by itself does not prove host enforcement. |
| Cloud Hypervisor script/agent enclave | per-invocation seed and request → `/input-seed`, `/input-request` (`ro`); output/runtime → `/output`, `/runtime` (`rw`); agent adds handoff `ro` and session state `rw` | Closed role-specific plan in `src/cloud-hypervisor/enclave-export-plan.ts`; sources owned by enclave host staging; excluded from primary exports. Live per-role permission proof remains a coverage gap. |
| NVX (`workspace-and-tool-cache`) | tool cache → same guest path `ro`; workspace → `/workspace` `rw`; guest seed `/home/awf` → scratch home `/tmp/awf-home` | Realpath-canonical export sources; source permissions preserved. `filesystem.allowWrite` support is backend-specific: consult `src/filesystem-policy.ts` before enabling. |

Negative guarantees to review independently: no blanket host `$HOME`, `/etc`,
`/`, or enclave-private root in the primary agent; no direct credentials from
unmounted paths; both direct and `/host` credential-mask targets where relevant;
no broad custom mount or symlink alias exposing a private root; no upgrade of a
pre-existing read-only source through `filesystem.allowWrite`. With `--enable-dind`,
the Docker socket is intentionally available and confers Docker-daemon authority:
this is **not** an ordinary read-only file. Optional CA files and generated
hosts, proxy, router and enclave control inputs require their own scenario
review. Missing tool paths and Gemini gating change what is mounted.

## Verification and change procedure

| Scenario | Deterministic plan | Independent assertions | Workload-identity live evidence |
| --- | --- | --- | --- |
| Docker / gVisor default, API proxy, empty allowWrite | generated Compose rows | `scripts/ci/filesystem-sharing-contract.test.ts` | Docker: run wrapped command and inspect `id`, mounts and allowed/denied operations; gVisor **unverified** |
| ARC/DinD sysroot + prefix, custom binds / credential aliases | existing sysroot, topology and credential tests | existing focused security tests; **not in generated fixture** | split-filesystem live evidence **unverified** |
| sbx default and home credential move-aside | sbx manager tests; **not in generated section** | sbx mount policy and restoration tests | daemon-backed sbx **unverified** |
| Cloud Hypervisor default and cache | generated primary export rows | export and write-enforcement tests | `scripts/ci/cloud-hypervisor-live-smoke.sh`: final guest workload checks reads, writes, denied writes, owner and modes |
| Cloud Hypervisor enclave script/agent | role-specific export planner tests; **not in generated section** | enclave export-plan validator | enclave live smoke, role-specific DAC **unverified** |
| NVX default and cache | generated primary export rows | NVX export and live-policy tests | phase-4 runtime checks; final guest identity/DAC **unverified** |

Run `npm run sharing:write` after changing mount/export builders, then
`npm run sharing:check` (also exercised by the root Jest suite in CI).
Inspect the diff: a generated-table update alone never approves an access
change. Update independent assertions, identity and host setup descriptions,
and the scenario coverage table together. For a live check, run as the **final
wrapped workload**, not `docker exec` as root: record `id`, `stat`, and
`findmnt`/`/proc/mounts` as evidence, then attempt non-destructive allowed
create/delete and denied operations against disposable fixtures in both
directions of shared channels. Inspect parent traversal, nested mounts, both
credential destinations, symlink/duplicate-source aliases, hard links, and
cleanup after interrupted runs. Unit snapshots prove configuration, **not**
mount enforcement, host ACLs, confinement, or effective guest permissions.

See [mount policy](mount-policy.md), [config §4.1](awf-config-spec.md),
[environment](environment.md), [enclave architecture](enclaves-architecture.md),
[sbx](sbx-integration.md), and
[Cloud Hypervisor](cloud-hypervisor-foundation.md) for backend details.
