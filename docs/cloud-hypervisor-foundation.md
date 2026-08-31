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
7. After the API responds, verify the launched VMM's trusted host `/proc` and
   cgroup state. AWF fails closed before `vm.create` if the PID identity,
   executable, credentials, capabilities, `no_new_privs`, seccomp worker,
   network namespace, cgroup membership, or resource limits differ from the
   launch policy.
8. Start one sandboxed `virtiofsd` process for each validated export and verify
   its live confinement state from procfs.
9. Create and boot the VM, connect to the guest supervisor over VSOCK, verify
   loopback plus the configured guest interface, address, and route, and probe
   each trusted infrastructure service with bounded retries. An exhausted
   retryable readiness failure recreates the VM at most twice before the agent
   command is dispatched.
10. Execute the agent command and propagate its exit code. Timeouts return
   `124`.
11. Sync and unmount guest filesystems, stop the VM and VMM, reap `virtiofsd`,
    and remove network, cgroup, and run-directory resources.

Cleanup is idempotent and aggregates errors so one cleanup failure does not
skip later cleanup steps. Before the first privileged per-run resource is
created, AWF atomically writes a root-owned mode-`0600` recovery record under
`/run/awf-cloud-hypervisor/pending-cleanup/`, itself a root-owned mode-`0700`
directory. The record contains the owning AWF PID, `/proc` start time,
executable identity, exact resource names, and immutable inode/ifindex
identities captured immediately after each namespace, interface, run directory,
cgroup, VMM, and `virtiofsd` process becomes live. The host bridge-forwarding
rule is tagged with a per-run iptables comment and recorded by its exact tuple,
so concurrent runs do not share an anonymously owned rule. Any staged
virtio-fs bind mounts are recorded by mount ID, device, root, target, filesystem
type, and source; stale recovery revalidates and unmounts them deepest-first
before removing their inode-validated share directory.

Every subsequent Cloud Hypervisor startup reaps stale records before creating
its own resources. A record whose owner still has the same PID, start time,
executable inode, credentials, and network namespace is active and is skipped,
so concurrent sibling runs cannot reap one another. For an abandoned record,
AWF revalidates every existing resource and process immediately before acting.
It never treats a name or PID alone as ownership evidence: PID reuse, a changed
namespace/interface inode or ifindex, an uncommitted launch identity, malformed
state, or an unsafe record mode stops cleanup, reports an error, and preserves
the record and resources for diagnosis. The record is removed only after normal
teardown succeeds. `--keep-containers` is an explicit diagnostic opt-out: its
record is removed while the requested resources remain preserved.

## Security boundaries

### Host eligibility and artifact trust

The runtime accepts only GitHub-hosted Ubuntu x86_64 runners. Preflight verifies
the GitHub Actions environment markers, `/dev/kvm`, the KVM group, cgroup v2,
Landlock, and required tools before creating the VM.

AWF never downloads runtime artifacts automatically. Each AWF release publishes
one Cloud Hypervisor manifest and its GitHub artifact-attestation Sigstore
bundle alongside the artifact archive. The manifest records the release tag,
source commit, exact Cloud Hypervisor, `virtiofsd`, kernel, rootfs, and
supervisor versions, canonical filenames, and SHA-256 digests.

Preflight first verifies the manifest itself with the bundled attestation,
constraining the certificate identity to this repository's release workflow
and rejecting self-hosted signers. Only after that succeeds does AWF parse the
manifest, require its release tag to match both the operator's expected tag and
the running AWF version, and verify every local artifact. Before verification,
AWF copies the manifest, bundle, VMM, `virtiofsd`, kernel, rootfs, and
supervisor into a root-owned, non-writable snapshot under
`/run/awf-cloud-hypervisor/trusted-artifacts/`. Verification and execution use
only that snapshot, preventing caller-controlled path replacement between
checking and use. The local bundle
avoids a GitHub API lookup. `gh` may still need network access to initialize or
refresh Sigstore trust-root material unless that material is already cached or
provisioned on the runner. Missing, mutable, incorrectly owned, renamed, or
digest-mismatched artifacts fail closed.

:::danger[Fail-closed verification]
Do not bypass artifact verification. A substituted VMM, kernel, rootfs,
supervisor, or filesystem daemon runs inside a trusted part of the boundary.
:::

### Threat model and migration

The manifest prevents a caller from making a substituted artifact trusted by
supplying its matching hash. An attacker must instead compromise the protected
release workflow's GitHub OIDC identity or Sigstore verification chain. The
mechanism does not defend against compromise of the already trusted local
`gh` executable, host root, or the release workflow itself. AWF also rejects
validly attested manifests from older releases, preventing silent rollback
when the caller controls configuration.

For a release such as `v0.24.0`, download and extract
`cloud-hypervisor-test-x86_64.tar.gz`, then download:

- `cloud-hypervisor-test-x86_64.manifest.json`
- `cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl`

Replace the five `--cloud-hypervisor-*-sha256` trust arguments with:

```text
--cloud-hypervisor-artifact-manifest /trusted/manifest.json
--cloud-hypervisor-artifact-manifest-bundle /trusted/manifest.sigstore.jsonl
--cloud-hypervisor-artifact-release-tag v0.24.0
```

Ephemeral same-run development artifacts can use
`--cloud-hypervisor-development-allow-unattested-artifacts` only together with
`AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS=1` and all five
legacy hashes. This conspicuous dual opt-in is preview-only and unsuitable for
release or production use.

### VMM confinement

AWF launches Cloud Hypervisor through `ip netns exec` and `setpriv` without a
shell. The process:

- runs as the non-root identity recorded by `SUDO_UID` and `SUDO_GID`;
- keeps only the KVM supplementary group;
- sets `no_new_privs`;
- has empty inheritable, permitted, effective, bounding, and ambient capability
  sets;
- uses Cloud Hypervisor's seccomp filter;
- receives a minimal Landlock filesystem allowlist; and
- belongs to a cgroup v2 leaf with explicit memory, CPU, and PID limits.

API socket readiness alone is not treated as proof of confinement. Before
creating any VM or starting `virtiofsd`, AWF reads the VMM's host `/proc`
records and cgroup files as root. It verifies the PID twice using the kernel
start-time field and executable symlink to reject process-exit and PID-reuse
races. Credentials and capability sets are checked against the launcher's
current policy for every observed thread, and both the `vmm` worker and
`http-server` API thread must be in seccomp filter mode. The verifier also
compares network namespace inode links, requires exclusive membership in the
per-run cgroup, and checks the exact memory, CPU, and PID limits computed by the
cgroup policy.

Successful verification produces bounded structured evidence in
`confinement.json` alongside the other run diagnostics. The evidence records
the stable process identity, expected credentials and capabilities, relevant
seccomp thread IDs, namespace inode, and cgroup membership and limits; it does
not copy unbounded `/proc` content.

The private run directory is under
`/run/awf-cloud-hypervisor/<binary>/<runId>/`. Its per-run leaf is accessible
only to the selected non-root identity and root.

### virtiofsd confinement

AWF launches the pinned `virtiofsd` binary as root because its namespace
sandbox must create the export mount tree, unshare namespaces, and pivot its
worker root. Root launch is not treated as proof that the sandbox succeeded.
Before any virtio-fs socket is included in the Cloud Hypervisor VM
configuration, AWF verifies the live parent and worker through `/proc`:

- the parent PID still has its launch-time start value, trusted executable, and
  exact socket, export, sandbox, and seccomp arguments;
- parent and worker UIDs/GIDs match the reviewed root namespace identity;
- every parent capability set is empty, while the worker effective and
  permitted masks equal the pinned minimal virtiofsd set, its inheritable and
  ambient sets are empty, and its bounding set contains the capabilities
  needed during sandbox setup (rendered non-acquirable after `NoNewPrivs`);
- the worker has `NoNewPrivs: 1` and seccomp filter mode `2`;
- the worker mount, PID, and network namespaces differ from the host;
- the worker root inode is the inode of the declared export, proving the
  namespace sandbox pivoted to the intended tree;
- parent and worker belong only to the run's bounded cgroup v2 leaf; and
- parent and worker environments contain only `PATH`, `HOME`, `LANG`, and
  `LC_ALL`, with no inherited provider credentials or other host variables.

Any mismatch terminates all partially started daemons and aborts startup before
`vm.create`. The observations are written with mode `0600` to
`virtiofs-<index>-confinement.json` in the private run directory and copied into
the diagnostic bundle as
`virtiofs-<index>-<tag>-confinement.json`. When verification itself rejects
startup, AWF preserves the failure record under
`<workDir>/diagnostics/cloud-hypervisor/startup-<runId>/` before partial-start
cleanup removes the private run directory. This verification follows the
proven post-launch model from `agent-microvm` v0.9.0 rather than relying only on
`--sandbox=namespace` and socket existence.

### Credential isolation

The API proxy is mandatory. Provider credentials remain in the host-side proxy
and are not copied into the guest environment. The guest receives only the
proxy endpoint and non-secret execution settings.

### Network egress

Before creating network resources, each run acquires an OS-held `flock` on the
root-owned `0700` directory `/run/awf-microvm-network/`. While holding that
lock, AWF atomically chooses an unused `/30` guest subnet, bridge-side source
address, and random resource token after checking durable reservations plus
live namespaces, interfaces, addresses, and routes in every named namespace.
It writes a mode `0600` reservation containing
the kernel boot ID, owner PID, process start time, and a unique lease ID before
releasing the lock. The kernel releases the allocation lock automatically if
the allocator exits, so there is no stale lock file ownership protocol or
TOCTOU cleanup window.

Each reservation produces length-bounded resource names:

- namespace: `awfvm-<token>`
- host veth: `vmh<token>`
- namespace veth: `vmn<token>`
- TAP device: `vmt<token>`

Allocation is intentionally not deterministic: diagnostics record the selected
token, subnet, and reservation path in `network-plan.json`. This keeps incident
diagnostics reproducible without making concurrency depend on a hash collision
not occurring.

Cleanup removes only resources named by that run and deletes the reservation
only when its lease and process identity still match the durable record.
Per-run `DOCKER-USER` rules carry the reservation token in an iptables comment,
so one concurrent run cannot delete another run's otherwise-identical bridge
rule. A dead owner's reservation is reclaimed only after its boot/PID/start-time
identity is stale and none of its namespace, interfaces, or subnet routes
remain live.

The namespace connects the guest TAP to AWF's host-side infrastructure.
nftables permits only the required paths to Squid and the API proxy and denies
direct internet, arbitrary TCP, direct DNS, and instance metadata access.
Guest proxy environment variables improve client compatibility, but the
namespace policy is the enforcement boundary.

### Untrusted guest output

Guest stdout and stderr cross a host-side presentation boundary before AWF writes
them to the runner log. A streaming byte filter neutralizes lines that begin,
after optional runner-recognized leading whitespace, with GitHub Actions workflow-command
syntax such as `::set-output::`, `::add-mask::`, or `::stop-commands::`. The
filter operates across VSOCK frame boundaries, preserves non-command and
non-UTF-8 bytes, and retains only constant-size command candidates rather than
complete lines. It also neutralizes the runner's legacy `##[...]` command form
wherever it appears in a line. Output writes continue to honor stream
backpressure.

AWF intentionally has no workflow-command allowlist for guest output. Unlike a
trusted host helper, the guest cannot prove that an informational annotation
such as `::error::` came from a trusted producer, so allowing any command name
would preserve an unnecessary runner-control channel.

Filtering applies only to the live runner-facing stdout and stderr streams.
Internal readiness probes retain their original bytes and semantics. Before
filtering, AWF also captures the exact raw guest streams in bounded 1 MiB tails.
Diagnostic collection writes these private files with mode `0600`:

- `guest-stdout.raw.log`
- `guest-stderr.raw.log`

They are stored alongside the other Cloud Hypervisor diagnostics under the
configured audit directory, or under the work-directory diagnostics path when
no audit directory is configured. This preserves forensic evidence without
allowing raw guest bytes to reach the GitHub Actions command parser.

## Guest and workspace

The guest boots a pinned PCI-capable Linux kernel and deterministic BusyBox
rootfs. AWF injects the binary built from `guest/microvm-supervisor/` into the
per-run rootfs.

The workspace is a live read-write virtio-fs export mounted at `/workspace`.
The default `workspace-only` mount policy does not infer tool-cache exposure
from the host environment. Narrow gh-aw runtime directories
(`RUNNER_TEMP/gh-aw` and `/tmp/gh-aw`) remain eligible when present, and every
validated export uses a separate sandboxed `virtiofsd` process.
The workspace path is never exposed directly to the VMM process through its
Landlock rules.

Use `--cloud-hypervisor-mount-policy workspace-and-tool-cache` (or
`cloudHypervisor.mountPolicy: workspace-and-tool-cache`) only when the guest
must execute runner-installed tools. This explicit opt-in selects
`RUNNER_TOOL_CACHE`, falling back to `AGENT_TOOLSDIRECTORY`, requires the path
to be an existing real directory, and exports the entire selected directory.
AWF recursively stages and verifies that export read-only in a private host VFS
mount tree before launching virtiofsd, including any carried-in submounts;
guest mount flags alone are never treated as enforcement. The canonical cache
source must not equal, contain, or be contained by any writable export source,
so a second guest path cannot alias the cache with write access.

AWF removes `RUNNER_TOOL_CACHE`, `AGENT_TOOLSDIRECTORY`, and `RUNNER_TEMP` from
the inherited guest environment, then adds back only values backed by mounted
exports. It never scans a cache to decide whether exposure is safe.

:::caution[Preview migration]
Earlier preview builds automatically exported a present runner tool cache.
The secure default is now `workspace-only`. gh-aw-generated commands that scan
`RUNNER_TOOL_CACHE` must add
`--cloud-hypervisor-mount-policy workspace-and-tool-cache`; commands that do
not need cached runner tools require no migration.
:::

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
preserved log directory. `confinement.json` contains the production
post-launch verification evidence captured before `vm.create`.

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

Verify the TAP was pre-created with the VMM uid/gid and `vnet_hdr` in the
expected namespace, `/dev/net/tun` is accessible, and the Landlock allowlist
includes `/sys/class/net/<tapName>/tun_flags` read-only. Do not grant
`CAP_NET_ADMIN`; the VMM capability sets must remain empty.

## Related documentation

- [Architecture](./architecture.md)
- [Integration tests](./INTEGRATION-TESTS.md)
- [Configuration specification](./awf-config-spec.md)
- [Docker Sandboxes integration](./sbx-integration.md)
- [gVisor integration](./gvisor-integration.md)
