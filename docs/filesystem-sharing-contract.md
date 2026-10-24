# Filesystem Sharing Contract

This is the review contract for AWF host-to-component sharing. The tables below
describe **observed implementation**, not permission grants requested by this
document. Changes to the access policy require separate security review.
`src/config/sandbox-mount-policy.json` is the Compose/sbx home-path policy,
**not** the inventory of all components and **not** the Cloud Hypervisor or NVX
export policy.

The [cross-backend workload contract](enclaves-architecture.md#cross-backend-workload-contract)
adds role/combinations, capability admission, resource-limit semantics and
deterministic versus real-backend verification obligations. Filesystem sharing
parity alone neither enables a backend nor equates its isolation boundary.

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
`awf-enclave-private-<ID>` and `awf-enclave-control-<ID>` replace the run-derived
identifiers used for the enclave-enabled Compose scenario.
The optional Cloud Hypervisor `/tmp/gh-aw` source is resolved from a synthetic
directory for the fixture and displayed at its production path; production
exports it only when that directory exists.
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
| Squid (all backends using Compose infrastructure) | Image declares `proxy` (UID/GID 13), but Compose overrides startup to root for log preflight/chown, then `su` drops to `proxy` (13:13) before Squid; not the invoking user. Container ID-to-host mapping is runtime-dependent. | `containers/squid/Dockerfile`, `src/services/squid-service.ts`, `src/log-directory-setup.ts` |
| iptables-init (Compose when iptables enabled) | Root init container with `NET_ADMIN`/`NET_RAW`, `cap_drop: ALL`; no agent workload. Shares network namespace but not mount namespace with agent. | `src/services/agent-service.ts` |
| API proxy (Compose, enabled) | Compose explicitly overrides the image's `apiproxy` identity with `${getSafeHostUid()}:${getSafeHostGid()}`. UID selection still rejects IDs below 1000, recovers `SUDO_UID` for root callers, and falls back to 1000. Callers with UID >= 1000 keep their nonzero primary GID, including GIDs below 1000; other callers retain the system-range GID fallback to 1000. Root/unavailable GIDs still use `SUDO_GID` when valid and >= 1000, otherwise 1000. The agent's `AWF_USER_GID` uses the same helper. API proxy starts Node directly under this identity. Log ownership/readability therefore follows the safe host IDs (subject to rootless/user-namespace mapping), not the image user. | `src/services/api-proxy-service-config.ts`, `src/host-identity.ts`, `containers/api-proxy/Dockerfile` |
| CLI / DoH proxies (feature-dependent) | Image/build identity and any entrypoint behavior remain service-specific; do not infer their effective IDs from the API proxy override. CLI logs use the configured service identity; verify the built image at runtime. | `containers/cli-proxy/`, `containers/doh-proxy/`, `src/services/{cli-proxy,doh-proxy}-service.ts` |
| enclave MCP broker / image preparation (enclaves enabled) | Broker starts with narrowly granted `CHOWN`, `DAC_OVERRIDE`, `FOWNER` for setup; executor identity and private path ownership are independently enforced. Image-only services do not run agent commands. | `src/services/enclave-mcp-service.ts`, `src/enclave/manager.ts` |
| Docker script / agent enclave | Trusted audited runner configuration defaults to `65534:65534`; the host adapter preserves its explicit non-root numeric UID/GID in `--user`, tmpfs ownership, and host output/session ownership, including trusted custom IDs. Missing, root, or invalid IDs are rejected. Image-declared identity is not authoritative. The broker holds metadata and an authenticated host-executor channel, not the Docker socket, seed tree, or invocation workspace. Workloads use read-only rootfs, drop all capabilities, enable no-new-privileges, and use host-staged seccomp. Generated mounts do not prove host DAC or effective workload access. | `src/enclave/docker-host-executor.ts`, `src/services/enclave-mcp-service.ts`, `containers/enclave/{script-executor,agent-executor}/*runner-spec.js` |
| gVisor script / agent enclave | Legacy broker-selected `65534:65534` (`queryUid/queryGid` for scripts; fixed agent broker config for agents), passed explicitly with `--user`; image-declared identity is not authoritative. Both use read-only rootfs, drop all capabilities, enable no-new-privileges, and use role-specific seccomp. The gVisor broker retains its Docker socket and seed/work mounts. | `containers/enclave/mcp-server/config.js`, `containers/enclave/{script-executor,agent-executor}/*runner-spec.js` |
| sbx script / agent enclave specifications | Both runner specs explicitly select their configured `queryUid:queryGid` or `enclaveUid:enclaveGid` via `--user`/`exec --user`. The script executor runs; the agent executor remains unavailable until the required sbx isolation controls pass its capability probe. Do not infer runtime enforcement from the launch spec. | `containers/enclave/{script-executor,agent-executor}/sbx-*-runner-spec.js`, `containers/enclave/agent-executor/sbx-capability-probe.js` |
| Cloud Hypervisor script / agent enclave | Separate host-executor roles and guest processes; they do not inherit the Docker/gVisor `65534:65534` runner configuration. Host executor identity is launch-confined; exact guest role IDs and denied host-path behavior remain live-verification gaps. | `src/cloud-hypervisor/{enclave-export-plan,host-enclave-executor}.ts`, `scripts/ci/cloud-hypervisor-enclave-live-smoke.js` |
| sysroot-stage (ARC/DinD), model router (experimental routing) | Sysroot setup process runs with its selected build-tools image identity to populate a named volume; router image declares UID:GID `10001:10001`. No primary-agent identity should be inferred from either. | `src/services/{sysroot,router}-service.ts`, `containers/router/Dockerfile` |
| sbx primary agent | `sbx create shell` launches a daemon-managed guest; guest image/daemon determine IDs, not Compose's omitted agent object. Final IDs/groups must be observed with `sbx exec ... id`; host ID mapping unverified. | `src/sbx-manager.ts` |
| Cloud Hypervisor primary agent | Host VMM/virtiofsd launch under per-run non-root accounts with device ACLs and launcher confinement; guest supervisor refuses UID 0 commands; virtiofsd squashes guest IDs to the workspace owner (floor 1000). The live smoke checks workload UID/GID and denied host paths; guest IDs differ from host VMM IDs. | `src/cloud-hypervisor/{vmm-identity,launcher}.ts`, `scripts/ci/cloud-hypervisor-live-smoke.sh` |
| NVX primary agent | Host VMM uses a per-run non-root account and `/dev/kvm` ACL; guest home is scratch and guest tool seed is immutable. Guest/host identity mapping needs runtime inspection. | `src/nvx/{runtime-lifecycle,workspace-export}.ts` |

### Source ownership and lifecycle (not derivable from mount plans)

| Source | Creation / final ownership and modes | Cleanup |
| --- | --- | --- |
| Existing workspace, system dirs, custom binds, `/dev`, `/sys`, sockets | Existing ownership/modes/ACLs preserved unless an explicitly documented setup or entrypoint operation changes them. `mkdir` mode is limited by umask; existing paths are not retroactively given a requested creation mode. Docker daemon may create missing bind sources in its *own* filesystem view on ARC/DinD. | Host-owned; not removed by AWF |
| `<WORKDIR>-chroot-home` and whitelisted `<HOME>` tool directories | Empty home is chowned `<UID>:<GID>`; newly created missing tool path segments get invoking-user ownership, existing paths normally retain mode/owner (Gemini source ownership is repaired). Placeholder children are chowned and chmodded `0755`; optional Gemini settings file is `0644`. | Per-run empty home removed; real tool paths preserved (`src/chroot-home-setup.ts`) |
| Copilot nested mount targets (`<HOME>/.copilot/session-state`, `<HOME>/.copilot/logs`) | AWF creates missing path segments before Docker startup with safe runner UID:GID and mode `0755`. Existing directories keep their ownership, mode, and contents; non-directory targets are rejected. | Host home paths are preserved (`src/chroot-home-setup.ts`) |
| Agent logs / session state, init signal | Logs/session directories are best-effort chowned `<UID>:<GID>`; init signal is ensured, with existing mode preserved. | Workdir artifacts removed or preserved depending on flags and artifact handling (`src/workdir-setup.ts`, `src/log-directory-setup.ts`) |
| `/tmp/gh-aw` and safe-output parent (Compose agent) | Before privilege drop, entrypoint best-effort recursively chowns `/host/tmp/gh-aw` and the configured safe-output parent to `<UID>:<GID>`; existing descendants may be changed, and changes are not restored. On normal completion or handled `TERM`/`INT`, it best-effort applies `chmod g+rwx` to the gh-aw handoff root and its `memory-validation` child when present; those changes are also not restored. | Host paths persist; changes affect only writable binds and are not rolled back (`containers/agent/entrypoint.sh`) |
| Squid logs | Created `0755`, best-effort chown `13:13`; failed chown falls back to `0777`, container preflight retries. Stop-time ownership/readability adjustment may change existing children. | Logs may be preserved (`src/log-directory-setup.ts`, `src/container-stop.ts`) |
| API/CLI log parents; `/tmp/gh-aw/mcp-logs` | New API/CLI parents explicitly chmod `0777`; existing ones retain modes. MCP log parent chmod `0777` even if pre-existing (best effort for EPERM/EROFS). **Do not infer child file modes**: payload-bearing API audit records are created `0600`. | MCP stale subdirectories pruned; log artifacts conditional (`src/log-directory-setup.ts`, `containers/api-proxy/token-persistence.js`) |
| Router logs (`router-logs/`, model routing only) | Not mounted into any container. AWF creates the directory at teardown, after finding this run's router, and copies the router's Docker log stream into a fresh `router.jsonl` inode, so existing readers retain only stale records. Directory `0700` and file `0600`, both chowned to the invoking (`sudo`) user; created and opened through `/proc/self/fd` from the parent directory, so no path component is followed through a symlink, and a hard-linked file is refused. At most 16 MiB. Not copied into `diagnostics/`, which is made world-readable, and not saved at all when the capture or preservation destination would overlap the audit, session-state or diagnostics trees (including preserved locations), whose permissions cleanup widens recursively. Protected paths with `..` components are refused. | Preserved with the API proxy logs and never chmodded (`src/routing/router-log-capture.ts`, `src/artifact-preservation.ts`) |
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
IDs from the plans. The owner/mode and lifecycle cells point to setup rules
above; they are not observations from `stat`. The implementation cell names
the mechanism; Compose rows are produced by `src/compose-generator.ts` and its
`src/services/` builders, while microVM rows come from
`src/cloud-hypervisor/exports.ts` and `src/nvx/workspace-export.ts`.

<!-- sharing-plan:start -->
| Runtime / activation | Source | Component / destination (identity above) | Owner / mode | Mount/export access | Lifecycle | Purpose / implementation |
| --- | --- | --- | --- | --- | --- | --- |
| compose/default | &lt;FIXTURE&gt;/work/squid-logs | squid-proxy → /var/log/squid | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | proxy configuration / logs; Compose bind/volume |
| compose/default | /tmp | agent → /tmp | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/workspace | agent → &lt;FIXTURE&gt;/workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/work/agent-logs | agent → &lt;HOME&gt;/.copilot/logs | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/work/agent-session-state | agent → &lt;HOME&gt;/.copilot/session-state | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/work/init-signal | agent → /run/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/work/init-signal | agent → /tmp/awf-init | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/default | /usr | agent → /host/usr | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /bin | agent → /host/bin | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /sbin | agent → /host/sbin | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /lib | agent → /host/lib | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /lib64 | agent → /host/lib64 | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /opt | agent → /host/opt | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /sys | agent → /host/sys | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /dev | agent → /host/dev | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /dev/null | agent → /host/dev/null | existing DAC/modes preserved | rw | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/workspace | agent → /host&lt;FIXTURE&gt;/workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; Compose bind/volume |
| compose/default | /tmp | agent → /host/tmp | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/work-chroot-home | agent → /host&lt;HOME&gt; | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.copilot | agent → /host&lt;HOME&gt;/.copilot | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/work/agent-session-state | agent → /host&lt;HOME&gt;/.copilot/session-state | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/work/agent-logs | agent → /host&lt;HOME&gt;/.copilot/logs | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.cache | agent → /host&lt;HOME&gt;/.cache | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.config | agent → /host&lt;HOME&gt;/.config | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.local/bin | agent → /host&lt;HOME&gt;/.local/bin | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.local/lib | agent → /host&lt;HOME&gt;/.local/lib | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.local/lib64 | agent → /host&lt;HOME&gt;/.local/lib64 | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.local/share | agent → /host&lt;HOME&gt;/.local/share | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.local/pipx | agent → /host&lt;HOME&gt;/.local/pipx | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.azure | agent → /host&lt;HOME&gt;/.azure | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.anthropic | agent → /host&lt;HOME&gt;/.anthropic | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.claude | agent → /host&lt;HOME&gt;/.claude | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.cargo | agent → /host&lt;HOME&gt;/.cargo | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.rustup | agent → /host&lt;HOME&gt;/.rustup | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.npm | agent → /host&lt;HOME&gt;/.npm | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;HOME&gt;/.nvm | agent → /host&lt;HOME&gt;/.nvm | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/tools | agent → /host&lt;FIXTURE&gt;/tools | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /etc/ssl | agent → /host/etc/ssl | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /etc/ca-certificates | agent → /host/etc/ca-certificates | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /etc/pki/ca-trust/extracted | agent → /host/etc/pki/ca-trust/extracted | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /etc/alternatives | agent → /host/etc/alternatives | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /etc/ld.so.cache | agent → /host/etc/ld.so.cache | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /etc/nsswitch.conf | agent → /host/etc/nsswitch.conf | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /etc/passwd | agent → /host/etc/passwd | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | /etc/group | agent → /host/etc/group | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/work/chroot-&lt;ID&gt;/hosts | agent → /host/etc/hosts | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/default | /dev/null | agent → /host/var/run/docker.sock | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host/run/docker.sock | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.docker/config.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.npmrc | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.composer/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.ssh/id_rsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.ssh/id_ed25519 | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.ssh/id_ecdsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.ssh/id_dsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.aws/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.aws/config | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.kube/config | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.azure/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.azure/msal_token_cache.bin | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.azure/msal_token_cache.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.azure/accessTokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.azure/service_principal_entries.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.cargo/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.cargo/credentials.toml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.claude/.credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.gemini/oauth_creds.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.gemini/google_accounts.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.gemini/access_tokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.config/gh/hosts.yml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/credentials.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/access_tokens.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/application_default_credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.config/doctl/config.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.config/rclone/rclone.conf | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.config/containers/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.config/pulumi/credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → &lt;HOME&gt;/.config/helm/repositories.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.azure/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.azure/msal_token_cache.bin | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.azure/msal_token_cache.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.azure/accessTokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.azure/service_principal_entries.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.cargo/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.cargo/credentials.toml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.claude/.credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.config/gh/hosts.yml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/credentials.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/access_tokens.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/application_default_credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.config/doctl/config.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.config/rclone/rclone.conf | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.config/containers/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.config/pulumi/credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | /dev/null | agent → /host&lt;HOME&gt;/.config/helm/repositories.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/default | ephemeral tmpfs | agent → /tmp/gh-aw/mcp-logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host/tmp/gh-aw/mcp-logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → &lt;FIXTURE&gt;/work | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host&lt;FIXTURE&gt;/work | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/audit | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/audit | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/default | ephemeral tmpfs | agent → /host/dev/shm | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,nodev,size=65536k) | container lifetime | isolated shared-memory tmpfs; Compose tmpfs |
| compose/default | &lt;FIXTURE&gt;/work/init-signal | iptables-init → /run/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/default | &lt;FIXTURE&gt;/work/init-signal | iptables-init → /tmp/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/squid-logs | squid-proxy → /var/log/squid | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | proxy configuration / logs; Compose bind/volume |
| compose/api-proxy | /tmp | agent → /tmp | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/workspace | agent → &lt;FIXTURE&gt;/workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/agent-logs | agent → &lt;HOME&gt;/.copilot/logs | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/agent-session-state | agent → &lt;HOME&gt;/.copilot/session-state | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/init-signal | agent → /run/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/init-signal | agent → /tmp/awf-init | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/api-proxy | &lt;REPO&gt;/containers/agent/api-proxy-health-check.sh | agent → /usr/local/bin/api-proxy-health-check.sh | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /usr | agent → /host/usr | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /bin | agent → /host/bin | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /sbin | agent → /host/sbin | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /lib | agent → /host/lib | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /lib64 | agent → /host/lib64 | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /opt | agent → /host/opt | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /sys | agent → /host/sys | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /dev | agent → /host/dev | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host/dev/null | existing DAC/modes preserved | rw | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/workspace | agent → /host&lt;FIXTURE&gt;/workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; Compose bind/volume |
| compose/api-proxy | /tmp | agent → /host/tmp | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work-chroot-home | agent → /host&lt;HOME&gt; | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.copilot | agent → /host&lt;HOME&gt;/.copilot | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/agent-session-state | agent → /host&lt;HOME&gt;/.copilot/session-state | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/agent-logs | agent → /host&lt;HOME&gt;/.copilot/logs | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.cache | agent → /host&lt;HOME&gt;/.cache | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.config | agent → /host&lt;HOME&gt;/.config | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.local/bin | agent → /host&lt;HOME&gt;/.local/bin | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.local/lib | agent → /host&lt;HOME&gt;/.local/lib | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.local/lib64 | agent → /host&lt;HOME&gt;/.local/lib64 | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.local/share | agent → /host&lt;HOME&gt;/.local/share | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.local/pipx | agent → /host&lt;HOME&gt;/.local/pipx | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.azure | agent → /host&lt;HOME&gt;/.azure | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.anthropic | agent → /host&lt;HOME&gt;/.anthropic | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.claude | agent → /host&lt;HOME&gt;/.claude | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.cargo | agent → /host&lt;HOME&gt;/.cargo | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.rustup | agent → /host&lt;HOME&gt;/.rustup | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.npm | agent → /host&lt;HOME&gt;/.npm | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;HOME&gt;/.nvm | agent → /host&lt;HOME&gt;/.nvm | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/tools | agent → /host&lt;FIXTURE&gt;/tools | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /etc/ssl | agent → /host/etc/ssl | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /etc/ca-certificates | agent → /host/etc/ca-certificates | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /etc/pki/ca-trust/extracted | agent → /host/etc/pki/ca-trust/extracted | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /etc/alternatives | agent → /host/etc/alternatives | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /etc/ld.so.cache | agent → /host/etc/ld.so.cache | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /etc/nsswitch.conf | agent → /host/etc/nsswitch.conf | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /etc/passwd | agent → /host/etc/passwd | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /etc/group | agent → /host/etc/group | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/chroot-&lt;ID&gt;/hosts | agent → /host/etc/hosts | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host/var/run/docker.sock | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host/run/docker.sock | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.docker/config.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.npmrc | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.composer/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.ssh/id_rsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.ssh/id_ed25519 | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.ssh/id_ecdsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.ssh/id_dsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.aws/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.aws/config | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.kube/config | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.azure/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.azure/msal_token_cache.bin | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.azure/msal_token_cache.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.azure/accessTokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.azure/service_principal_entries.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.cargo/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.cargo/credentials.toml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.claude/.credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.gemini/oauth_creds.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.gemini/google_accounts.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.gemini/access_tokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.config/gh/hosts.yml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/credentials.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/access_tokens.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/application_default_credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.config/doctl/config.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.config/rclone/rclone.conf | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.config/containers/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.config/pulumi/credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → &lt;HOME&gt;/.config/helm/repositories.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.azure/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.azure/msal_token_cache.bin | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.azure/msal_token_cache.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.azure/accessTokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.azure/service_principal_entries.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.cargo/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.cargo/credentials.toml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.claude/.credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.config/gh/hosts.yml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/credentials.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/access_tokens.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/application_default_credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.config/doctl/config.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.config/rclone/rclone.conf | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.config/containers/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.config/pulumi/credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | /dev/null | agent → /host&lt;HOME&gt;/.config/helm/repositories.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/api-proxy | ephemeral tmpfs | agent → /tmp/gh-aw/mcp-logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host/tmp/gh-aw/mcp-logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → &lt;FIXTURE&gt;/work | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host&lt;FIXTURE&gt;/work | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/audit | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/audit | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/api-proxy | ephemeral tmpfs | agent → /host/dev/shm | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,nodev,size=65536k) | container lifetime | isolated shared-memory tmpfs; Compose tmpfs |
| compose/api-proxy | &lt;FIXTURE&gt;/work/init-signal | iptables-init → /run/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/init-signal | iptables-init → /tmp/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/api-proxy | &lt;FIXTURE&gt;/work/api-proxy-logs | api-proxy → /var/log/api-proxy | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/squid-logs | squid-proxy → /var/log/squid | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | proxy configuration / logs; Compose bind/volume |
| compose/allowWrite-empty | /tmp | agent → /tmp | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/workspace | agent → &lt;FIXTURE&gt;/workspace | existing DAC/modes preserved | ro | host-owned / not removed | workload workspace; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/agent-logs | agent → &lt;HOME&gt;/.copilot/logs | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/agent-session-state | agent → &lt;HOME&gt;/.copilot/session-state | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/init-signal | agent → /run/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/init-signal | agent → /tmp/awf-init | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/allowWrite-empty | /usr | agent → /host/usr | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /bin | agent → /host/bin | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /sbin | agent → /host/sbin | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /lib | agent → /host/lib | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /lib64 | agent → /host/lib64 | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /opt | agent → /host/opt | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /sys | agent → /host/sys | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /dev | agent → /host/dev | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host/dev/null | existing DAC/modes preserved | rw | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/workspace | agent → /host&lt;FIXTURE&gt;/workspace | existing DAC/modes preserved | ro | host-owned / not removed | workload workspace; Compose bind/volume |
| compose/allowWrite-empty | /tmp | agent → /host/tmp | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work-chroot-home | agent → /host&lt;HOME&gt; | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.copilot | agent → /host&lt;HOME&gt;/.copilot | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/agent-session-state | agent → /host&lt;HOME&gt;/.copilot/session-state | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/agent-logs | agent → /host&lt;HOME&gt;/.copilot/logs | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.cache | agent → /host&lt;HOME&gt;/.cache | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.config | agent → /host&lt;HOME&gt;/.config | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.local/bin | agent → /host&lt;HOME&gt;/.local/bin | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.local/lib | agent → /host&lt;HOME&gt;/.local/lib | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.local/lib64 | agent → /host&lt;HOME&gt;/.local/lib64 | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.local/share | agent → /host&lt;HOME&gt;/.local/share | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.local/pipx | agent → /host&lt;HOME&gt;/.local/pipx | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.azure | agent → /host&lt;HOME&gt;/.azure | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.anthropic | agent → /host&lt;HOME&gt;/.anthropic | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.claude | agent → /host&lt;HOME&gt;/.claude | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.cargo | agent → /host&lt;HOME&gt;/.cargo | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.rustup | agent → /host&lt;HOME&gt;/.rustup | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.npm | agent → /host&lt;HOME&gt;/.npm | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;HOME&gt;/.nvm | agent → /host&lt;HOME&gt;/.nvm | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/tools | agent → /host&lt;FIXTURE&gt;/tools | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /etc/ssl | agent → /host/etc/ssl | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /etc/ca-certificates | agent → /host/etc/ca-certificates | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /etc/pki/ca-trust/extracted | agent → /host/etc/pki/ca-trust/extracted | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /etc/alternatives | agent → /host/etc/alternatives | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /etc/ld.so.cache | agent → /host/etc/ld.so.cache | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /etc/nsswitch.conf | agent → /host/etc/nsswitch.conf | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /etc/passwd | agent → /host/etc/passwd | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /etc/group | agent → /host/etc/group | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/chroot-&lt;ID&gt;/hosts | agent → /host/etc/hosts | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host/var/run/docker.sock | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host/run/docker.sock | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.docker/config.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.npmrc | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.composer/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.ssh/id_rsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.ssh/id_ed25519 | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.ssh/id_ecdsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.ssh/id_dsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.aws/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.aws/config | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.kube/config | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.azure/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.azure/msal_token_cache.bin | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.azure/msal_token_cache.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.azure/accessTokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.azure/service_principal_entries.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.cargo/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.cargo/credentials.toml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.claude/.credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.gemini/oauth_creds.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.gemini/google_accounts.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.gemini/access_tokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.config/gh/hosts.yml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/credentials.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/access_tokens.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/application_default_credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.config/doctl/config.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.config/rclone/rclone.conf | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.config/containers/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.config/pulumi/credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → &lt;HOME&gt;/.config/helm/repositories.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.azure/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.azure/msal_token_cache.bin | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.azure/msal_token_cache.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.azure/accessTokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.azure/service_principal_entries.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.cargo/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.cargo/credentials.toml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.claude/.credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.config/gh/hosts.yml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/credentials.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/access_tokens.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/application_default_credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.config/doctl/config.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.config/rclone/rclone.conf | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.config/containers/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.config/pulumi/credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | /dev/null | agent → /host&lt;HOME&gt;/.config/helm/repositories.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /tmp/gh-aw/mcp-logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host/tmp/gh-aw/mcp-logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → &lt;FIXTURE&gt;/work | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host&lt;FIXTURE&gt;/work | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/audit | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/audit | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/allowWrite-empty | ephemeral tmpfs | agent → /host/dev/shm | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,nodev,size=65536k) | container lifetime | isolated shared-memory tmpfs; Compose tmpfs |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/init-signal | iptables-init → /run/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/allowWrite-empty | &lt;FIXTURE&gt;/work/init-signal | iptables-init → /tmp/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/squid-logs | squid-proxy → /var/log/squid | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | proxy configuration / logs; Compose bind/volume |
| compose/enclaves-enabled | /tmp | agent → /tmp | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/workspace | agent → &lt;FIXTURE&gt;/workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/agent-logs | agent → &lt;HOME&gt;/.copilot/logs | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/agent-session-state | agent → &lt;HOME&gt;/.copilot/session-state | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/init-signal | agent → /run/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/init-signal | agent → /tmp/awf-init | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/enclaves-enabled | /usr | agent → /host/usr | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /bin | agent → /host/bin | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /sbin | agent → /host/sbin | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /lib | agent → /host/lib | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /lib64 | agent → /host/lib64 | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /opt | agent → /host/opt | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /sys | agent → /host/sys | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /dev | agent → /host/dev | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host/dev/null | existing DAC/modes preserved | rw | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/workspace | agent → /host&lt;FIXTURE&gt;/workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; Compose bind/volume |
| compose/enclaves-enabled | /tmp | agent → /host/tmp | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work-chroot-home | agent → /host&lt;HOME&gt; | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.copilot | agent → /host&lt;HOME&gt;/.copilot | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/agent-session-state | agent → /host&lt;HOME&gt;/.copilot/session-state | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/agent-logs | agent → /host&lt;HOME&gt;/.copilot/logs | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | logs / state channel; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.cache | agent → /host&lt;HOME&gt;/.cache | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.config | agent → /host&lt;HOME&gt;/.config | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.local/bin | agent → /host&lt;HOME&gt;/.local/bin | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.local/lib | agent → /host&lt;HOME&gt;/.local/lib | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.local/lib64 | agent → /host&lt;HOME&gt;/.local/lib64 | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.local/share | agent → /host&lt;HOME&gt;/.local/share | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.local/pipx | agent → /host&lt;HOME&gt;/.local/pipx | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.azure | agent → /host&lt;HOME&gt;/.azure | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.anthropic | agent → /host&lt;HOME&gt;/.anthropic | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.claude | agent → /host&lt;HOME&gt;/.claude | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.cargo | agent → /host&lt;HOME&gt;/.cargo | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.rustup | agent → /host&lt;HOME&gt;/.rustup | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.npm | agent → /host&lt;HOME&gt;/.npm | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;HOME&gt;/.nvm | agent → /host&lt;HOME&gt;/.nvm | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/tools | agent → /host&lt;FIXTURE&gt;/tools | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /etc/ssl | agent → /host/etc/ssl | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /etc/ca-certificates | agent → /host/etc/ca-certificates | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /etc/pki/ca-trust/extracted | agent → /host/etc/pki/ca-trust/extracted | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /etc/alternatives | agent → /host/etc/alternatives | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /etc/ld.so.cache | agent → /host/etc/ld.so.cache | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /etc/nsswitch.conf | agent → /host/etc/nsswitch.conf | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /etc/passwd | agent → /host/etc/passwd | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /etc/group | agent → /host/etc/group | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/chroot-&lt;ID&gt;/hosts | agent → /host/etc/hosts | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host/var/run/docker.sock | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host/run/docker.sock | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.docker/config.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.npmrc | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.composer/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.ssh/id_rsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.ssh/id_ed25519 | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.ssh/id_ecdsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.ssh/id_dsa | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.aws/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.aws/config | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.kube/config | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.azure/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.azure/msal_token_cache.bin | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.azure/msal_token_cache.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.azure/accessTokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.azure/service_principal_entries.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.cargo/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.cargo/credentials.toml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.claude/.credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.gemini/oauth_creds.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.gemini/google_accounts.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.gemini/access_tokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.config/gh/hosts.yml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/credentials.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/access_tokens.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.config/gcloud/application_default_credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.config/doctl/config.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.config/rclone/rclone.conf | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.config/containers/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.config/pulumi/credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → &lt;HOME&gt;/.config/helm/repositories.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.azure/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.azure/msal_token_cache.bin | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.azure/msal_token_cache.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.azure/accessTokens.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.azure/service_principal_entries.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.cargo/credentials | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.cargo/credentials.toml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.claude/.credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.config/gh/hosts.yml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/credentials.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/access_tokens.db | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.config/gcloud/application_default_credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.config/doctl/config.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.config/rclone/rclone.conf | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.config/containers/auth.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.config/pulumi/credentials.json | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | /dev/null | agent → /host&lt;HOME&gt;/.config/helm/repositories.yaml | existing DAC/modes preserved | ro | host-owned / not removed | credential/socket mask or virtual device; Compose bind/volume |
| compose/enclaves-enabled | ephemeral tmpfs | agent → /tmp/gh-aw/mcp-logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/enclaves-enabled | ephemeral tmpfs | agent → /host/tmp/gh-aw/mcp-logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/enclaves-enabled | ephemeral tmpfs | agent → &lt;FIXTURE&gt;/work | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/enclaves-enabled | ephemeral tmpfs | agent → /host&lt;FIXTURE&gt;/work | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/enclaves-enabled | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/enclaves-enabled | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/logs | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/enclaves-enabled | ephemeral tmpfs | agent → /tmp/gh-aw/sandbox/firewall/audit | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/enclaves-enabled | ephemeral tmpfs | agent → /host/tmp/gh-aw/sandbox/firewall/audit | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,size=1m) | container lifetime | sensitive-path confidentiality mask; Compose tmpfs |
| compose/enclaves-enabled | ephemeral tmpfs | agent → /host/dev/shm | container-created; mode per tmpfs options | rw (tmpfs; rw,noexec,nosuid,nodev,size=65536k) | container lifetime | isolated shared-memory tmpfs; Compose tmpfs |
| compose/enclaves-enabled | /var/tmp/awf-enclave-control-&lt;ID&gt;/run/auth-token | enclave-mcp-server → /run/awf-enclave-mcp/auth-token | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /var/tmp/awf-enclave-private-&lt;ID&gt;/control | enclave-mcp-server → /run/awf-enclave-mcp-control | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /var/tmp/awf-enclave-private-&lt;ID&gt;/audit | enclave-mcp-server → /var/log/awf-enclave | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | component runtime input / tool state; Compose bind/volume |
| compose/enclaves-enabled | /var/tmp/awf-enclave-private-&lt;ID&gt;/host-executor | enclave-mcp-server → /run/awf-enclave-host-executor | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | authenticated host-executor channel; ro bind does not prevent socket calls; Compose bind/volume |
| compose/enclaves-enabled | /var/tmp/awf-enclave-private-&lt;ID&gt;/seed-map.json | enclave-mcp-server → /srv/awf/seed-map.json | AWF setup; see lifecycle table | ro | per-run cleanup / optional preservation | repository ledger metadata; no seed content; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/init-signal | iptables-init → /run/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| compose/enclaves-enabled | &lt;FIXTURE&gt;/work/init-signal | iptables-init → /tmp/awf-init | AWF setup; see lifecycle table | rw | per-run cleanup / optional preservation | init handshake channel; Compose bind/volume |
| cloud-hypervisor/workspace-only | &lt;FIXTURE&gt;/workspace | primary agent → /workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; virtio-fs export (write narrowing separate) |
| cloud-hypervisor/workspace-only | &lt;FIXTURE&gt;/runner-temp/gh-aw | primary agent → &lt;FIXTURE&gt;/runner-temp/gh-aw | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; virtio-fs export (write narrowing separate) |
| cloud-hypervisor/workspace-only | /tmp/gh-aw | primary agent → /tmp/gh-aw | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; virtio-fs export (write narrowing separate) |
| cloud-hypervisor/workspace-and-tool-cache | &lt;FIXTURE&gt;/workspace | primary agent → /workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; virtio-fs export (write narrowing separate) |
| cloud-hypervisor/workspace-and-tool-cache | &lt;FIXTURE&gt;/tools | primary agent → &lt;FIXTURE&gt;/tools | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; virtio-fs export (write narrowing separate) |
| cloud-hypervisor/workspace-and-tool-cache | &lt;FIXTURE&gt;/runner-temp/gh-aw | primary agent → &lt;FIXTURE&gt;/runner-temp/gh-aw | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; virtio-fs export (write narrowing separate) |
| cloud-hypervisor/workspace-and-tool-cache | /tmp/gh-aw | primary agent → /tmp/gh-aw | existing DAC/modes preserved | rw | host-owned / not removed | component runtime input / tool state; virtio-fs export (write narrowing separate) |
| nvx/workspace-only | &lt;FIXTURE&gt;/workspace | primary agent → /workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; virtio-fs export (write narrowing separate) |
| nvx/workspace-and-tool-cache | &lt;FIXTURE&gt;/workspace | primary agent → /workspace | existing DAC/modes preserved | rw | host-owned / not removed | workload workspace; virtio-fs export (write narrowing separate) |
| nvx/workspace-and-tool-cache | &lt;FIXTURE&gt;/tools | primary agent → &lt;FIXTURE&gt;/tools | existing DAC/modes preserved | ro | host-owned / not removed | component runtime input / tool state; virtio-fs export (write narrowing separate) |
<!-- sharing-plan:end -->

### Other conditional relationships and gaps

| Runtime / activation | Source → consumer / destination | Ownership / access / lifecycle / source |
| --- | --- | --- |
| sbx (`--container-runtime sbx`) | workspace, explicit extra directories, `/tmp`, `/usr/local/bin`, and existing whitelisted home tool paths → primary agent at identical absolute paths | `sbx create shell` positional arguments; workspace and omitted-mode paths writable at share boundary, `:ro` optional for extras. Existing DAC preserved. Known credentials under shared tool directories are moved aside before creation and restored **after** sandbox removal; failure/interruption can leave backups requiring recovery (`src/sbx-manager.ts`). Compose's agent volumes are unused. Exact runtime mount enforcement and IDs unverified here. |
| ARC/DinD (`runnerTopology=arc-dind`) | daemon-visible prefixed sources → sysroot stage `sysroot` named volume and filtered agent `/host` subtree | Sources outside shared filesystem can be dropped; sysroot replaces `/host/usr`, `/host/bin`, `/host/sbin`, `/host/lib*`, `/host/opt` and home tool mounts. Prefix applies to daemon bind sources but not kernel VFS or `/dev/null`; see `src/services/optional-services.ts`, `src/services/host-path-prefix.ts`. Check runner *and* daemon paths. |
| CLI proxy (`difcProxyHost`), optional egress relay | `<CLI_PROXY_LOGS>` → `cli-proxy:/var/log/cli-proxy` `rw`; relay has no host bind | Host log parent is created world-writable only when new, contents retain their own modes. Builder: `src/services/cli-proxy-service.ts`; final mount and image user need live validation. |
| CLI proxy with `difcProxyCaCert` | explicitly configured CA file → `cli-proxy:/tmp/proxy-tls/ca.crt` `ro` | Existing ownership/mode preserved; source rewritten with daemon prefix on split filesystems (`src/services/cli-proxy-service.ts`). |
| DoH proxy (`dnsOverHttps`), router (experimental routing) | No host bind in their Compose builders; image rootfs remains component-local | `src/services/{doh-proxy,router}-service.ts`; no host share does not imply absence of network authority. At teardown AWF copies the router's Docker log stream to the host's `router-logs/router.jsonl` (see the lifecycle table); the router never writes to the host. |
| enclave broker / optional image-only services | AWF-private run roots and optional Docker socket → broker, seed and image preparation services (never primary agent) | The generated `compose/enclaves-enabled` scenario exercises the broker/private mounts; `src/services/enclave-mcp-service.ts` and `src/enclave/paths.ts` determine activation, ownership and cleanup. Broker and executor do not share a generic agent root. |
| Cloud Hypervisor `filesystem.allowWrite` | declared exports → guest paths in table | `src/cloud-hypervisor/filesystem-write-enforcement.ts` builds host mount trees: staged read-only parents with writable allowed submounts, possibly publishing a workspace export `ro` for deny-all. Export mode by itself does not prove host enforcement. |
| Cloud Hypervisor script/agent enclave | per-invocation seed and request → `/input-seed`, `/input-request` (`ro`); output/runtime → `/output`, `/runtime` (`rw`); agent adds handoff `ro` and session state `rw` | Closed role-specific plan in `src/cloud-hypervisor/enclave-export-plan.ts`; sources owned by enclave host staging; excluded from primary exports. Live per-role permission proof remains a coverage gap. |
| NVX (`workspace-and-tool-cache`) | tool cache → same guest path `ro`; workspace → `/workspace` `rw`; guest seed `/home/awf` → scratch home `/tmp/awf-home` | Realpath-canonical export sources; source permissions preserved. `filesystem.allowWrite` support is backend-specific: consult `src/filesystem-policy.ts` before enabling. |

Sensitive-path masks are additional read denials, not ordinary shares. Compose
places tmpfs overlays over the work directory (which contains plaintext runtime
tokens and logs), `/tmp/gh-aw/mcp-logs`, and the firewall `logs`/`audit`
directories at both direct and `/host` targets. Cloud Hypervisor masks registered
sensitive descendants inside published exports, including `/tmp/gh-aw`, even
when `filesystem.allowWrite` is absent. These overlays hide host contents even
where a broader writable `/tmp/gh-aw` export appears in the inventory; masking
does not imply confidentiality for unregistered siblings.

Negative guarantees to review independently: no blanket host `$HOME`, `/etc`,
`/`, or enclave-private root in the primary agent; no direct credentials from
unmounted paths; both direct and `/host` credential-mask targets where relevant;
registered sensitive-path masks hide their host contents; no broad custom mount
or symlink alias exposing a private root; no upgrade of a pre-existing read-only
source through `filesystem.allowWrite`. With `--enable-dind`,
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
