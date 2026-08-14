---
title: Cloud Hypervisor integration (preview)
description: Cloud Hypervisor v53.0 microVM backend — REST API client, secure launcher, manager/backend, GitHub-hosted Ubuntu x86_64 KVM runners only, Landlock/seccomp confinement in place of a jailer.
---

:::caution[Preview — GitHub-hosted Ubuntu x86_64 KVM runners only]
Cloud Hypervisor is an explicit-opt-in preview, exactly like
[Firecracker](./firecracker-integration.md). It requires
`--cloud-hypervisor-preview` **and** `--container-runtime cloud-hypervisor`,
runs only on GitHub-hosted Ubuntu x86_64 KVM runners (self-hosted runners
are rejected, unlike Firecracker's preview), and is otherwise fail-closed.
Firecracker continues to work unchanged and is unaffected by this backend.
:::

This document originated as **stack layer 3**, which built a complete,
runnable Cloud Hypervisor microVM backend on top of the layer 1 VMM-neutral
`src/microvm/` primitives and the layer 2 configuration/artifact/preflight
foundation. **Stack layer 4** (this layer) adds the live-KVM GitHub Actions
CI workflow (`test-cloud-hypervisor.yml`, Part 14), the parity/security
smoke suite (`scripts/ci/cloud-hypervisor-live-smoke.sh`), and this
documentation update; Firecracker remains present and unaffected. Firecracker
removal, if it ever happens, is an explicit later layer and is out of scope
here.

## Part 1 — What Cloud Hypervisor adds and why it is a preview

### What Cloud Hypervisor is

[Cloud Hypervisor](https://www.cloudhypervisor.org/) is a Rust VMM built on
`rust-vmm` crates, offering a REST API (`/api/v1`) over a Unix domain socket
for VM lifecycle management. AWF uses it as a second, alternative microVM
backend to Firecracker — same threat model (hypervisor-isolated agent
execution, mandatory network egress control, mandatory API proxy credential
isolation), different VMM implementation and host launch strategy.

### Why it is a preview

- It is supported **only** on GitHub-hosted Ubuntu x86_64 KVM runners (see
  Part 4). Self-hosted runners, other architectures, and other operating
  systems are all explicitly rejected.
- Cloud Hypervisor has **no jailer-equivalent process**. AWF replaces
  jailer's chroot+pivot_root+capability-drop with a different (not weaker)
  boundary: network-namespace join, non-root privilege drop, and
  kernel-enforced Landlock filesystem confinement (see Part 3).
- The live-KVM GitHub Actions workflow that exercises this backend end to
  end on real hardware is `test-cloud-hypervisor.yml` (Part 14), added in
  stack layer 4 alongside the parity/security smoke suite.

### Comparison with Firecracker

| Aspect | Firecracker | Cloud Hypervisor |
|---|---|---|
| Control plane | REST over UDS, Firecracker-specific endpoints | REST over UDS, `/api/v1`, upstream OpenAPI-documented |
| Privileged launcher | `jailer` binary (chroot, cgroup, netns join, uid/gid drop) | None — AWF's own launcher (netns join via `ip netns exec`, privilege drop via `setpriv`, Landlock via VM config) |
| Bus for block/net/vsock | MMIO (`pci=off`) | virtio-**pci** (PCI required; no MMIO transport) |
| Host support | Linux/KVM, GitHub-hosted or self-hosted | GitHub-hosted Ubuntu x86_64 KVM only |
| Guest kernel, rootfs, supervisor | Own pinned artifacts | Shared upstream kernel config plus `CONFIG_VIRTIO_FS=y`; shared supervisor |
| Workspace | Writable ext4 image with stop-time copy-back | Live read-write virtio-fs export at `/workspace` |
| Resource limits | jailer's own cgroup (no explicit quotas set by AWF) | AWF creates and assigns an explicit memory/CPU/PID cgroup |

## Part 2 — Architecture

### Host-side components

1. **`src/cloud-hypervisor/api-client.ts`** — `CloudHypervisorApiClient`, a
   typed REST client over the Unix domain socket, implementing exactly the
   endpoints AWF needs: `vmm.ping`, `vm.create`, `vm.boot`, `vm.info`,
   `vm.counters`, `vm.shutdown`, `vmm.shutdown`. Every request has a bounded
   wall-clock timeout and a 1 MiB response cap; error bodies (Cloud
   Hypervisor's chained-error-message JSON arrays) are parsed into a single
   readable message.
2. **`src/cloud-hypervisor/launcher.ts`** — pure functions and small classes
   for the secure host launch:
   - `buildCloudHypervisorLaunchCommand()` builds the exact argv AWF spawns:
     `ip netns exec <namespace> setpriv --reuid=<uid> --regid=<gid>
     --groups=<kvm-gid> --no-new-privs --inh-caps=-all,+net_admin
     --bounding-set=-all,+net_admin --ambient-caps=+net_admin
     -- cloud-hypervisor --api-socket path=<path> --log-file <path> -v
     --seccomp true`. `--groups=<kvm-gid>` replaces the operator's full
     supplementary group list with only the group that owns `/dev/kvm`
     (resolved by preflight) — a blanket `--clear-groups` would also drop
     kvm-group access and make every real launch fail with EACCES. The
     capability set is empty except for `CAP_NET_ADMIN`, retained via the
     bounding, inheritable, and ambient sets together — Cloud Hypervisor's
     virtio-net backend needs it to finish configuring the already-created,
     already-owned TAP device (`vm.boot` otherwise fails with "Failed to
     read the TAP flags from sysfs: Permission denied"). No shell is ever
     invoked — this argv is passed directly to `execa`, never interpolated
     into a shell string.
   - `computeCloudHypervisorLandlockRules()` computes the minimal
     `landlock_rules` list sent in the `vm.create` payload.
   - `CloudHypervisorCgroup` manages a cgroup v2 hierarchy: it enables
     `cpu`/`memory`/`pids` delegation (`cgroup.subtree_control`) at the
     cgroup root and the shared parent directory before creating the
     per-run leaf cgroup (cgroup v2 only materializes a controller's
     interface files in a child once the parent delegates it), writes
     explicit `memory.max`/`cpu.max`/`pids.max`, and assigns the launched
     process's PID to it. Cleanup uses a plain `rmdir` on the leaf —
     cgroupfs's controller files are virtual and a recursive `rm` fails.
     `runCloudHypervisorPreflight` rejects cgroup v1-only hosts explicitly
     (see Part 4) rather than falling back to a v1 hierarchy this class
     does not manage.
3. **`src/cloud-hypervisor/manager.ts`** — `CloudHypervisorManager` owns one
   run end to end: preflight → network namespace setup (reusing
   `src/microvm/network.ts` unchanged) → rootfs-only supervisor injection →
   private run-directory staging → cgroup setup → VMM launch → API-socket
   readiness → one sandboxed `virtiofsd` per validated export → `vm.create` →
   (later) `vm.boot` → VSOCK guest-supervisor connect, retried with a fresh
   client on the guest-boot-timing race documented in Part 3 (reusing
   `src/microvm/vsock-client.ts` and `guest-protocol.ts` unchanged) →
   execution → graceful `vm.shutdown`/`vmm.shutdown` → VMM termination
   → virtiofsd termination → network/cgroup/run-directory cleanup, with
   aggregated cleanup-error reporting matching Firecracker's manager.
   The class itself is an orchestration facade; the supporting pieces live
   beside it in `src/cloud-hypervisor/`: shared run paths/types in
   `manager-types.ts`, the `vm.create` payload in `vm-config-builder.ts`,
   run-directory staging plus failure diagnostics in `diagnostics.ts`, and
   the guest VSOCK execution/IO surface in `guest-execution.ts`.
4. **`src/cloud-hypervisor-runtime-backend.ts`** — `CloudHypervisorRuntimeBackend`
   implements `ExternalAgentRuntimeBackend`: infrastructure discovery
   (`src/microvm/infrastructure.ts`, unchanged), credential-safe guest
   environment construction, guest connectivity probing (Squid + API
   proxy), cancellation/timeout/exit-code handling, and diagnostics
   collection — structurally identical to `FirecrackerRuntimeBackend`.

### Guest contents

Shared with Firecracker except for a deterministic `CONFIG_VIRTIO_FS=y`
overlay on the PCI-capable guest kernel (the upstream
`microvm-kernel-ci-x86_64-6.1.config` SHA remains pinned),
a deterministic BusyBox + CA-bundle ext4 rootfs, and the VMM-neutral
shared `awf-supervisor` guest binary (`guest/firecracker-supervisor/`).

### Control flow

```
awf --container-runtime cloud-hypervisor --cloud-hypervisor-preview ...
    ↓
assertCloudHypervisorRuntimeCompatibility() — security mode, topology, GitHub-hosted host eligibility, artifact/digest completeness
    ↓
runCloudHypervisorPreflight() — Linux/KVM/x86_64, /dev/kvm + owning gid, cgroup v2 (v1-only hosts rejected), trusted host tools incl. setpriv, trusted+pinned+digest-verified artifacts
    ↓
CloudHypervisorManager.start()
    ↓
MicrovmNetworkManager.setup() (netns, veth, TAP, nftables — shared with Firecracker)
    ↓
MicrovmRootfsPreparer.prepare() (writable rootfs copy + supervisor injection; no workspace image)
    ↓
private run directory under /run/awf-cloud-hypervisor (0711 ancestors, 0700 leaf owned by the non-root identity) + per-run cgroup v2 (subtree_control delegated root→parent→leaf)
    ↓
buildCloudHypervisorLaunchCommand() → ip netns exec → setpriv --groups=<kvm-gid> --ambient-caps=+net_admin → cloud-hypervisor --api-socket ... --seccomp true (minimal PATH-only environment)
    ↓
wait for API socket → vmm.ping → start sandboxed virtiofsd daemons → vm.create (memory.shared=true, fs devices, landlock_enable=true)
    ↓
CloudHypervisorRuntimeBackend.start(): vm.boot → VSOCK connect (CID 3, CONNECT <port>\n, retried on the guest-boot-timing race — see Part 3) → Squid/API-proxy connectivity probe
    ↓
Agent command executes inside the guest via the VSOCK guest-protocol transport (unchanged)
    ↓
guest sync + reverse unmount → vm.shutdown → vmm.shutdown → SIGTERM/SIGKILL fallback → stop/reap virtiofsd → network/cgroup/run-directory cleanup
```

## Part 3 — Security boundary: the launcher in place of a jailer

Cloud Hypervisor ships as a single static binary with **no jailer
equivalent** — nothing that atomically joins a network namespace, chroots,
drops capabilities, and execs the VMM. Reimplementing jailer's chroot +
`pivot_root` for a foreign binary was judged impractical and risky within
this layer, so AWF instead documents and tests an explicit replacement
boundary:

1. **Network namespace join.** `ip netns exec <namespace> ...` execs
   directly into the namespace `src/microvm/network.ts` already prepared
   (the same TAP/veth/nftables topology Firecracker uses), without an
   intermediate fork — the resulting process keeps the PID the host
   observes for cgroup assignment.
2. **Privilege drop.** `setpriv --reuid=<uid> --regid=<gid>
   --groups=<kvm-gid> --no-new-privs --inh-caps=-all,+net_admin
   --bounding-set=-all,+net_admin --ambient-caps=+net_admin`
   execs Cloud Hypervisor as the same non-root operator identity
   Firecracker's jailer targets (`SUDO_UID`/`SUDO_GID`), with `no_new_privs`
   set and an otherwise-empty capability set before any guest code runs.
   `--groups=<kvm-gid>` replaces the operator's supplementary group
   list with only the group that owns `/dev/kvm` (resolved by preflight);
   a blanket `--clear-groups` would also drop that membership and make
   every real launch fail opening `/dev/kvm` even though root-run
   preflight passed. The capability set retains exactly one exception,
   `CAP_NET_ADMIN` — via the bounding, inheritable, and ambient sets
   together, so it survives the uid change and `execve()` of a plain,
   non-file-capability binary even under `--no-new-privs` — because Cloud
   Hypervisor's virtio-net backend needs it to finish configuring the
   already-created, already-owned TAP device; without it, `vm.boot` fails
   with "Failed to read the TAP flags from sysfs: Permission denied".
3. **Filesystem confinement.** In place of jailer's userspace chroot, AWF
   combines:
   - a **private run directory** under `/run/awf-cloud-hypervisor/<binary>/<runId>/`
     — deliberately **outside** `workDir` (which is root-owned `0700`
     because it holds `docker-compose.yml`'s plaintext secrets). Since
     there is no `chroot()` to make host-side ancestor permissions
     irrelevant, the non-root launched process must be able to really
     traverse down to the run directory: the two ancestor levels are
     `0711` (traversable/executable by any uid, but not listable), and
     only the per-run leaf directory is chowned to the target identity
     with `0700` (so only that identity, or root, can read its contents);
   - **Landlock**, a Linux LSM, enabled via `landlock_enable: true` in the
     `vm.create` payload with a minimal `landlock_rules` list (kernel image
     read-only; rootfs and the run directory read-write;
     `/dev/kvm` and `/dev/net/tun` read-write for KVM ioctls and TAP
     attachment; the TAP's own `/sys/class/net/<tapName>` directory
     read-only, for the world-readable `tun_flags` sysfs attribute Cloud
     Hypervisor's virtio-net setup reads to detect multi-queue support —
     without this rule Landlock itself blocks that read, surfacing as
     `vm.boot` failing with "Failed to read the TAP flags from sysfs:
     Permission denied" even though ordinary Unix file permissions would
     have allowed it). Any path not listed becomes inaccessible to the Cloud
     Hypervisor process the instant Landlock is enabled. Export source trees
     are deliberately absent: only the separate virtiofsd processes can open
     them. This is enforced by the
     kernel, not a userspace boundary a compromised process could bypass.
   - Cloud Hypervisor's own **default seccomp filter** (`--seccomp true`,
     its default kill-on-violation mode).

   This is a **different** boundary than jailer's chroot — kernel-LSM-based
   rather than mount-namespace-based — not a weaker one. It is exercised by
   `src/cloud-hypervisor/launcher.test.ts` (argv construction, Landlock rule
   computation, cgroup lifecycle) rather than silently degraded to "no
   filesystem confinement".
4. **Resource limits.** A dedicated cgroup **v2** hierarchy is created
   before launch: `cpu`/`memory`/`pids` delegation is enabled at the
   cgroup root and the shared parent directory (`cgroup.subtree_control`)
   before the per-run leaf cgroup is created, then explicit
   `memory.max`/`cpu.max`/`pids.max` are written and the launched
   VMM and every virtiofsd PID are assigned to it immediately after spawn. Cgroup v1-only
   hosts are rejected explicitly at preflight (see Part 4) rather than
   silently constructing a broken multi-controller v1 hierarchy.
5. **The management API socket is never guest-accessible.** It lives only
   in the host-side private run directory; it is never passed to the guest
   as a drive, vsock, or virtio-fs device, and Landlock additionally blocks
   any *new* open() of it by the Cloud Hypervisor process after `vm.create`
   (the already-open listening socket is unaffected, matching how a
   jailer-chrooted Firecracker keeps its already-open resources).
6. **Minimal launcher environment.** The launched process receives an
   explicit minimal environment (just `PATH`), never `process.env` —
   Cloud Hypervisor directly parses untrusted guest/device input, so a VMM
   compromise reading its own inherited environment could otherwise read
   provider/GitHub credentials and bypass the API-proxy credential
   isolation boundary entirely.

## Part 4 — Prerequisites and supported hosts

### Supported host configurations

| Requirement | Value |
|-------------|-------|
| Operating system | **Linux only**, and additionally **GitHub-hosted only** (`GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`) |
| Distribution | Ubuntu (`ImageOS` must start with `ubuntu`) |
| Architecture | x86_64 only |
| KVM device | `/dev/kvm` must exist and be readable + writable |
| Cgroup hierarchy | **cgroup v2 unified only** (`/sys/fs/cgroup/cgroup.controllers` must exist) — cgroup v1-only hosts are rejected explicitly; see `CloudHypervisorCgroup` in Part 3 |
| Self-hosted runners | **Explicitly rejected** — see `src/cloud-hypervisor/host-eligibility.ts` |

Host eligibility is checked in two layers: `evaluateGithubHostedRunnerEligibility()`
(host identity only — cheap, environment-variable based) and the full
`runCloudHypervisorPreflight()` (live capability checks: `/dev/kvm`, cgroup
version, trusted host tools, artifact trust/digests).

### Required host tools

Same as Firecracker (`ip`, `nft`, `sysctl`, `mke2fs`, `debugfs`, `e2fsck`,
`rsync`), plus:

| Tool | Purpose |
|------|---------|
| `setpriv` | Drops to the non-root operator uid/gid before Cloud Hypervisor execs, retaining only `CAP_NET_ADMIN` (util-linux; standard on Ubuntu) |

### Operator account

Same as Firecracker: AWF must be invoked through `sudo` from a **non-root**
account; `SUDO_UID`/`SUDO_GID` determine the target identity for both the
launcher's `setpriv` step and the guest execution identity. The target
account must have `/dev/kvm` access (typically via `kvm` group membership).

## Part 5 — Artifact policy

Identical trust model to Firecracker (see
[Firecracker's Part 5](./firecracker-integration.md#part-5--artifact-policy)):
root/operator-owned non-writable regular files, trusted ancestor
directories, pinned version, mandatory SHA-256 digests. Cloud Hypervisor has no jailer-equivalent binary. It additionally requires a
trusted executable sibling `virtiofsd`, pinned to Ubuntu Noble's v1.10.0.

| Artifact | Version | SHA-256 |
|---|---|---|
| `cloud-hypervisor` (x86_64 static) | v53.0 | `448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc` |
| `virtiofsd` (Ubuntu Noble `/usr/libexec/virtiofsd`) | v1.10.0 | recorded in bundle `SHA256SUMS` |
| Linux kernel source | 6.1.141 | `bc3c45faf6f5f0450666c75fa9dad9bc7c0cf7c7cba0dbd94e5cfdc58229c116` |
| Upstream kernel config (from Firecracker v1.16.1) | `microvm-kernel-ci-x86_64-6.1.config` | `adbc70ab5e89213ba00594b12d25e09bdf8bb1ed3c252d7449326bb14c22963b` |
| Final kernel config | upstream plus `CONFIG_FUSE_FS=y` and `CONFIG_VIRTIO_FS=y`, then `olddefconfig` | emitted as `kernel.config` and recorded in `SHA256SUMS` |
| BusyBox source | 1.36.1 | `b8cc24c9574d809e7279c3be349795c5d5ceb6fdf19ca709f80cde50e47de314` |
| CA bundle | 2025-02-25 | `50a6277ec69113f00c5fd45f09e8b97a4b3e32daa35d3a95ab30137a55386cef` |

## Part 6 — Devices, boot, and networking

- **Boot**: direct kernel boot (no UEFI/firmware layer), root device
  `/dev/vda`, `rootfstype=ext4`, `rw`,
  `net.ifnames=0 biosdevname=0` for deterministic `eth0` naming. Unlike
  Firecracker, `pci=off` is **not** set — Cloud Hypervisor requires PCI.
- **Devices**: one virtio-**pci** block device (rootfs), virtio-fs shares,
  net (single TAP,
  pre-created and owned exactly like Firecracker's), vsock (CID 3, same
  `CONNECT <port>\n` transport and guest-protocol framing as Firecracker),
  serial console redirected to a bounded host log file, virtio-console
  disabled (`mode: "Off"`). No snapshots, migration, hotplug,
  VFIO, vhost-user, vDPA, TDX/SEV, or TPM.
- **Networking**: the same TAP/netns/nftables design as Firecracker
  (`src/microvm/network.ts`) — mandatory network isolation and mandatory API
  proxy credential isolation. Trusted `topologyAttach` peers are resolved from
  the proven internal Docker network, revalidated before boot, injected into
  the guest hosts file, and allowed only on TCP 8080 for the MCP gateway.

## Part 7 — Bounded diagnostics

`CloudHypervisorManager.collectDiagnostics()` writes, all under a
0700-mode directory with 0600-mode files bounded to 1 MiB each: launcher
stdout/stderr capture, the Cloud Hypervisor log file, the guest serial
console log, bounded per-export virtiofsd logs, `vm.counters()` output (best-effort — failures don't block
diagnostics), the resolved network plan, and a `runtime.json` summary. This
mirrors Firecracker's `collectDiagnostics()` shape exactly.

## Part 8 — CLI reference

```bash
sudo awf \
  --container-runtime cloud-hypervisor \
  --cloud-hypervisor-preview \
  --cloud-hypervisor-binary /usr/local/bin/cloud-hypervisor \
  --cloud-hypervisor-kernel /opt/awf/vmlinux \
  --cloud-hypervisor-rootfs /opt/awf/rootfs.ext4 \
  --cloud-hypervisor-supervisor /opt/awf/awf-supervisor \
  --cloud-hypervisor-binary-sha256 <digest> \
  --cloud-hypervisor-virtiofsd-sha256 <digest> \
  --cloud-hypervisor-kernel-sha256 <digest> \
  --cloud-hypervisor-rootfs-sha256 <digest> \
  --cloud-hypervisor-supervisor-sha256 <digest> \
  --enable-api-proxy \
  --allow-domains github.com \
  -- npx @github/copilot --prompt "list files"
```

See [`docs/awf-config-spec.md`](./awf-config-spec.md) §4.1 for the full
config-file/CLI mapping.

## Part 9 — Explicit scope limits (this layer)

- **Direct kernel boot only.** No UEFI/firmware layer.
- **One raw ext4 rootfs disk**, `backing_files: false`, plus the fixed
  narrow virtio-fs export policy. No arbitrary shares,
  snapshot/restore, hotplug, VFIO, vhost-user, vDPA, or confidential
  computing.
- **virtio-pci transport only** for block, net, and vsock devices.
- **GitHub-hosted Ubuntu x86_64 KVM runners only.** Self-hosted runners and
  non-Ubuntu/non-x86_64 hosts are explicitly rejected.
- **No TTY, DinD, host access, extra volume mounts, DIFC proxies, or
  enclaves.** Trusted MCP gateway topology peers are supported only through the
  exact discovered internal-network IP and TCP port 8080.
- **No vhost-net/vhost-user and no throughput claims.** The performance
  baselines in Part 14 measure boot/readiness latency and cgroup-bounded
  memory overhead only; this preview makes no network throughput guarantees.
- **Firecracker is unaffected and remains supported.** Removing Firecracker
  is an explicit later layer, not this one.

### Virtio-fs export policy and tradeoffs

The workspace is exported live, read-write, as tag `workspace` at
`/workspace`; there is no ext4 workspace image, staging copy, or copy-back.
Host and guest therefore observe writes immediately. This avoids stale merge
semantics but also means a guest write changes the host workspace directly.

Optional exports are limited to `RUNNER_TOOL_CACHE` (falling back to
`AGENT_TOOLSDIRECTORY`) read-only at the same absolute path,
`${RUNNER_TEMP}/gh-aw` read-only at the same absolute path, and `/tmp/gh-aw`
read-write. Missing optional directories are skipped. AWF does not export all
of `RUNNER_TEMP`, the host home, or arbitrary paths. Guest `HOME` is
workspace-local `/workspace/.awf-home`, so it is writable by the invoking
runner identity even when that identity is not UID 1000.

Each export has its own pinned virtiofsd with namespace sandboxing, explicit
kill-on-violation seccomp, controlled caching, and disabled inode file handles.
Read-only exports are backed by host read-only bind mounts under a separate
private directory before virtiofsd starts; guest mount flags enforce the same
policy again. Sockets and bounded logs live in the VMM run directory, while
the bind mounts remain outside its Landlock rules. The VMM receives socket
paths only and cannot access host source trees directly.

## Part 14 — CI workflow

The Cloud Hypervisor preview has its own dedicated CI workflow,
[`test-cloud-hypervisor.yml`](../.github/workflows/test-cloud-hypervisor.yml),
based on the retained
[Firecracker test conventions](./firecracker-integration.md#part-14--ci-workflow)
but adapted for this backend's GitHub-hosted-only support statement and
jailer-free launcher. The corresponding Firecracker Actions workflow is
disabled.

### Trigger conditions

The workflow triggers **only** on:

- `workflow_dispatch` — manual trigger; `run_live_kvm: false` validates the
  deterministic artifact build without queueing the KVM job.
- A pull request open, synchronize, or reopen event, **scoped to paths**
  under `guest/cloud-hypervisor/`, `guest/firecracker-supervisor/` (shared
  guest supervisor), `src/cloud-hypervisor/`,
  `src/cloud-hypervisor-runtime-backend.ts`, `src/microvm/`,
  `scripts/ci/cloud-hypervisor-*.sh`, this document, and the workflow file
  itself — builds and verifies the deterministic guest artifacts on
  `ubuntu-24.04`.
- A pull request being **labeled** with `cloud-hypervisor-kvm` additionally
  enables the live KVM job.

It does **not** run on push or schedule. The path scoping keeps CI cost
proportional to actual changes to this preview instead of running on every
unrelated pull request.

### Jobs

#### `build-test-artifacts` (runs on `ubuntu-24.04`, no KVM required)

1. Checks out the repository and sets up Go 1.25.0 (cache keyed on the
   shared `guest/firecracker-supervisor/go.mod`).
2. Installs the same deterministic kernel-build prerequisites Firecracker's
   job uses (`bc`, `binutils`, `bison`, `build-essential`, `cpio`,
   `e2fsprogs`, `file`, `flex`, `libelf-dev`, `libssl-dev`, `rsync`, `virtiofsd`,
   `xz-utils`) — both backends use the same pinned upstream kernel config;
   Cloud Hypervisor applies the documented virtio-fs overlay.
3. Builds the canonical ARC/DinD `build-tools` sysroot image, then runs
   `guest/cloud-hypervisor/build-test-artifacts.sh` — downloads Cloud
   Hypervisor v53.0 (SHA-256 verified) and Linux 6.1.141 (SHA-256 verified);
   applies and verifies `CONFIG_VIRTIO_FS=y`; copies Ubuntu Noble
   virtiofsd v1.10.0; builds the kernel and shared supervisor; exports the Ubuntu 22.04
   `build-tools` userspace into the guest rootfs; produces
   `SHA256SUMS`, `manifest.json`, and `sbom.spdx.json`; archives everything
   as `release/cloud-hypervisor-test-x86_64/awf-cloud-hypervisor-test-x86_64.tar.gz`.
4. Runs `guest/cloud-hypervisor/verify-test-artifacts.sh` against the output.
5. Attests artifact provenance via `actions/attest-build-provenance`.
6. Uploads `release/cloud-hypervisor-test-x86_64/` as artifact
   `cloud-hypervisor-test-x86_64` with 7-day retention.

#### `live-kvm` (runs on `ubuntu-24.04`)

Gated on manual dispatch (`run_live_kvm: true`) or the `cloud-hypervisor-kvm`
pull request label — never on unlabeled pull requests, push, or schedule.
Its preflight fails closed (does not silently skip) if the runner lacks
usable KVM or any other required host capability.

1. Downloads the `cloud-hypervisor-test-x86_64` artifact from the build job.
2. Runs `scripts/ci/cloud-hypervisor-host-preflight.sh` — verifies Linux,
   x86_64, GitHub-hosted-only host eligibility (`GITHUB_ACTIONS`,
   `RUNNER_ENVIRONMENT`, `ImageOS`), `/dev/kvm`, required host tools
   including `setpriv`, Landlock LSM availability, the Cloud Hypervisor
   and virtiofsd version strings, and all artifact SHA-256 digests via
   `sha256sum --check --strict SHA256SUMS`.
3. Installs NPM dependencies, builds the AWF distribution, and builds the
   Squid and API proxy container images locally.
4. Runs `scripts/ci/cloud-hypervisor-live-smoke.sh` — the live test suite.
5. Collects redacted diagnostics (audit, proxy-logs, stdout/stderr) and
   scans for the secret sentinel before uploading, unconditionally
   (`if: always()`).
6. Enforces final residue cleanup — network namespaces, the
   `awf-cloud-hypervisor` cgroup tree, and any lingering `cloud-hypervisor`
   process — unconditionally (`if: always()`).

### Live smoke test assertions

`cloud-hypervisor-live-smoke.sh` reproduces
[Firecracker's full 13-case contract](./firecracker-integration.md#live-smoke-test-assertions)
verbatim (same case names, same expected exit codes, same assertions), then
adds three Cloud Hypervisor-specific cases:

| Case | Expected exit | Assertion |
|------|--------------|-----------|
| `allowed-https` | 0 | `wget https://example.com` succeeds and returns "Example Domain" |
| `blocked-domain` | 0 | `wget https://github.com` fails (not in `--allow-domains`) |
| `direct-egress` | 0 | Unsets proxy vars; direct `wget` fails |
| `arbitrary-tcp` | 0 | `nc -z 1.1.1.1 443` fails |
| `dns-denial` | 0 | `nslookup example.com 8.8.8.8` fails |
| `metadata-denial` | 0 | Unsets proxy vars; `wget http://169.254.169.254/latest/meta-data/` fails |
| `api-proxy-reflect` | 0 | API proxy `/reflect` reachable; secret sentinel absent from guest `env` |
| `workspace-live-share` | 0 | Guest writes, `chmod 755`, and a symlink are immediately visible on the host |
| `runtime-cache-readonly` | 0 | `${RUNNER_TEMP}/gh-aw` is readable but guest writes fail |
| `exit-code` | 37 | `exit 37` propagates as AWF exit code 37 |
| `timeout-124` | 124 | `sleep 90` with `--agent-timeout 1` exits 124 |
| `device-assumptions` **(new)** | 0 | `/dev/vda` is the sole block disk, `/workspace` is virtio-fs, and `eth0` exists |
| `partial-start-cleanup` | 1 | Corrupt rootfs (valid digest, invalid content) fails cleanly; no residue |
| `cancellation` | 143 | `SIGTERM` after namespace appears cleans up; cleanup time is measured against a non-flaky ceiling |
| `keep` (keep mode) | 0 | `--keep-containers` preserves namespace/run-directory/diagnostics; all bounded ≤1 MiB |
| `security-assertions` **(new)** | 143 | See below |

The `security-assertions` case starts a long-lived guest command, then —
while the VM is live — inspects the host-visible Cloud Hypervisor process
and its own `vm.info` response to prove the launcher's jailer-replacement
boundary (Part 3) live, not just at the argv-construction unit-test level:

- **Non-root identity**: `/proc/<pid>` is not owned by uid 0.
- **Minimal effective capability set**: `/proc/<pid>/status`'s `CapEff` is
  exactly `0000000000001000` — `CAP_NET_ADMIN` alone (needed for Cloud
  Hypervisor's virtio-net backend to finish configuring the already-owned
  TAP device; see Part 3) and nothing else.
- **`no_new_privs` is set**: `NoNewPrivs: 1`.
- **Active seccomp filter**: `Seccomp: 2` (filter mode), confirming
  `--seccomp true` is in effect.
- **Cgroup membership and bounded limits**: the process's PID appears in
  `/sys/fs/cgroup/awf-cloud-hypervisor/<runId>/cgroup.procs`; `memory.max`
  is a bounded positive number (cgroup v1 hosts are rejected outright by
  preflight, so there is no v1 fallback to check); live `memory.current`
  usage is greater than zero and does not exceed it (the "bounded memory
  overhead" baseline from Part 4/9).
- **`landlock_enable` reflected in `vm.create`** and an **exactly-minimal
  device set**: querying the Cloud Hypervisor process's own
  `GET /api/v1/vm.info` over its private Unix domain socket confirms
  exactly one rootfs disk, the expected narrow virtio-fs devices, exactly one net device, and a
  vsock device — proving the host-only API socket path is never wired to
  the guest as any device (structurally, not just by absence of a mount).

Boot/readiness and cleanup-time are measured as non-flaky regression
baselines (generous ceilings tuned for shared GitHub-hosted runners, not
tight performance targets): the `allowed-https` case's total wall time is
checked against a 90-second boot+readiness+run+cleanup ceiling, and the
`cancellation` case's SIGTERM-to-clean-residue time is checked against a
20-second ceiling.

### Secret sentinel check

All smoke test cases set
`OPENAI_API_KEY=awf-cloud-hypervisor-real-secret-do-not-expose` (a value
distinct from Firecracker's sentinel so the two suites' diagnostics never
cross-contaminate if run in the same job). After each run, the test scans
`stdout.log`, `audit/`, and `proxy-logs/` for this sentinel string.

### Shared vs. backend-specific residue naming

`src/microvm/network.ts` is VMM-neutral and used unmodified by both
backends (Part 2), so the network namespace (`awffc-*`) and veth/TAP
(`fch*`/`fcn*`/`fct*`) residue checks are intentionally identical to
Firecracker's — this is shared infrastructure, not a Cloud Hypervisor gap.
The cgroup path (`/sys/fs/cgroup/awf-cloud-hypervisor/<runId>`) and process
name (`cloud-hypervisor`) residue checks are Cloud Hypervisor-specific.

## Part 15 — Troubleshooting

Most preflight, boot, and cleanup failure modes are identical to
Firecracker's — see
[Firecracker's Part 15](./firecracker-integration.md#part-15--troubleshooting)
for the general shape of each failure (host tool missing, digest mismatch,
API timeout, guest connectivity probe failure, Docker infrastructure not
cleaned up; Firecracker-only workspace copy-back recovery via `debugfs`). This section covers
only what differs for Cloud Hypervisor.

**`Cloud Hypervisor is supported only on GitHub-hosted runners, not self-hosted`**

Unlike Firecracker's preview, this backend rejects self-hosted runners
outright (`src/cloud-hypervisor/host-eligibility.ts`). There is no flag to
override this; run on a GitHub-hosted Ubuntu x86_64 runner instead.

**`Cloud Hypervisor requires a GitHub-hosted Ubuntu runner image`**

`ImageOS` did not start with `ubuntu` — you are likely on a non-Ubuntu
GitHub-hosted image (e.g. Windows or macOS runners, which also lack
`/dev/kvm`). Use an `ubuntu-24.04` (or later) runner.

**`Cloud Hypervisor is pinned to v53.0; found v<other>`**

The Cloud Hypervisor binary is not v53.0. Do not bypass the version check;
obtain the pinned release.

**`host tool "setpriv" was not found on PATH`**

Install `util-linux` (`setpriv` ships in it; standard on Ubuntu, so this
should not occur on a genuine GitHub-hosted Ubuntu runner).

**`The running kernel does not report Landlock in /sys/kernel/security/lsm`**

Landlock requires Linux 5.13+ with `CONFIG_SECURITY_LANDLOCK=y` and the LSM
enabled at boot (`lsm=landlock,...` on the kernel cmdline, or Landlock
included in the distribution default). GitHub-hosted Ubuntu 24.04 runners
ship this by default; a custom or older kernel may not.

**`guest disconnected before readiness` on `startInstance()`**

This is expected transient behavior, not a bug: Cloud Hypervisor's own
vsock-over-UDS multiplexer closes the host-facing connection immediately if
the guest hasn't yet started listening on the target vsock port (kernel
boot + guest supervisor startup take a variable, host-load-dependent amount
of time). `CloudHypervisorManager.startInstance()` retries the connect with
a fresh client every 250 ms for up to 90 seconds before surfacing the error;
seeing it in this error message means that entire retry budget was
exhausted. If it persists, check the guest serial console log
(`<auditDir>/cloud-hypervisor/serial.log`) for a kernel panic or a
supervisor startup failure rather than assuming it is purely a timing
issue.

**Known GitHub-hosted-runner limitation: multi-vCPU guest boot can stall
for 90+ seconds under nested virtualization.** Live validation captured a
guest boot that made no further progress for 90+ real seconds immediately
after its serial console logged `kvm-guest: setup PV IPIs` at kernel
virtual time ~0.13s — the point where a guest with more than one vCPU
begins bringing up its secondary (AP) CPUs via inter-processor interrupts
(INIT-SIPI-SIPI). GitHub-hosted runners execute Cloud Hypervisor under
*nested* virtualization (its own log reports `Running under nested
virtualisation. Hypervisor string: Microsoft Hv` there); local
APIC/IPI virtualization for a nested (L2) guest is not hardware-accelerated
the way it is for an L1 guest on this class of infrastructure, so every
AP-bring-up step traps all the way up to the L0 host and back — a
well-documented, order-of-magnitude nested-KVM SMP penalty, not a Cloud
Hypervisor or AWF defect. A single-vCPU guest never reaches that code path
at all and boots in the expected sub-second-to-few-seconds range even
nested. `scripts/ci/cloud-hypervisor-live-smoke.sh` therefore passes
`--cloud-hypervisor-vcpus 1`; the default (`--cloud-hypervisor-vcpus`,
default 2, see `docs/awf-config-spec.md`) is unchanged for other
environments, but operators running this preview on similarly nested
infrastructure (self-managed nested-KVM CI, for example) should expect the
same AP-bring-up penalty at more than one vCPU and may need to raise
`CLOUD_HYPERVISOR_GUEST_READY_MAX_WAIT_MS` further or pin to a single vCPU.
The 90-second retry budget above remains a deliberately generous safety
margin for ordinary boot-timing variance (kernel decompression + supervisor
startup), independent of this specific SMP pathology.

When `--diagnostic-logs` is set, `CloudHypervisorRuntimeBackend.start()`'s
failure path collects diagnostics via a `beforeCleanup` hook passed to
`CloudHypervisorManager.stop()`, invoked after the Cloud Hypervisor process
is confirmed terminated but before `stop()` removes the private run
directory those diagnostic files live in. This ordering matters: Cloud
Hypervisor does not guarantee flushing buffered guest serial console
output to disk until its own process actually exits (`vmm.shutdown()`
alone is not sufficient), so collecting diagnostics any earlier — e.g.
before the process is terminated at all — can observe a still-empty
`serial.log` even when the guest did write to its console before crashing
or hanging.

`CloudHypervisorRuntimeBackend.collectDiagnostics()` is idempotent
(collects at most once per instance): the CLI's own generic cleanup path
(`buildCleanupFn` in `commands/main-action.ts`) unconditionally calls
`externalRuntimeBackend.collectDiagnostics()` again during shutdown,
regardless of whether `start()`'s failure path already collected
diagnostics via the `beforeCleanup` hook above. Without the idempotency
guard, that second, redundant call ran *after* `stop()` had already torn
down the network/cgroup, silently clobbering the earlier, more useful
snapshot with an empty/unavailable one (observed live:
`network-diagnostics.txt` regressing from real content to "network
namespace not set up" between two collectDiagnostics() calls in the same
failed run). Likewise, `start()`'s failure path now marks the backend
`stopped` once its own internal `manager.stop()` call succeeds, so that
same generic cleanup path's `externalRuntimeBackend.stop()` call becomes a
no-op instead of invoking `manager.stop()` a second, redundant time (a
failed internal stop deliberately leaves `stopped` false, so the outer
cleanup path still gets a genuine retry attempt).

The same "API socket only responsive before shutdown, files only flushed
after shutdown" tension applies to `vm.info`/`vm.counters`, not just the
serial console: `CloudHypervisorManager.stop()` snapshots both *before*
calling `vmm.shutdown()` (stored as `lastVmInfo`/`lastVmCounters`), since a
live call from inside `collectDiagnostics()` (invoked later, via
`beforeCleanup`, after the process has already been asked to exit) would
always fail against an already-unresponsive socket. `collectDiagnostics()`
prefers this snapshot and only falls back to a live call when invoked
directly outside of `stop()` (e.g. via `--diagnostic-logs` without a
failure). Written to `vm-info.json` alongside the existing
`counters.json`.

`CloudHypervisorManager.collectDiagnostics()`'s host-side network capture
(`network-diagnostics.txt`) now includes, in addition to `nft list
ruleset` and `ip -s link show`: `nft -a list ruleset` (rule handles, plus
per-rule hit counters — `generateMicrovmNftRuleset()` attaches a `counter`
object to every forward-chain rule purely for this diagnostic visibility;
it does not change any accept/drop decision), `ip -d link show`, `ip route
show`, `ip neigh show` (inside the microVM's own namespace), and a
separate host-side (outside any namespace) `bridge fdb show` for the
infrastructure bridge Squid/API-proxy containers are attached to — MAC
learning for that traffic happens on the bridge, not inside the
namespace. The guest-side capture (`probeGuestConnectivity()`'s failure
path) also now includes `ip neigh show` to confirm ARP resolution.

**Guest kernel panics with `Attempted to kill init!` on every boot (fixed;
historical)**

Once the two boot-timing issues above were resolved, live-KVM validation
uncovered the real underlying blocker: the guest kernel's serial console
showed `Run /sbin/awf-supervisor as init process` immediately followed by
`firecracker-supervisor: mount workspace: no such device` and a kernel
panic. `mountWorkspace()` in
`guest/firecracker-supervisor/runtime_linux.go` called
`syscall.Mount(device, mount, "", 0, "")` — an **empty filesystem type**.
An empty fstype is only valid for bind/remount mounts (`MS_BIND`/
`MS_REMOUNT`); a fresh mount of a raw block device with an empty fstype
fails with `ENODEV` ("no such device"), even though the device itself
exists and is a valid block device. The workspace image is always
formatted `ext4` (see `src/microvm/workspace.ts`'s `mkfs -t ext4`), so this
was fixed by passing `"ext4"` explicitly. This guest supervisor binary is
shared between the Firecracker and Cloud Hypervisor backends. Cloud Hypervisor
now selects its virtio-fs path instead, while Firecracker retains this ext4
mount unchanged. This was a genuine historical defect affecting both
backends when both used the block-device path. A
regression test (`TestWorkspaceMountArgsUseExt4Filesystem` in
`runtime_linux_test.go`) and a CI step running `go test ./...` for this
package (see Part 14) now guard against a regression of this specific
class of bug.

**`Cloud Hypervisor guest connectivity probe failed with exit code 127`
(fixed; historical)**

`CloudHypervisorRuntimeBackend.probeGuestConnectivity()` originally shelled
out to `curl` inside the guest to verify Squid and (if enabled) API proxy
reachability before declaring the microVM ready. The guest rootfs used for
this backend's own live-KVM validation is a minimal BusyBox userland (see
`guest/cloud-hypervisor/build-test-artifacts.sh`) that provides `wget` and
`nc` but not `curl` — exit code 127 is the shell's "command not found".
Fixed by switching the Squid reachability check to `nc -z` (a raw TCP
check; a non-proxy-style HTTP request to Squid's own port intentionally
returns a 4xx error page by Squid's design, which BusyBox `wget`, unlike
`curl` without `--fail`, treats as a script failure by default — so `nc -z`
avoids that mismatch entirely) and the API proxy `/reflect` check to
`wget` with the guest's proxy environment variables unset for that one
request (matching the smoke test's own `api-proxy-reflect` case, and
replacing `curl --noproxy '*'`, which BusyBox `wget` has no equivalent
flag for). **Note:** `FirecrackerRuntimeBackend.probeGuestConnectivity()`
has the identical `curl`-based implementation and shares this same guest
rootfs build; it was not modified here (out of scope for this layer), but
is very likely affected identically on any real Firecracker live-KVM run
against this rootfs — see the layer 4 completion handoff.

**Guest boots and gets a valid IP, but all TCP connections to Squid/API
proxy time out (fixed; historical)**

Once the defects above were fixed, the guest reliably booted with a
correctly-configured `eth0` IP and default route, but every connection to
Squid or the API proxy still timed out. Live diagnostics (`nft list
ruleset` + `ip -s link show` inside the microVM's network namespace,
captured before teardown — see `network-diagnostics.txt` above) showed the
*host-side TAP device* with an asymmetric packet count: ~10 RX packets
(guest-to-host — working) but only 1 TX packet (host-to-guest — stalled),
even though 20+ response packets had already arrived on the host-side veth
from Squid. Traffic was reaching the host and being correctly forwarded by
nftables, but Cloud Hypervisor was not relaying it back into the guest.

Root cause: Cloud Hypervisor's own tap handling (`Tap::open_named()` in
`net_util/src/tap.rs`) always re-opens its tap file descriptor requesting
`IFF_VNET_HDR` (a `struct virtio_net_hdr` prefix on every frame). The
shared TAP-creation code in `src/microvm/network.ts` (`ip tuntap add ...
mode tap`, used unmodified by both Firecracker and Cloud Hypervisor) never
requested that feature at *creation* time. When Cloud Hypervisor's re-open
requests a frame layout the tap wasn't created to support, the host kernel
and Cloud Hypervisor disagree on frame layout specifically for the
host-to-guest direction — guest-to-host traffic (and the entire host-side
veth/nftables layer) keeps working normally, masking the problem as a
"the guest just isn't receiving responses" mystery rather than an obvious
hard failure.

Fixed by adding a `tapVnetHdr` field to `MicrovmNetworkPlanOptions`/
`MicrovmNetworkPlan` (defaulting to `false`, preserving Firecracker's
existing, unaffected behavior exactly), which conditionally appends
`vnet_hdr` to the `ip tuntap add` invocation. `CloudHypervisorManager`
opts in explicitly (`tapVnetHdr: true`) when building its network plan;
Firecracker's own manager does not (Firecracker's tap handling does not
request `IFF_VNET_HDR`, so creating the tap with that feature available
would have been a no-op for Firecracker, but changing shared, working
code without a concrete reason is unnecessary risk).

**Guest connectivity probe still times out even with a fully-correct
network path (fixed; historical)**

After the `vnet_hdr` fix above, live network diagnostics conclusively
showed the tap/nftables/MAC path working correctly — Squid's response
packets reached the host-side veth — yet
`probeGuestConnectivity()`'s `nc -z -w 5` inside the guest still timed out.
This is the same nested-virtualization vCPU-scheduling phenomenon
documented for guest boot above (see
`CLOUD_HYPERVISOR_GUEST_READY_MAX_WAIT_MS`): the guest's vCPU can be
scheduled so rarely that a short-lived command doesn't get enough real CPU
time to complete a `connect()` within a tight budget, even though nothing
about the network path itself is broken. Raised `nc`'s own timeout to 60s,
`wget`'s to 20s, and the overall guest-exec budget
(`CLOUD_HYPERVISOR_PROBE_TIMEOUT_MS`) to 90s to match the same
nested-KVM-tolerant convention used elsewhere, and increased the live-KVM
workflow job's `timeout-minutes` accordingly.

**Guest→Squid packets forwarded but the return path never matches
`established,related` (under investigation)**

With per-rule nftables counters added (see the diagnostics-lifecycle entry
above), a live run showed the guest→Squid forward-chain rule matching real
traffic (`counter packets 6 bytes 360 accept`, from `nc`'s own SYN
retransmissions over its 60s budget), while the return-path accept rule
(`ether daddr <guestMac> ip daddr <guestIp> ct state established,related
accept`) stayed at **zero** hits, and none of the anti-spoof drop rules
matched either. This rules out both a misconfigured anti-spoof rule and a
`vnet_hdr`/tap-negotiation failure (both would show up as counter hits
somewhere); the traffic leaves the guest and is accepted outbound, but
Squid's reply is never recognized as belonging to that connection.

Two changes were made to narrow this further, not yet confirmed as the
fix:
- Added a `counter` to the chain's very first rule, `ct state invalid
  drop` — previously uncounted, so a reply being marked "invalid" by
  conntrack (and dropped before ever reaching the return-path accept rule)
  would have been invisible. If this rule's counter is nonzero on the next
  live run, that is the confirmed root cause.
- Cloud Hypervisor's virtio-net device defaults all three offloads
  (`offload_tso`, `offload_ufo`, `offload_csum`) to enabled (confirmed via
  `vm.info`'s `net[0]` config, now captured in `vm-info.json`). This
  network path is a fully-software bridge/veth/tap chain with no real NIC
  downstream to finish partially-offloaded (unchecksummed /
  not-yet-segmented) frames; conntrack's TCP state tracking needs a valid,
  fully-computed checksum to correctly parse segment flags/sequence
  numbers, so an offloaded-but-never-finished checksum is a plausible
  cause for exactly this "accepted outbound, reply never tracked as
  established" symptom. All three are now explicitly disabled in the net
  device config (`CloudHypervisorManager.buildVmConfig()`) rather than
  relying on Cloud Hypervisor's own defaults.

**Update**: neither of the two changes above resolved it. A follow-up live
run with both applied showed the *identical* pattern — `ct state invalid`
still at zero hits (ruling out conntrack-invalid marking) and the return
accept rule still at zero hits (ruling out the offload/checksum theory,
since disabling all three offloads made no observable difference). Since
the microVM's own nftables table shows no rule matching the return traffic
at all (neither accepting nor dropping it), the packets may never be
reaching this bridge/veth from Squid's side in the first place, or may be
handled entirely by a *different* ruleset before ever reaching this one.
`captureHostBridgeDiagnostics()` was extended to also capture the
host/default-namespace `nft -a list ruleset` and `iptables -S` — Docker
manages its own iptables/nftables rules for its bridge networks in that
same root namespace, entirely separate from (and evaluated in addition
to) the microVM's own table, and could independently drop or redirect
traffic on this shared bridge in a way the microVM's own counters would
never reveal. This is the next concrete lead to check against a live run.

**Update**: a follow-up live run's host-level ruleset showed Docker's
`DOCKER-ISOLATION-STAGE-1`/`DOCKER-FORWARD` chains present for the
infrastructure bridge (confirmed as ours by its subnet-based isolation
rule, `ip saddr != 172.30.0.0/24 ... drop`, matching AWF's real subnet),
but neither of its two explicit anti-cross-network drop rules showed any
hits (0/0), and the one same-bridge accept rule
(`iifname X oifname X accept`, matching guest↔Squid intra-bridge traffic)
also showed exactly zero hits across the whole run — inconclusive on its
own, since 0 hits doesn't distinguish "never reached this rule" from
"reached but something upstream already handled it".

Given Firecracker uses this exact same shared netns/bridge/nftables/veth
code and its own live-KVM CI is green, the bridge/Docker-isolation path
itself is very unlikely to be broken in a way specific to this scenario.
The next most likely explanation, consistent with everything observed so
far (guest boot needing a 90s budget for what should be sub-second AP
bring-up; the connectivity probe needing the same generous budget with
only marginal improvement from 5s→90s; a bare handful of tap packets
relayed regardless of how long the test waits): `CloudHypervisorCgroup`
sized the CPU quota as exactly "1 CPU per configured vCPU"
(`vcpuCount * CGROUP_V2_PERIOD_US`), but Cloud Hypervisor's own I/O,
virtio device emulation (including the tap fd read/write loop for the
guest's network device), and API threads all run in that *same* cgroup as
the vCPU thread(s) and compete for the *same* quota. Under nested KVM on
GitHub-hosted runners (where vCPU exits are unusually expensive), the
vCPU thread alone can consume most of an already-tight, vCPU-only-sized
quota, starving the VMM's own non-vCPU threads (including the one
relaying guest network I/O) of their share — independent of wall-clock
timeout length, matching why raising timeouts alone barely helped.

Added a fixed `CGROUP_CPU_HEADROOM_QUOTA_US` (one additional full
CPU-equivalent, `100_000`us per period) on top of the per-vCPU quota,
mirroring the existing `CGROUP_MEMORY_HEADROOM_MIB` pattern for the same
"VMM overhead needs room beyond what's sized for the guest alone" reason.

**Update — root cause confirmed and fixed.** Neither the CPU headroom
change nor any of the previous attempts changed the observable pattern:
`ct state invalid` and the return-path accept rule both stayed at exactly
zero hits, run after run, and the guest's outbound packet count (6
packets from `nc`'s own SYN-retry schedule) was identical regardless of
CPU quota, offloads, or `vnet_hdr`. That consistency was itself the clue:
this was never a scheduling/timing artifact.

Squid's own `access.log` (captured in the diagnostics artifact) settled
it conclusively: it showed **zero** connection attempts from the guest's
address, across the entire test run — while genuine container-to-container
traffic on the exact same bridge (the API proxy reaching Squid) worked
fine. The microVM's own nftables table showed the outbound packet being
accepted (leaving via the host-side veth), but it never arrived at Squid.

Root cause: Docker's host-level `DOCKER-FORWARD` chain includes a
generic same-bridge accept rule (`iifname <bridge> oifname <bridge>
accept`) intended to permit intra-bridge traffic, but it never matched
traffic to/from our manually-injected (non-Docker-managed) veth on this
GitHub-hosted runner's Docker/kernel/nftables combination — silently
falling through to the `FORWARD` chain's default-drop policy. Real
Docker-managed containers on the same bridge are unaffected (Docker
grants them rules of their own that an externally-injected veth never
receives).

Fixed by inserting a scoped `ACCEPT` rule directly into Docker's
`DOCKER-USER` chain (which Docker evaluates *before* its own isolation
logic) — `-i <bridge> -o <bridge> -j ACCEPT`, both interfaces required to
be this exact per-run bridge. This is the same `DOCKER-USER`
customization point AWF's own container-based sandbox mode already uses
(`src/host-iptables-chain.ts`), just scoped for the microVM
network-isolation path instead. Inserted right after the host veth joins
the bridge in `MicrovmNetworkManager.setup()`, and removed in `cleanup()`
(tolerant of it already being gone). Scoped to exactly this per-run
bridge (Docker Compose assigns a unique bridge name per invocation) with
both interfaces required to match, so it does not weaken isolation for
any other bridge/network on the host, and it does not bypass the
microVM's own in-namespace nftables allowlist — that allowlist still
governs what the guest can send in the first place; this rule only fixes
the Docker-level pass-through for traffic that has already cleared it.

**`Cloud Hypervisor requires a non-root target uid/gid`**

Same as Firecracker's jailer requirement: run through `sudo` from a
non-root account so `SUDO_UID`/`SUDO_GID` are set — see
[Firecracker's Part 15](./firecracker-integration.md#preflight-failures).

**Cgroup residue remains after cleanup (fixed; historical)**

Live-KVM validation observed `Cloud Hypervisor cgroup residue remains
after cleanup` following a guest-connectivity-probe failure and immediate
teardown. `CloudHypervisorCgroup.cleanup()` called `rmdir()` on the leaf
cgroup exactly once; cgroup v2 rejects `rmdir()` on a non-empty cgroup
with `EBUSY` not only while a process is still a live member, but also for
a short window *after* that process has fully exited — the memory
controller's charge-migration teardown can lag process-exit by a handful
of milliseconds under load, even though `stop()` only calls `cleanup()`
once process termination is already confirmed. Fixed by retrying `rmdir()`
on `EBUSY` for up to 5 seconds (100ms interval) before giving up; any
other error (e.g. `EACCES`) still fails immediately, unretried.

**Namespace, cgroup, and process residue after a failed run:**

```bash
# List namespace residue (shared naming with Firecracker)
sudo ip netns list | grep awffc

# Remove all AWF microVM namespaces
sudo ip netns list | awk '/^awffc-/{print $1}' | \
  xargs -r -I{} sudo ip netns delete {}

# List and remove Cloud Hypervisor-specific cgroup residue
sudo find /sys/fs/cgroup/awf-cloud-hypervisor -mindepth 1 -maxdepth 1
sudo rmdir /sys/fs/cgroup/awf-cloud-hypervisor/<runId>

# Find a lingering Cloud Hypervisor process (do not blindly pkill by name;
# confirm the PID belongs to an AWF run before terminating it)
pgrep -af 'cloud-hypervisor --api-socket'
```

**Run directory residue (only if stop failed):**

```bash
ls /tmp/awf-*/cloud-hypervisor-run/ 2>/dev/null
sudo rm -rf /tmp/awf-<timestamp>/cloud-hypervisor-run/cloud-hypervisor/<runId>
```

## Part 16 — Validation performed in this layer

- `tsc --noEmit -p tsconfig.check.json`: clean.
- Full Jest suite: all suites passing, including layer 3's API client,
  launcher (argv construction, kvm-gid retention, Landlock rule
  computation, cgroup v2 `subtree_control` delegation ordering and
  rmdir-only cleanup), manager, backend, and runtime-registration coverage,
  plus new layer 4 coverage for the CI workflow's YAML structure (triggers,
  permissions, concurrency, job gating, path scoping) and the new
  `scripts/ci/cloud-hypervisor-*.sh` scripts' behavior (13-case parity with
  Firecracker, device-assumption, read-only-cache, and security-assertion coverage, distinct
  secret sentinel, shared-vs-specific residue naming, digest flag wiring).
- `bash -n` and `shellcheck` (severity=error) on both new scripts, plus
  `bash -n` on every `run:` block in the new workflow YAML.
- `guest/firecracker-supervisor` Go tests (`go vet`, `go test`): unaffected,
  confirming the shared guest supervisor still works for both backends.
- **Live-KVM validation**: the `test-cloud-hypervisor.yml` workflow's
  `live-kvm` job runs the full smoke/security suite on real GitHub-hosted
  KVM hardware when triggered (manual dispatch or the
  `cloud-hypervisor-kvm` pull request label). This development environment
  has no `/dev/kvm`, so the suite's actual pass/fail status must be
  confirmed from the workflow run itself rather than reproduced locally.
