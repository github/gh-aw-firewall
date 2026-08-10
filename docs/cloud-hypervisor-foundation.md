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

This is **stack layer 3** of a 4-layer PR stack: it builds a complete,
runnable Cloud Hypervisor microVM backend on top of the layer 1 VMM-neutral
`src/microvm/` primitives and the layer 2 configuration/artifact/preflight
foundation. Layer 4 adds the live-KVM GitHub Actions CI workflow.

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
  end on real hardware is a later layer; this layer's validation is unit
  tests plus static analysis only (see Part 15).

### Comparison with Firecracker

| Aspect | Firecracker | Cloud Hypervisor |
|---|---|---|
| Control plane | REST over UDS, Firecracker-specific endpoints | REST over UDS, `/api/v1`, upstream OpenAPI-documented |
| Privileged launcher | `jailer` binary (chroot, cgroup, netns join, uid/gid drop) | None — AWF's own launcher (netns join via `ip netns exec`, privilege drop via `setpriv`, Landlock via VM config) |
| Bus for block/net/vsock | MMIO (`pci=off`) | virtio-**pci** (PCI required; no MMIO transport) |
| Host support | Linux/KVM, GitHub-hosted or self-hosted | GitHub-hosted Ubuntu x86_64 KVM only |
| Guest kernel, rootfs, supervisor | Own pinned artifacts | **Shared** pinned kernel config and guest supervisor binary with Firecracker |
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
     --groups=<kvm-gid> --no-new-privs --inh-caps=-all --bounding-set=-all
     -- cloud-hypervisor --api-socket path=<path> --log-file <path> -v
     --seccomp true`. `--groups=<kvm-gid>` replaces the operator's full
     supplementary group list with only the group that owns `/dev/kvm`
     (resolved by preflight) — a blanket `--clear-groups` would also drop
     kvm-group access and make every real launch fail with EACCES. No
     shell is ever invoked — this argv is passed directly to `execa`,
     never interpolated into a shell string.
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
   `src/microvm/network.ts` unchanged) → workspace image preparation
   (reusing `src/microvm/workspace.ts` unchanged) → private run-directory
   staging → cgroup setup → launch → API-socket readiness → `vm.create` →
   (later) `vm.boot` → VSOCK guest-supervisor connect (reusing
   `src/microvm/vsock-client.ts` and `guest-protocol.ts` unchanged) →
   execution → graceful `vm.shutdown`/`vmm.shutdown` → process termination
   → workspace extraction → network/cgroup/run-directory cleanup, with
   aggregated cleanup-error reporting matching Firecracker's manager.
4. **`src/cloud-hypervisor-runtime-backend.ts`** — `CloudHypervisorRuntimeBackend`
   implements `ExternalAgentRuntimeBackend`: infrastructure discovery
   (`src/microvm/infrastructure.ts`, unchanged), credential-safe guest
   environment construction, guest connectivity probing (Squid + API
   proxy), cancellation/timeout/exit-code handling, and diagnostics
   collection — structurally identical to `FirecrackerRuntimeBackend`.

### Guest contents

Unchanged from layer 2 and shared with Firecracker: the PCI-capable guest
kernel (built from Firecracker's pinned `microvm-kernel-ci-x86_64-6.1.config`),
a deterministic BusyBox + CA-bundle ext4 rootfs, and the VMM-neutral
`awf-supervisor` guest binary (`guest/firecracker-supervisor/`, unmodified).

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
MicrovmWorkspaceImage.prepare() (workspace + rootfs staging — shared with Firecracker)
    ↓
private run directory under /run/awf-cloud-hypervisor (0711 ancestors, 0700 leaf owned by the non-root identity) + per-run cgroup v2 (subtree_control delegated root→parent→leaf)
    ↓
buildCloudHypervisorLaunchCommand() → ip netns exec → setpriv --groups=<kvm-gid> → cloud-hypervisor --api-socket ... --seccomp true (minimal PATH-only environment)
    ↓
wait for API socket → vmm.ping → vm.create (landlock_enable: true, minimal landlock_rules)
    ↓
CloudHypervisorRuntimeBackend.start(): vm.boot → VSOCK connect (CID 3, CONNECT <port>\n) → Squid/API-proxy connectivity probe
    ↓
Agent command executes inside the guest via the VSOCK guest-protocol transport (unchanged)
    ↓
graceful guest shutdown → vm.shutdown → vmm.shutdown → SIGTERM/SIGKILL fallback → workspace extraction → network/cgroup/run-directory cleanup
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
   --groups=<kvm-gid> --no-new-privs --inh-caps=-all --bounding-set=-all`
   execs Cloud Hypervisor as the same non-root operator identity
   Firecracker's jailer targets (`SUDO_UID`/`SUDO_GID`), with an empty
   capability bounding set and `no_new_privs` set, before any guest code
   runs. `--groups=<kvm-gid>` replaces the operator's supplementary group
   list with only the group that owns `/dev/kvm` (resolved by preflight);
   a blanket `--clear-groups` would also drop that membership and make
   every real launch fail opening `/dev/kvm` even though root-run
   preflight passed.
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
     read-only; rootfs, workspace, and the run directory read-write;
     `/dev/kvm` and `/dev/net/tun` read-write for KVM ioctls and TAP
     attachment). Any path not listed becomes inaccessible to the Cloud
     Hypervisor process the instant Landlock is enabled — enforced by the
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
   process's PID is assigned to it immediately after spawn. Cgroup v1-only
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
| `setpriv` | Drops to the non-root operator uid/gid with an empty capability set before Cloud Hypervisor execs (util-linux; standard on Ubuntu) |

### Operator account

Same as Firecracker: AWF must be invoked through `sudo` from a **non-root**
account; `SUDO_UID`/`SUDO_GID` determine the target identity for both the
launcher's `setpriv` step and the guest execution identity. The target
account must have `/dev/kvm` access (typically via `kvm` group membership).

## Part 5 — Artifact policy

Identical trust model to Firecracker (see
[Firecracker's Part 5](./firecracker-integration.md#part-5--artifact-policy)):
root/operator-owned non-writable regular files, trusted ancestor
directories, pinned version, mandatory SHA-256 digests. Cloud Hypervisor has
no jailer-equivalent binary, so there is one fewer artifact to pin than
Firecracker (no jailer digest).

| Artifact | Version | SHA-256 |
|---|---|---|
| `cloud-hypervisor` (x86_64 static) | v53.0 | `448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc` |
| Linux kernel source | 6.1.141 | `bc3c45faf6f5f0450666c75fa9dad9bc7c0cf7c7cba0dbd94e5cfdc58229c116` |
| Kernel config (from Firecracker v1.16.1) | `microvm-kernel-ci-x86_64-6.1.config` | `adbc70ab5e89213ba00594b12d25e09bdf8bb1ed3c252d7449326bb14c22963b` |
| BusyBox source | 1.36.1 | `b8cc24c9574d809e7279c3be349795c5d5ceb6fdf19ca709f80cde50e47de314` |
| CA bundle | 2025-02-25 | `50a6277ec69113f00c5fd45f09e8b97a4b3e32daa35d3a95ab30137a55386cef` |

## Part 6 — Devices, boot, and networking

- **Boot**: direct kernel boot (no UEFI/firmware layer), root device
  `/dev/vda`, workspace device `/dev/vdb`, `rootfstype=ext4`, `rw`,
  `net.ifnames=0 biosdevname=0` for deterministic `eth0` naming. Unlike
  Firecracker, `pci=off` is **not** set — Cloud Hypervisor requires PCI.
- **Devices**: virtio-**pci** block (rootfs, workspace), net (single TAP,
  pre-created and owned exactly like Firecracker's), vsock (CID 3, same
  `CONNECT <port>\n` transport and guest-protocol framing as Firecracker),
  serial console redirected to a bounded host log file, virtio-console
  disabled (`mode: "Off"`). No virtio-fs, snapshots, migration, hotplug,
  VFIO, vhost-user, vDPA, TDX/SEV, or TPM.
- **Networking**: the exact same TAP/netns/nftables design as Firecracker
  (`src/microvm/network.ts`, unmodified) — mandatory network isolation,
  mandatory API proxy credential isolation, identical egress ACL.

## Part 7 — Bounded diagnostics

`CloudHypervisorManager.collectDiagnostics()` writes, all under a
0700-mode directory with 0600-mode files bounded to 1 MiB each: launcher
stdout/stderr capture, the Cloud Hypervisor log file, the guest serial
console log, `vm.counters()` output (best-effort — failures don't block
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
- **Raw ext4 disks only**, `backing_files: false`. No virtio-fs,
  snapshot/restore, hotplug, VFIO, vhost-user, vDPA, or confidential
  computing.
- **virtio-pci transport only** for block, net, and vsock devices.
- **GitHub-hosted Ubuntu x86_64 KVM runners only.** Self-hosted runners and
  non-Ubuntu/non-x86_64 hosts are explicitly rejected.
- **No TTY, DinD, host access, extra volume mounts, enclaves, or topology
  peers** — same restrictions as Firecracker's preview.
- **No live-KVM GitHub Actions workflow yet.** This layer's validation is
  unit tests, `tsc --noEmit`, and the existing Firecracker live-KVM
  workflow (unaffected). A dedicated Cloud Hypervisor live-KVM smoke test
  is a later layer's responsibility — see Part 15.

## Part 15 — Validation performed in this layer

- `tsc --noEmit -p tsconfig.check.json`: clean.
- Full Jest suite: all suites passing, including new coverage for the API
  client (typed requests, chained-error parsing, timeout/size bounds),
  launcher (argv construction, kvm-gid retention, Landlock rule
  computation, cgroup v2 subtree_control delegation ordering and rmdir-only
  cleanup), manager (launch, partial-start rollback, workspace/vsock
  lifecycle, keep-mode preservation, termination-confirmation retry,
  natural-exit wait, `vm.create` failure rollback, signal-exit fast-fail,
  bounded diagnostics with `vm.counters`), backend (host-eligibility gating,
  stdin serialization, TTY rejection, credential-safe environment,
  cancellation), and runtime registration/preview-gate wiring.
- No new shell scripts were introduced — the launcher builds argv arrays
  passed directly to `execa`; there is nothing to `shellcheck`/`bash -n`.
- `guest/firecracker-supervisor` Go tests (`go vet`, `go test`): unaffected,
  confirming the shared guest supervisor still works for both backends.
- **Not performed in this layer**: an actual boot on real KVM hardware.
  This environment has no `/dev/kvm` and no built Cloud Hypervisor guest
  artifacts, so a live smoke test would be faked, not validated. This is
  explicitly deferred to the layer that adds the dedicated live-KVM GitHub
  Actions workflow.
