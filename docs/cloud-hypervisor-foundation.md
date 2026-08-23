---
title: Cloud Hypervisor architecture
description: Architecture, security boundaries, artifacts, networking, lifecycle, CI, and troubleshooting for the Cloud Hypervisor microVM preview.
---

Cloud Hypervisor runs the primary agent in a hardware-isolated microVM while
AWF keeps Squid and the API proxy in Docker Compose on the host.

:::caution[Preview support]
This runtime requires both `--container-runtime cloud-hypervisor` and
`--cloud-hypervisor-preview`. It supports only GitHub-hosted Ubuntu x86_64
runners with KVM and fails closed on other hosts.
:::

## Architecture overview

The runtime separates infrastructure from workload execution:

```text
GitHub-hosted Ubuntu x86_64 runner
├── Docker Compose
│   ├── Squid proxy
│   └── API proxy
├── AWF control process
│   ├── artifact and host preflight
│   ├── Cloud Hypervisor REST client
│   ├── network namespace and nftables policy
│   ├── cgroup v2 resource limits
│   └── sandboxed virtiofsd processes
└── Cloud Hypervisor microVM
    ├── pinned Linux kernel and rootfs
    ├── shared AWF guest supervisor
    ├── /workspace through virtio-fs
    └── agent command
```

Cloud Hypervisor exposes its lifecycle API over a Unix domain socket. AWF uses
the `/api/v1` endpoints needed to create, boot, inspect, shut down, and delete a
VM. Every API request has a bounded timeout and response-size limit.

## Host components

The implementation is divided into focused modules:

- `src/cloud-hypervisor-runtime-backend.ts` implements the external agent
  runtime contract, builds the credential-safe guest environment, probes Squid
  and the API proxy, executes the command, and preserves diagnostics.
- `src/cloud-hypervisor/manager.ts` orchestrates preflight, networking, rootfs
  preparation, VMM startup, virtio-fs, guest execution, and cleanup.
- `src/cloud-hypervisor/api-client.ts` implements the REST client over the Unix
  socket.
- `src/cloud-hypervisor/launcher.ts` builds the non-shell VMM command and
  computes Landlock rules.
- `src/cloud-hypervisor/vm-config-builder.ts` constructs the `vm.create`
  payload.
- `src/microvm/` contains shared network, workspace, VSOCK, guest-protocol, and
  artifact primitives.
- `guest/microvm-supervisor/` contains the shared guest supervisor.
- `guest/cloud-hypervisor/` contains Cloud Hypervisor artifact build and
  verification tooling.

## Runtime lifecycle

AWF performs these steps for each run:

1. Validate the runtime flags, security mode, topology, host eligibility, and
   required artifact paths and digests.
2. Verify Linux, x86_64, KVM, cgroup v2, Landlock, Docker, and required host
   tools.
3. Start the Squid and API proxy infrastructure through Docker Compose.
4. Create a dedicated network namespace, veth pair, TAP device, and nftables
   policy.
5. Copy the rootfs, inject the guest supervisor, and stage files in a private
   run directory.
6. Create a bounded cgroup v2 leaf and launch Cloud Hypervisor as the invoking
   non-root identity.
7. Start one sandboxed `virtiofsd` process for each validated export.
8. Create and boot the VM, connect to the guest supervisor over VSOCK, verify
   loopback plus the configured guest interface, address, and route, and probe
   each trusted infrastructure service with bounded retries. An exhausted
   retryable readiness failure recreates the VM at most twice before the agent
   command is dispatched.
9. Execute the agent command and propagate its exit code. Timeouts return
   `124`.
10. Sync and unmount guest filesystems, stop the VM and VMM, reap `virtiofsd`,
    and remove network, cgroup, and run-directory resources.

Cleanup is idempotent and aggregates errors so one cleanup failure does not
skip later cleanup steps.

## Security boundaries

### Host eligibility and artifact trust

The runtime accepts only GitHub-hosted Ubuntu x86_64 runners. Preflight verifies
the GitHub Actions environment markers, `/dev/kvm`, the KVM group, cgroup v2,
Landlock, and required tools before creating the VM.

AWF never downloads runtime artifacts automatically. You must provide the
Cloud Hypervisor binary, guest kernel, rootfs, supervisor, and `virtiofsd`
paths together with their expected SHA-256 digests. Preflight rejects missing,
mutable, incorrectly owned, or digest-mismatched artifacts.

:::danger[Fail-closed verification]
Do not bypass artifact verification. A substituted VMM, kernel, rootfs,
supervisor, or filesystem daemon runs inside a trusted part of the boundary.
:::

### VMM confinement

AWF launches Cloud Hypervisor through `ip netns exec` and `setpriv` without a
shell. The process:

- runs as the non-root identity recorded by `SUDO_UID` and `SUDO_GID`;
- keeps only the KVM supplementary group;
- sets `no_new_privs`;
- retains only `CAP_NET_ADMIN`, which the virtio-net TAP setup requires;
- uses Cloud Hypervisor's seccomp filter;
- receives a minimal Landlock filesystem allowlist; and
- belongs to a cgroup v2 leaf with explicit memory, CPU, and PID limits.

The private run directory is under
`/run/awf-cloud-hypervisor/<binary>/<runId>/`. Its per-run leaf is accessible
only to the selected non-root identity and root.

### Credential isolation

The API proxy is mandatory. Provider credentials remain in the host-side proxy
and are not copied into the guest environment. The guest receives only the
proxy endpoint and non-secret execution settings.

### Network egress

Each run uses deterministic, length-bounded resource names:

- namespace: `awfvm-<token>`
- host veth: `vmh<token>`
- namespace veth: `vmn<token>`
- TAP device: `vmt<token>`

The namespace connects the guest TAP to AWF's host-side infrastructure.
nftables permits only the required paths to Squid and the API proxy and denies
direct internet, arbitrary TCP, direct DNS, and instance metadata access.
Guest proxy environment variables improve client compatibility, but the
namespace policy is the enforcement boundary.

## Guest and workspace

The guest boots a pinned PCI-capable Linux kernel and deterministic BusyBox
rootfs. AWF injects the binary built from `guest/microvm-supervisor/` into the
per-run rootfs.

The workspace is a live read-write virtio-fs export mounted at `/workspace`.
Validated additional exports use separate sandboxed `virtiofsd` processes.
The workspace path is never exposed directly to the VMM process through its
Landlock rules.

Temporary microVM workspace data lives under:

```text
<workDir>/microvm-images/<runId>/
```

With `--keep-containers`, AWF preserves this directory, the network namespace,
and runtime diagnostics for investigation.

### Write-policy planning

[`src/cloud-hypervisor/filesystem-write-policy.ts`](../src/cloud-hypervisor/filesystem-write-policy.ts)
plans how a `filesystem.allowWrite` allowlist would narrow validated exports. It
maps each guest path to the canonical host path beneath the deepest matching
export, rejects `..`, missing paths, and symlink escapes, and classifies every
export as unrestricted, read-only, fully writable, or selectively writable.

Read-only enforcement is a host-side property. Each plan entry therefore carries
two modes: `hostRootMode`, the mode the host backing tree root is staged with —
the read-only bind that `virtiofsd.ts` already builds for read-only exports —
and `guestMountMode`, the flags of the guest virtio-fs mount. A selectively
writable export reports `hostRootMode: 'ro'` with `guestMountMode: 'rw'`:
mounting a composite tree read-only in the guest would also block its writable
nodes, because virtio-fs submounts are attached through `d_automount` and
`finish_automount()` calls
`do_add_mount(..., path->mnt->mnt_flags | MNT_SHRINKABLE)`, so an announced
submount inherits `MNT_READONLY` from its parent mount. The host VFS, not the
guest mount flag, denies writes outside the overlays.

Overlay paths are absolute but canonical in different senses: `guestPath` is
lexically normalized, while `hostPath` is realpath-canonical and verified not to
escape the export source.

The planner only removes write access: it never widens a read-only export and
never introduces a host path that an existing read-write export does not
already cover. It is pure policy planning; the host side of that boundary — how
a `hostRootMode: 'ro'` root with writable overlays is actually staged and
enforced — is described in
[Host mount-tree enforcement](#host-mount-tree-enforcement) below, and
[Runtime integration](#runtime-integration) describes how the two are joined.

## Host mount-tree enforcement

Cloud Hypervisor v53 and virtiofsd v1.10 expose no per-path read-only option, so
a mixed read-only/read-write export cannot be described to the guest, and a
guest-side read-only mount is not a security boundary. The only trustworthy
boundary is the host VFS.

This is the host-side counterpart to
[Write-policy planning](#write-policy-planning): the planner decides which
paths stay writable, and this layer stages a host mount tree that enforces it.

`VirtiofsdManager.start()` therefore accepts an optional, strongly typed
enforcement input:

```ts
interface VirtiofsdWritableOverlay {
  readonly source: string;      // canonical host path inside the export source
  readonly destination: string; // canonical host path inside the export source
  readonly kind: 'file' | 'directory';
}

interface VirtiofsdExportMountPlan {
  readonly tag: string;         // export tag the plan applies to
  readonly writableOverlays: readonly VirtiofsdWritableOverlay[];
}

interface VirtiofsdMountEnforcement {
  readonly plans: readonly VirtiofsdExportMountPlan[];
}
```

When the input is omitted, or no plan applies to an export tag, that export is
staged exactly as before, which is what makes partial enforcement possible. A
plan naming an export tag that does not exist is rejected outright: silently
dropping it would leave that export unrestricted read-write, so a renamed or
mistyped tag has to fail rather than downgrade. When a plan matches, the export
is served from a private staged mount tree under the per-run virtiofsd share
directory:

1. `mount --rbind <export source> <staged root>` — recursive bind, so nested
   host mounts are carried into the tree instead of being silently skipped.
2. `mount --make-rprivate <staged root>` — private propagation before anything
   writable exists, so neither the read-only attributes nor the later overlays
   can leak back into the host or the export's peer group.
3. Every mount in the staged tree is enumerated from `/proc/self/mountinfo` and
   remounted read-only one at a time, deepest-first, with
   `mount -o remount,bind,ro,nosuid,nodev <mount point>`. This happens before
   any overlay exists.
4. Each writable overlay is bound back in, shallowest first, with
   `mount --bind <source> <staged destination>` followed by
   `mount -o remount,bind,rw,nosuid,nodev <staged destination>`. Overlay binds
   are deliberately non-recursive, so a writable directory never exposes the
   submounts nested inside it, and the explicit remount sets the flags instead
   of inheriting whatever the source mount carried.

virtiofsd receives `--announce-submounts` for staged trees so the guest observes
each writable child bind as its own submount, and keeps its namespace sandbox,
`--seccomp=kill`, `--inode-file-handles=never`, and caching policy unchanged.
The guest mount itself stays read-write for a staged export; the host mount
flags are the enforcement boundary.

### Fail-closed behaviour

- libmount's `ro=recursive` option argument is deliberately **not** used.
  On util-linux 2.39.3 — the version on GitHub-hosted Ubuntu 24.04 runners —
  both `mount -o rbind,ro=recursive` and
  `mount -o remount,bind,ro=recursive` exit 0 while leaving carried-in submounts
  read-write, which would be a silent security failure. The per-mount remount
  loop was verified to work on the same host. A preflight check still requires
  util-linux >= 2.23 for `--make-rprivate`, so a non-util-linux `mount` fails
  with a clear error.
- After staging, and again after the overlays are applied, AWF parses
  `/proc/self/mountinfo` and requires that the staged root exists, that every
  mount under it is `ro` except the requested overlay destinations, that every
  mount carries `nosuid` and `nodev`, and that no mount in the tree carries a
  propagation peer (`shared:`, `master:`, or `propagate_from:`) — a slave mount
  would still receive mount events from its master.
  The mount tool's exit code is never the only evidence that enforcement
  succeeded — this verification is what caught the `ro=recursive` behaviour
  above.
- Overlay sources must be canonical (`realpath` equality), must resolve inside
  the export source, must not be symbolic links, and must match the declared
  kind. Overlay destinations must already exist, may not overlap each other, and
  an originally read-only export may not receive overlays at all.
- Overlay destinations are canonicalized before the bind and must satisfy
  `realpath` equality and containment under the staged root. `lstat` alone is
  not enough: it only reveals a symlink in the final component, while the kernel
  resolves every intermediate component when it binds. A `tools -> /etc` symlink
  carried in from the export would let destination `tools/sudoers` lstat as an
  ordinary file and then bind over the host's `/etc/sudoers`. The staged root is
  itself required to be canonical so that comparison is meaningful.
- The staged root must be disjoint from the export source, so the recursive bind
  can never nest the staged tree inside itself.

### Ordering and cleanup

Teardown reverses setup: writable children are unmounted deepest-first, then the
staged root is unmounted recursively (`umount -R`, because a recursive bind root
can carry submounts) and its staging directory is removed. A failed unmount
stays pending so a later `stop()` retries it. If staging fails part-way, the
partial tree is rolled back and the original failure is preserved; when rollback
itself fails, the residual tree is retained and retried during `stop()`.

### Residual limitation

Overlay destinations are canonicalized and validated inside the staged tree,
which is already recursively read-only and privately propagated, so they cannot
be swapped between validation and the bind. Overlay *sources* live in the
original, still-writable export, so a process that can already write to the
export could in principle replace a source path between validation and the bind. Sources are
re-validated immediately before each bind, and both the planner and this layer
require containment inside the export, but this residual setup-time TOCTOU window
cannot be closed without fd-based mount APIs that the current tooling does not
expose.

## Runtime integration

[`src/cloud-hypervisor/filesystem-write-enforcement.ts`](../src/cloud-hypervisor/filesystem-write-enforcement.ts)
is the only place where the planner and the host mount tree meet. The Cloud
Hypervisor runtime backend resolves and validates its exports, then plans the
policy in a dedicated `filesystem-write-policy` startup stage *before* the boot
loop, so an invalid allowlist aborts the run before virtiofsd or the guest is
ever launched, and before any retry can re-attempt it. The resulting
`VirtiofsdMountEnforcement` is threaded through `createManager()` into
`CloudHypervisorManager`, which forwards it to `VirtiofsdManager.start()`.

No `internalTags` are passed to the planner. Cloud Hypervisor has no analogue of
the Docker runtime's always-writable agent-log and session-state binds: every
export it publishes is host-visible workspace or runner state, and marking one
internal — `tmp-gh-aw` in particular — would defeat the narrowing that a policy
such as `allowWrite: ["/tmp/gh-aw/agent"]` exists to express.

The translation is total; there is no fallback path:

| Planner disposition | Guest mount mode | Host staged root | Mount plan passed to virtiofsd |
| --- | --- | --- | --- |
| policy absent (`undefined`) | unchanged | unchanged | none — `start()` receives no enforcement argument at all, so behaviour is byte-identical to a run without a policy |
| unrestricted / fully writable (`hostRootMode: 'rw'`) | `rw` | unchanged | none |
| fully read-only (`hostRootMode: 'ro'`, no overlays) | `ro` | `ro` | plan with zero overlays |
| selectively writable (`hostRootMode: 'ro'`, overlays) | `rw` | `ro` | plan with one overlay per allowed path |

A read-only export with zero overlays still gets a plan rather than falling back
to the legacy single `mount --bind` plus `remount,ro`. The staged tree is the
only variant that recursively remounts carried-in submounts read-only and
verifies the result against `/proc/self/mountinfo`, so a policy-narrowed export
is always served by the stronger path.

Because the host tree is the boundary, a selectively writable export is never
mounted read-only guest-side. The guest mode is derived from the plan, so
`validateCloudHypervisorExports()` accepts a read-only `workspace` export only
when a mount plan for the `workspace` tag actually exists; a read-only workspace
that nothing enforces is still rejected. Unknown plan tags remain fail-closed
via `assertPlansMatchExports()`, and the planner's own validation is not
duplicated here.

One consequence is worth stating plainly: the guest `HOME` is
`/workspace/.awf-home`, inside the workspace export. A policy that narrows
`/workspace` — including an empty `allowWrite: []` — makes the agent's home
directory read-only. That is the policy working as specified, not an oversight;
add the home path to `allowWrite` if the workload needs it.

Doing so has a prerequisite. The workspace export is backed by the host
workspace directory itself (`$GITHUB_WORKSPACE`, falling back to the current
working directory), and nothing in the Cloud Hypervisor path creates
`.awf-home` on the host before planning. That is harmless without a policy,
because the export is writable and the directory is simply created at runtime.
Under a narrowing policy the export root is staged read-only, so it can no
longer be created at runtime — and the planner only accepts paths that already
exist, so naming it in `allowWrite` fails too, with a single-line error:

```text
filesystem.allowWrite path is not an existing path within a writable
Cloud Hypervisor export: /workspace/.awf-home
```

AWF deliberately does not auto-create or exempt the guest home: doing either
would either widen the boundary implicitly or reintroduce an always-writable
internal mount, both of which contradict the narrowing semantics above. Create
the host directory before AWF starts, then list the guest path:

```bash
mkdir -p "$GITHUB_WORKSPACE/.awf-home"
```

```yaml
filesystem:
  allowWrite:
    - /workspace/.awf-home
```

That yields a `selective` workspace plan — host root staged `ro`, guest mount
`rw`, one directory overlay at `.awf-home` — leaving the rest of the workspace
read-only.

## Limitations

The preview rejects configurations that weaken or conflict with its boundary,
including:

- self-hosted, non-Ubuntu, non-x86_64, or non-KVM hosts;
- remote Docker daemons;
- TTY mode;
- Docker-in-Docker agent execution;
- topology peers;
- unsupported host mounts; and
- enclave combinations not supported by the external runtime contract.

Selecting Cloud Hypervisor never falls back to Docker, gVisor, or sbx.

## Part 14 — CI workflow

`.github/workflows/test-cloud-hypervisor.yml` provides deterministic build and
live-KVM jobs.

The build job:

1. builds the pinned Cloud Hypervisor binary, Linux kernel, BusyBox rootfs,
   shared guest supervisor, and `virtiofsd`;
2. verifies source and output digests;
3. attests provenance; and
4. uploads the `cloud-hypervisor-test-x86_64` workflow artifact.

The live job runs only when explicitly enabled by workflow dispatch or the
`cloud-hypervisor-kvm` pull-request label. It executes
`scripts/ci/cloud-hypervisor-live-smoke.sh`, which validates:

- allowed HTTPS and blocked domains;
- direct-egress, arbitrary-TCP, DNS, and metadata denial;
- API proxy reachability and secret non-disclosure;
- workspace persistence;
- `filesystem.allowWrite` enforcement — an allowed directory and file write
  persisting to the host, sibling/parent/create/truncate/rename/delete denial
  outside the allowlist, an empty allowlist narrowing the whole workspace, and
  a fail-closed abort on an allowlist entry that matches no export path;
- exit-code, timeout, and cancellation behavior;
- device assumptions;
- partial-start and normal cleanup;
- preserved-state behavior; and
- uid, capabilities, `no_new_privs`, seccomp, cgroup, Landlock, and VM-device
  security assertions.

After each case, the suite checks for leaked `awfvm-*` namespaces,
`vmh*`/`vmn*`/`vmt*` interfaces, cgroups, and Cloud Hypervisor processes.

## Troubleshooting

### Preflight rejects the host

Confirm the job runs on a GitHub-hosted Ubuntu x86_64 runner and that KVM is
usable:

```bash
uname -m
test -r /dev/kvm && test -w /dev/kvm
stat -c '%A %U %G %n' /dev/kvm
```

The runtime intentionally rejects self-hosted runners even if they expose KVM.

### Inspect preserved resources

Run with `--keep-containers`, then inspect the namespace and interfaces:

```bash
sudo ip netns list | grep '^awfvm-'
sudo ip -o link show | grep -E ' (vmh|vmn|vmt)[0-9a-f]{12}[:@]'
sudo nft list ruleset
```

Inspect preserved workspace data under
`<workDir>/microvm-images/<runId>/` and VMM diagnostics under the run's
preserved log directory.

:::caution
Preserved namespaces and processes continue consuming host resources. Remove
them only after collecting the diagnostics you need.
:::

### Guest network readiness timeout

If the guest network readiness check times out (error:
`guest-network-not-ready`), loopback or the configured guest interface,
address, and default route did not become ready before the bounded phase
timeout. AWF cleans up and recreates the Cloud Hypervisor VM up to two times,
with 5-second and 10-second delays, before failing. The wrapped command is
never dispatched during these recovery attempts.

1. **Guest image mismatch** — The guest supervisor contract requires loopback to be brought up before opening the VSOCK listener. A mismatched or incompatible guest image may violate this ordering.
2. **Host system issue** — Delays in kernel, KVM, interface, address, or route initialization may exhaust all automatic recovery attempts.
3. **Supervisor crash** — The guest supervisor may have crashed before initializing networking. Check preserved guest logs under `<workDir>/microvm-images/<runId>/` for supervisor output.

Each failed attempt preserves diagnostics under
`<workDir>/diagnostics/cloud-hypervisor/boot-attempt-<n>/` (or the equivalent
`auditDir` path). Verify the recorded interface and route state, guest image
digest, and supervisor version before retrying the AWF invocation.

### Guest cannot reach Squid or the API proxy

Check the namespace nftables rules, TAP state, and Squid/API proxy health. The
guest must not have a direct route to the internet; fixing connectivity by
loosening the default-deny policy would break the security boundary.
Squid, API proxy, and topology-peer probes retry independently inside the same
VM; an exhausted transient failure then enters the bounded pre-agent boot
recovery described above.

### VMM boot fails with TAP permission errors

Verify the launcher retained only `CAP_NET_ADMIN`, the TAP belongs to the
expected namespace, and the Landlock allowlist includes the TAP's
`/sys/class/net/<tapName>` directory read-only.

## Related documentation

- [Architecture](./architecture.md)
- [Integration tests](./INTEGRATION-TESTS.md)
- [Configuration specification](./awf-config-spec.md)
- [Docker Sandboxes integration](./sbx-integration.md)
- [gVisor integration](./gvisor-integration.md)
