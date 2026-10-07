---
title: Cloud Hypervisor architecture
description: Architecture, security boundaries, artifacts, networking, lifecycle, CI, and troubleshooting for the Cloud Hypervisor microVM preview.
---

Cloud Hypervisor runs the primary agent in a hardware-isolated microVM while
AWF keeps Squid and the API proxy in Docker Compose on the host.

This document covers that one-VM-per-run primary-agent runtime. The distinct
separately gated one-VM-per-enclave-invocation design keeps the enclave MCP broker
host/container-side; see
[ADR 0002: Cloud Hypervisor enclave executor](adr/0002-cloud-hypervisor-enclave-executor.md).

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
- `src/cloud-hypervisor/network-namespace.ts` creates and removes the empty,
  per-run network namespace used by no-network script-enclave workloads.
- `src/microvm/` contains shared network, workspace, VSOCK, guest-protocol, and
  artifact primitives.
- `guest/microvm-supervisor/` contains the shared guest supervisor.
- `guest/cloud-hypervisor/` contains Cloud Hypervisor artifact build and
  verification tooling.

For workspace-less script enclaves, the generated guest command line includes
`awf.network-mode=none` instead of workspace and guest-interface arguments.
The supervisor rejects mixed network/workspace arguments, mounts only the
declared virtio-fs exports, and opens its VSOCK listener without configuring
guest networking.

## Runtime lifecycle

For the primary-agent preview, AWF performs these steps for each run:

1. Validate the runtime flags, security mode, topology, host eligibility, and
   required artifact paths and digests.
2. Verify Linux, x86_64, KVM, cgroup v2, Landlock, Docker, and required host
   tools.
3. Start the Squid and API proxy infrastructure through Docker Compose.
4. Create a dedicated network namespace, veth pair, TAP device, and nftables
   policy.
5. Copy the rootfs, inject the guest supervisor, and stage files in a private
   run directory.
6. Allocate a random-named, dedicated per-run system account, grant its
   host-assigned uid/gid temporary access only to KVM/TUN, the pre-created TAP,
   staged files, and required sockets, then launch Cloud Hypervisor under that
   identity in a bounded cgroup v2 leaf.
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
    remove network, cgroup, and run-directory resources, revoke device ACLs,
    and delete the exact per-run account.

Cleanup is idempotent and aggregates errors so one cleanup failure does not
skip later cleanup steps. Before the first privileged per-run resource is
created, AWF atomically writes a root-owned mode-`0600` recovery record under
`/run/awf-cloud-hypervisor/pending-cleanup/`, itself a root-owned mode-`0700`
directory. The record contains the owning AWF PID, `/proc` start time,
executable identity, exact resource names, and immutable inode/ifindex
identities captured immediately after each attested artifact snapshot,
namespace, interface, run directory, cgroup, VMM, and `virtiofsd` process
becomes live. The host bridge-forwarding
rule is tagged with a per-run iptables comment and recorded by its exact tuple,
so concurrent runs do not share an anonymously owned rule. Dedicated VMM
account and device-ACL intent is persisted before `useradd`
or `setfacl` runs. Recovery validates the account's random name, run-specific
passwd metadata, numeric uid/gid, and exact numeric ACL entries before removing
them.
Any staged virtio-fs bind mounts are recorded by mount ID, device, root, target,
filesystem type, and source; stale recovery revalidates and unmounts them
deepest-first before removing their inode-validated share directory.
The backend deletes the shared verified-artifact snapshot before completing
each successfully cleaned manager record, including failed boot attempts.

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

### No-network script-enclave profile

The script-enclave workload profile selects `network.mode: none`. Trusted
host-side planning derives one run-scoped empty network namespace and launches
the VMM inside it, but creates no NIC, TAP, veth pair, bridge attachment,
address, route, DNS configuration, nftables service rule, Squid dependency, or
API-proxy/mcpg path. The VM payload omits `net`, the guest command line omits
interface/address/gateway arguments, and the VMM receives temporary access to
`/dev/kvm` but not `/dev/net/tun`.

The cleanup record represents this as a namespace-only resource rather than
fabricating primary-agent interface fields. Namespace teardown is bounded and
idempotent, including partial startup before VM creation.

### Agent-enclave network profile (storage prerequisite required)

The agent-enclave plan uses the dedicated, internal `awf-enclave-agent` bridge,
never `awf-net`. Host-side Docker network inspection verifies the fixed
subnet, local internal bridge and exact peer membership (including the
compiler-handoff mcpg container identity when configured) before resolving its
bridge interface. The plan selects only the configured engine's dedicated API
proxy port at `172.31.0.30` and, when GitHub access is configured, the
compiler-owned mcpg data-plane port 8080 at `172.31.0.40`. Neither mcpg's
delegation-control listener nor any other port is admitted. The caller cannot
provide a bridge, peer address, route, DNS server, TAP name or firewall rule.

The VMM would join a per-run host network namespace with a TAP and veth
attached to that verified bridge. Its host-namespace nftables forward chain
defaults to drop, checks guest MAC and source IP, rejects DNS and host/link-local
destinations, and accepts only the selected destination/port pairs; matching
SNAT rules permit replies. This boundary applies even when guest software
ignores proxy variables. The existing reservation and durable cleanup record
track the namespace, veth, TAP and scoped bridge rule for rollback and
idempotent teardown. Cloud Hypervisor enclave selection uses the trusted host
executor, with a production hard-bounded storage provider on eligible hosts.
Unavailable storage or host prerequisites reject admission before staging,
network, or VM side effects.
The optional `AWF_TEST_ENCLAVE_NETWORK=1` Jest integration test exercises
permitted and denied TCP packets across this host nftables boundary on a
privileged Linux host with working network namespaces and veth forwarding.

### Enclave virtio-fs layouts (storage prerequisite required)

Script and agent enclave exports are derived from the authenticated host
executor's trusted run state and invocation plan. The plan accepts no path, tag,
guest target, or permission from the broker. It resolves the selected static
seed under the run's seed directory and the invocation's fixed child
directories; all sources must already exist as canonical real directories.
Planning creates no directories or mounts, so path or policy validation fails
before filesystem side effects.

Both roles receive the selected seed at `/input-seed` and the immutable
invocation request at `/input-request`, both host-enforced read-only. Each role
gets only its own `/output` and `/runtime` directories as writable exports.
Agent enclaves additionally receive only the distinct
`/session-handoff` and `/session-state` directories as writable exports; the
parent invocation directory, delegation-control files, and executor state are
never exported. No enclave export uses or synthesizes `/workspace`. Guest
mount-tree overrides are rejected for enclaves, so guest cooperation cannot
widen an export's host-enforced mode. Export tags, targets, counts, and modes
are closed per role, with duplicate and overlapping targets rejected.

The primary-agent layout remains the existing `/workspace` layout. The internal
host executor derives these enclave exports; user-facing script- and
agent-enclave VM launches remain fail-closed while the trusted aggregate
writable-storage provider (#9394) is unavailable.

### Enclave resource profiles (storage prerequisite required)

The host creates one immutable resource profile from the workload role; the
broker protocol, guest environment, and arbitrary launch metadata cannot set or
raise these fields. The role budgets are:

| Limit | Script | Agent |
| --- | ---: | ---: |
| Cloud Hypervisor guest RAM | 768 MiB | 768 MiB |
| Guest vCPUs | 1 | 1 |
| Host CPU quota | 500 milli-CPU | 500 milli-CPU |
| Guest process limit (`RLIMIT_NPROC`, UID 65534) | 47 | 47 |
| Per-file limit (`RLIMIT_FSIZE`) | 512 MiB | 256 MiB |
| Open files (`RLIMIT_NOFILE`) | 1024 | 1024 |
| Role work tmpfs | `/query`, 256 MiB | `/tmp`, 96 MiB |
| Additional tmpfs | `/tmp` 16 MiB, `/run` 16 MiB, `/dev/shm` 32 MiB | `/home/awf-enclave` 32 MiB, `/run` 16 MiB, `/dev/shm` 32 MiB |
| Aggregate invocation storage ceiling (including artifacts and VM state) | 1 GiB | 512 MiB |
| Guest UID/GID | 65534:65534 | 65534:65534 |

The VM receives exactly the profile's vCPU count and memory. The host cgroup
applies a matching 50000/100000-µs CPU quota to the VMM and its virtio-fs
processes; the guest sees one logical vCPU, while its total host scheduling rate
is capped at half a CPU. Host cgroup memory includes 256 MiB of VMM/device
overhead above guest RAM. Primary-agent runs continue to use their existing
Cloud Hypervisor options and cgroup headroom.

Before the VSOCK listener starts, the guest supervisor mounts each required
tmpfs with `nosuid,nodev` (and `noexec` for the role-work, temporary, and home
filesystems), then
verifies the mounted filesystem type and maximum capacity. It applies and reads
back the process, file-size, and open-file rlimits. The guest root disk is opened
read-only by Cloud Hypervisor and booted `ro`; the fixed virtio-fs export plan
provides the only other write locations. Agent guests bind the writable
`/runtime` export at `/agent` (`nosuid,nodev`), the invocation-private runtime
root the agent entrypoint expects; boot fails if that export is missing or
read-only. Enclave boot lines that declare a primary workspace device, mount,
or `workspace` export are rejected. Script and agent requests must use the
profile's fixed UID/GID. The supervisor clears supplementary groups and drops
all capabilities except `CAP_SETGID` and `CAP_SETUID`, which its trusted
launcher needs to transition the child identity. Capabilities, the bounding
set, and `no_new_privs` are per-thread kernel state, so the cgo-free supervisor
applies each change to every Go runtime thread and verifies every entry under
`/proc/self/task` before serving requests. After the identity transition, the
execution trampoline verifies UID/GID, empty groups, empty effective,
permitted, inheritable, and ambient capability sets, the restricted
`CAP_SETGID`/`CAP_SETUID` bounding set, rlimits, and `no_new_privs` on every
thread before `exec` of workload code. `no_new_privs` prevents the workload from gaining
privileges through executable metadata. Missing mounts, unsupported kernel
controls, or verification mismatches abort startup rather than launching
without a limit.

The trusted host executor mounts one invocation-private Linux **tmpfs** at
`/run/awf-cloud-hypervisor/enclave-storage/<vmRunId>`, with `size=1073741824` for scripts (1 GiB) or
`size=536870912` for agents (512 MiB). The production provider routes artifact
snapshots, rootfs preparation and staging, VM run paths, and the closed writable
virtio-fs exports through this single allocation domain. Request and handoff
files also consume its budget. Executable artifacts use a sealed read-only view;
writable state uses `nosuid,nodev,noexec`. These views share one tmpfs
superblock, not independent capacity limits. Linux charges allocated pages
atomically, including concurrent writes and writes into sparse-file holes;
allocation beyond the aggregate ceiling returns `ENOSPC`.
Artifact and rootfs pages reduce the capacity available to workload writes.
An artifact set or prepared image that cannot fit fails closed with the same
ceiling; AWF does not enlarge the profile to accommodate it.
Sparse logical lengths do not allocate pages and do not bypass the allocation
limit. No disk quota, loop device, or guest-only `size=` limit is required, so
the mechanism uses the supported GitHub-hosted Linux/KVM runner's existing
mount/virtio-fs path. Guest-internal tmpfs ceilings remain separate.

Host-only invocation mount points live under
`/var/lib/awf-cloud-hypervisor/host-invocations/<runId>/<entryId>/<invocationId>`,
not the broker's `/var/tmp` work directory. AWF validates every ancestor as a
root-owned, non-writable real directory without making a sticky-directory
exception. Each mount point binds the allocation domain's `state` directory;
it is not a second allocation. Empty mount-point directories and durable
control journals contain no workload or artifact bytes. Admission rejects
primary-agent mounts exposing these paths, the allocation roots, or recovery
journals.

Host tmpfs pages are charged to the writing virtio-fs process's memory cgroup.
The enclave-only host `memory.max` therefore includes the fixed storage ceiling
in addition to 768 MiB guest RAM and the existing 256 MiB VMM overhead:
2 GiB for scripts and 1.5 GiB for agents. This avoids preempting the storage
ceiling with the old shared-cgroup budget; it does not enlarge guest RAM or add
a configurable resource limit. Host memory exhaustion can still terminate an
invocation rather than return `ENOSPC`, and is treated as executor failure.
Primary-agent cgroup budgets are unchanged.

Before staging inputs and again before starting virtio-fs daemons, AWF verifies
canonical export paths, the exact invocation mount in `/proc/self/mountinfo`,
its tmpfs type, private mount identity, mount options, and exact role capacity
from `statfs`. This is verification of a kernel-enforced backing store, not
a free-space preflight. Missing, undersized, oversized, aliased, nested, or
unverifiable mounts abort startup. There are no caller-selectable storage paths,
sizes, classes, overrides, or fallback to the runner filesystem.

The existing durable host-executor resource journal records the underlying
directory before mounting and captures the tmpfs mount identity before use.
Completion, timeout, cancellation, and partial startup wait for outstanding
provisioning and VM/virtio-fs teardown before ordinary (never lazy) unmount and
directory removal. Abandoned-run recovery first reaps the VM cleanup record,
then verifies recorded directory/mount ownership and removes invocation storage.
Unmount or ownership-verification failure retains the recovery record, reports
incomplete cleanup, and keeps admissions closed; it never deletes through a
live mount.

`src/cloud-hypervisor/enclave-storage.integration.test.ts` exercises the actual
host backing paths served by the closed writable exports, including role-sized
aggregate `ENOSPC`, sparse and concurrent writes, invocation isolation, and busy
unmount failure. It also fills storage in the production host cgroup budget while
holding the guest-RAM equivalent resident, with swap disabled, to check that
storage exhaustion is not preempted by a cgroup OOM. Run it as root in a private mount namespace with
`AWF_TEST_ENCLAVE_STORAGE=1 npm test -- --runInBand enclave-storage.integration.test.ts`.
The gated `host-probes` job in `.github/workflows/test-cloud-hypervisor-enclaves.yml`
runs this suite and `enclave-trusted-storage.integration.test.ts` via
`sudo unshare --mount --propagation private`.
Live guest transport conformance additionally requires the release-attested role
artifacts and KVM runtime wiring.

The rootfs build removes package-manager executables, the importable `pip` and
`ensurepip` modules (so `python3 -m pip` cannot run or be recreated),
setuid/setgid files, and file capabilities before creating either role image.
The build executes each image's Python to confirm neither module resolves, and
the verifier checks required supervisor/runtime paths and the absence of those
modules in every Python library tree. The build also checks that no privilege
bits or file capabilities remain.

`TestEnclaveGuestLimitsLive` (run as root by the Cloud Hypervisor preview
workflow) applies the real agent-role tmpfs, rlimit, read-only root, and
all-thread privilege setup in a private mount namespace and launches a workload
through the execution trampoline. The workload must observe `ENOSPC` on each
bounded tmpfs, `EFBIG`, `EMFILE`, and `EAGAIN` at the file-size, open-file, and
process limits, `EROFS` on read-only storage, UID/GID 65534 with no groups, and
empty capabilities with `no_new_privs` on every thread. Booting enclave rootfs
images under KVM remains gated on runtime wiring. No runtime-required privilege exception is
allowlisted. These profiles and guest controls do not enable Cloud Hypervisor
enclave execution by themselves. Runtime selection now connects the host-owned
listener and broker adapter to the one-shot VM backend using unchanged protocol
v2. The host must first supply the trusted storage provider from #9394 and pass
supported-host/artifact preflight. Production installs that provider on eligible
hosts; unsupported hosts still fail explicitly without runtime fallback.
An authenticated broker startup probe uses `status` for an unknown
invocation; it launches no VM and introduces no new protocol operation.

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
`/var/lib/awf-cloud-hypervisor/trusted-artifacts/`. That root must be on an
exec-capable filesystem: AWF resolves its mount and fails closed before copying
anything when the mount carries `noexec`, instead of surfacing an opaque
`EACCES` from the later `--version` probe. Enclaves instead stage the snapshot in
their invocation-owned allocation domain, using an executable read-only view of
the same bounded superblock. Run-level enclave preflight verifies immutable
copies in short-lived, journaled, role-bounded preflight domains, including the
temporary manifest/bundle files used for role attestation. Role rootfs, provenance,
and SBOM inputs are captured into root-private bounded storage before hashing
and attestation, with each role copy removed before staging the next. These domains close
before listener startup; no unbounded shared snapshot remains. Attestation,
parsing, digest checks, and executable version probes use the sealed copies,
never mutable original paths. Invocation copies are verified again against the
attested digests before launch. Verification and execution use
only that snapshot, preventing caller-controlled path replacement between
checking and use. Rootfs snapshot, writable preparation, and run staging
preserve sparse ext4 holes so the trusted copies do not multiply the image's
logical size into host disk exhaustion. The local bundle
avoids a GitHub API lookup. `gh` may still need network access to initialize or
refresh Sigstore trust-root material unless that material is already cached or
provisioned on the runner. Missing, mutable, incorrectly owned, renamed, or
digest-mismatched artifacts fail closed.

The separately gated enclave executor uses a distinct, release-attested artifact
set. `enclave-script-rootfs.ext4` and `enclave-agent-rootfs.ext4` are derived
from the audited `enclave-script` and `enclave-agent` container stages,
respectively, and do not replace `rootfs.ext4` for the primary agent. Their
closed enclave manifest binds each role, canonical filename, logical size,
digest, fixed uid/gid, entrypoint, source-image digest, SBOM, architecture, and
Cloud Hypervisor/kernel/supervisor compatibility. Each rootfs and the manifest
have separate offline provenance bundles.

`setup-cloud-hypervisor-enclave-artifacts.sh` downloads that set for an exact
release tag, verifies the release-workflow identity with
`gh attestation verify --deny-self-hosted-runners`, verifies manifest metadata,
size, digest, and SBOM bindings, and then atomically installs the cache entry.
An existing cache entry is fully reverified before reuse; an invalid entry is a
terminal error and is never silently replaced. The script exports the
role-specific `AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS` and
`AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS` paths through `GITHUB_ENV`.
The host-side artifact preflight, one-shot VM backend, authenticated broker
dispatch, and per-run runtime wiring are implemented. Production execution
uses the trusted bounded-storage provider (#9394) on eligible hosts and remains
fail-closed when it is unavailable.
Live conformance must exercise the integrated boundary against the
[ADR 0002 supported-host real-KVM security matrix](adr/0002-cloud-hypervisor-enclave-executor.md#supported-host-real-kvm-validation)
as the separate live-VM acceptance step. Custom enclave image overrides remain
unsupported.

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

- runs as a random `awfvmm-<token>` system account allocated for that run,
  independently of `SUDO_UID` and `SUDO_GID`;
- has no home, login shell, or supplementary groups;
- receives temporary uid-specific ACLs for `/dev/kvm` and `/dev/net/tun`;
- owns only its run directory, staged VMM files and sockets, and TAP;
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
only to the dedicated VMM identity and root. Account allocation and deletion
are serialized by an owner-token lock that validates both PID and process start
time before reclaiming stale state, preventing PID reuse from stealing a live
lock. Cleanup validates the exact account uid/gid before deletion and revokes
only that run's ACL entries, so concurrent sibling runs remain untouched.

The guest command still uses the invoking workspace uid/gid. That guest
identity is carried separately through the supervisor protocol and is never
reused as the host VMM identity.

### virtiofsd confinement

AWF launches the pinned `virtiofsd` binary as root because its namespace
sandbox must create the export mount tree, unshare namespaces, and pivot its
worker root. Root launch is not treated as proof that the sandbox succeeded.
Before any virtio-fs socket is included in the Cloud Hypervisor VM
configuration, AWF verifies the live parent and worker through `/proc`:

- the parent PID still has its launch-time start value, trusted executable, and
  exact socket, export, sandbox, seccomp, and uid/gid translation arguments,
  with no `--xattr`, `--xattrmap`, `--posix-acl`, `--security-label`, or `-o`
  option;
- parent and worker UIDs/GIDs match the reviewed root namespace identity;
- every parent capability set is empty, while the worker effective and
  permitted masks equal the pinned minimal virtiofsd set, its inheritable and
  ambient sets are empty, and its host bounding set remains empty after
  entering the user namespace;
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

### Guest uid/gid squashing in exports

The guest supervisor runs as guest root, so a compromised agent that reaches
guest root must not be able to choose host file ownership inside writable
exports. Before v1.13, virtiofsd applied guest-requested owners verbatim and
performed guest-root operations as its own host-root identity, so guest root
could create host-root-owned files or `chown` files to any host uid/gid.

AWF therefore pins virtiofsd v1.13.3, built from the pinned upstream source
(crates.io `virtiofsd-1.13.3.crate`, digest-pinned, upstream commit
`bbf82173682a3e48083771a0a23331e5c23b4924`, `cargo build --release --locked`
with a pinned Rust toolchain; the manifest records the tag, commit, crate and
`Cargo.lock` digests, toolchain, and binary digest). Every export is launched
with:

```text
--translate-uid=squash-guest:0:<workspace uid>:4294967295
--translate-gid=squash-guest:0:<workspace gid>:4294967295
```

The workspace uid/gid is the same non-root identity AWF passes to the guest
agent. Every guest uid/gid used to create a file or assign an owner, including
0, maps to that single host identity, so guest-root creates land as the
workspace user and `chown` cannot forge host ownership; the runner user can
always modify or delete what the guest left behind. The host-to-guest
direction is not translated, so `stat` in the guest still shows real host ids.
AWF fails closed before launch if the workspace uid or gid is unresolved, 0,
or out of range, and the post-launch command-line verification rejects a
daemon whose live arguments lack either translation.

virtiofsd itself still runs as host root; translation is applied inside the
daemon and does not need a user namespace, `newuidmap`, or subuid ranges. The
reviewed sandbox assertions are unchanged against v1.13.3: with
`--inode-file-handles=never` the worker still holds exactly `CHOWN`,
`DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID`, `MKNOD`, and `SETFCAP`
(`00000000880000db`) with an empty bounding set, `NoNewPrivs: 1`, and seccomp
filter mode `2`, while the parent holds no capabilities.

Translation does not cover extended attributes, and upstream documents it as
incompatible with `--posix-acl`. AWF never passes `--xattr`, `--xattrmap`,
`--posix-acl`, `--security-label`, or legacy `-o` options, so the guest cannot
set `security.*` or `trusted.*` xattrs such as file capabilities on host
files. Both the argument builder and the post-launch command-line check
enforce this invariant.

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

Cloud Hypervisor v53 and virtiofsd v1.13 expose no per-path read-only option, so
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

If runner eligibility or runtime preflight detects an unsupported host capability,
such as an ineligible runner, missing KVM access, or unsupported host policy, AWF
warns and falls back to the standard Docker backend. It does not fall back to
gVisor or sbx. Invalid Cloud Hypervisor configuration and artifact trust,
integrity, digest, or version failures remain fatal.

## Part 14 — CI workflow

`.github/workflows/test-cloud-hypervisor.yml` provides deterministic build and
live-KVM jobs.

The build job:

1. builds the pinned Cloud Hypervisor binary, Linux kernel, primary-agent
   rootfs, shared guest supervisor, `virtiofsd`, and distinct hardened script
   and agent enclave rootfs images;
2. verifies source and output digests;
3. generates role-specific enclave SBOMs and attests the primary archive, each
   enclave rootfs, and both manifests; and
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

### Enclave conformance evidence and remaining live gate

`.github/workflows/test-cloud-hypervisor-enclaves.yml` separates deterministic
enclave contract tests from privileged host probes. Ordinary PR CI exercises the
real broker handler, authenticated Unix host protocol v2, schema validation,
information ledger, settlement, and lifecycle using a **mock VM manager**. It
tests both static roles, invalid/oversized/non-UTF-8 output, storage rejection,
partial startup, guest failure, simulated OOM/timeout, cancellation, recovery
without replay, and cleanup-before-settlement. Audit calls and the actual host
journal are checked for raw-output/error sentinels. Artifact tests verify the
release signer/repository arguments for the manifest and both role rootfs
subjects; fixture attestations are not evidence of a real release signature.

Privileged probes require either dispatch with `run_host_probes: true` (default
false) or the `cloud-hypervisor-enclave-conformance` PR label. The job requires
the production GitHub-hosted Ubuntu x86_64 eligibility check, opening the KVM
character device as the privileged orchestrator, and a writable cgroup v2
hierarchy. A missing prerequisite after opt-in fails the job; it does not skip,
fall back to Docker, grant the runner user KVM access, or relax limits.

These probes exercise the real role-sized host tmpfs stores (script 1 GiB,
agent 512 MiB), aggregate sparse/concurrent ENOSPC across snapshots, prepared
and staged rootfs, manager state and exports, memory-cgroup accounting,
busy-unmount failure, and invocation isolation. They check executable/read-only
artifact views, `noexec` state, and dead-owner recovery that refuses a replaced
mount and preserves no-replay tombstones. They also send real TCP packets
through the agent nftables boundary and execute the supervisor's guest-limit
probe in a private host mount namespace. They **do not boot an enclave VM**,
exercise the broker in a VM, or establish preview readiness. No repository is
staged and no raw guest/seed logs are uploaded; only synthetic test evidence is
printed. The existing primary-agent KVM smoke is not enclave conformance and
its development artifact bypass must not be reused for enclaves.

Full issue [#9395](https://github.com/github/gh-aw-firewall/issues/9395) acceptance
remains a separate live-VM gate after implementation PRs
[#9397](https://github.com/github/gh-aw-firewall/pull/9397) and
[#9398](https://github.com/github/gh-aw-firewall/pull/9398) merged:

| Required boundary | Current implementation evidence |
| --- | --- |
| Production storage admission | `prepareEnclaves()` supplies the trusted production provider on eligible GitHub-hosted Ubuntu x86_64 KVM/cgroup-v2 hosts. Unsupported hosts retain the existing admission error before seeds, runtime probes, listener, or VM creation. |
| Aggregate invocation storage | One invocation-owned tmpfs superblock enforces script 1 GiB or agent 512 MiB across snapshots, rootfs copies, runtime state, and writable exports. Sparse and concurrent writes share the kernel allocation ceiling, which remains enforced until successful close. |
| Snapshot allocation and executable artifacts | Invocation-local executable artifact staging is sealed read-only and shares allocation accounting with `noexec` writable state. Release attestation, digest verification, and launch confinement remain mandatory. |
| Writable VM and preparation state | Trusted dependency hooks derive rootfs preparation, staged disk, manager run paths, and virtio-fs staging within the invocation domain; no independent runner-filesystem copies are used for enclaves. |
| Recovery ownership | Durable journals capture invocation-owned mount/device/inode identities. Recovery reaps VM resources first and refuses changed identities or uncommitted mount intents; it never replays work or uses a global bind mount. |

An empty provider, a free-space check, an export-only tmpfs, or a mock manager
does not meet this contract. The gated privileged storage probes exercise the
production domain, including aggregate exhaustion across snapshots, rootfs,
runtime state, and exports. They do not establish live VM acceptance.

The integrated privileged storage suite must pass on an eligible Linux runner.
Until that gated job runs successfully, deterministic coverage is not a
substitute for those probes.

The separately opted-in `live-kvm` job now provides a real broker-to-VM
acceptance path. It requires the package-matched GitHub release's signed Cloud
Hypervisor manifest/bundle and signed script/agent rootfs manifest, then uses
the production artifact preflight and storage provider. It invokes both static
executor tools through the public `/mcp/awf-enclave` HTTP route and requires
canonical bounded results. The script guest reports and the harness checks
UID/GID, seed read-only enforcement, no NIC/direct egress, privilege and
capability drop, `no_new_privs`, and the configured process/file/open-file
limits. Synthetic guest stdout/stderr sentinels are checked against AWF,
gateway, broker, audit, proxy, and host-executor journal diagnostics. Diagnostic
files are opened without following symlinks, checked and read through the same
descriptor, and read within a hard bound even if they grow during inspection. This
acceptance job is manually dispatched with `run_live_kvm: true`, distinct from
the host-only probes, and is not enabled in ordinary CI or by PR labels; this
avoids passing the Copilot credential to untrusted pull-request code.

The job is not evidence of passing live acceptance until it runs successfully
on the eligible GitHub-hosted Ubuntu x86_64 KVM/cgroup-v2 runner.
`main`'s package version `0.23.1` is intentional: the release workflow bumps
package/lock versions in a tag-only commit rather than updating protected
`main`. Published `v0.28.31` has package version `0.28.31`, but predates the
live acceptance follow-up. Acceptance must check out a future published tag
containing the reviewed implementation, build that tag's package, and use only
its artifacts. The release gate fails before the Copilot secret is introduced
on `main`, PR branches, or tags missing the pinned acceptance commit. It must
not use newer artifacts for older packages, local build artifacts, or an
unattested-artifact switch. The supported release pipeline must publish the
package-matched Cloud Hypervisor archive, manifest and Sigstore bundle, plus
the enclave rootfs manifest/bundle, role rootfs images, SBOMs, and provenance
bundles. Both manifests must name the checked-out release commit.

The live harness checks the agent guest UID/GID, capability and privilege
drop, `no_new_privs`, process/file/open-file limits, the permitted API-proxy
peer and port, and denial of other proxy ports, peers, GitHub MCP, and public
egress.
Both script (1 GiB) and agent (512 MiB) guests must produce actual guest-visible
aggregate `ENOSPC` within a write bound no larger than their configured role
ceiling; the probe removes its files before returning a canonical result. A
guest memory-pressure probe requires an increased guest `oom_kill` counter and
the memory-consuming child to exit by `SIGKILL`. The harness also requires
canonical guest-failure and timeout responses, aborts a public request only
after its guest has reached a marker, waits for resource cleanup, and kills an
identified VMM plus the AWF host process to verify that restart cleans the
exact pending journal identity without replaying a successful result.

`scripts/ci/cloud-hypervisor-enclave-startup-faults.js` adds a host-only partial
startup probe without changing production APIs or introducing CLI/config/env
controls. It uses the existing trusted storage dependency boundary to provide
an API client that calls the real VMM, then raises a fixed error immediately
after `vmCreate` (inside `manager.start()`) or `vmBoot` (inside
`manager.startInstance()`). Both script and agent roles use the real production
storage provider, artifact preflight, manager, and authenticated broker-to-host
protocol v2 client/server. These startup probes do not use the public MCP route
and never reach workload execution or make model requests.

The fault selector and callback are closures owned by the acceptance host,
not files, guest inputs, environment hooks, or broker fields. The normal CLI
never imports this module. Before raising the fault, the probe requires pending
invocation and VM journals with live VMM/virtio-fs, network, cgroup, storage,
mount and snapshot identities. It requires a terminal executor failure with
no result, identity-preserving cleaned journal metadata (allowing the
explicitly released snapshot mount), removal of recorded paths, and rejection
of replay after settlement. Attested artifacts are not changed; role storage
limits remain script 1 GiB and agent 512 MiB. Deterministic tests establish
transport ordering and evidence rejection only, not privileged cleanup or VM
acceptance. Neither those tests nor a successful host-only probe establishes
full issue
[#9395](https://github.com/github/gh-aw-firewall/issues/9395) acceptance.
This conformance work is a follow-up to
[#9395](https://github.com/github/gh-aw-firewall/issues/9395),
[#9399](https://github.com/github/gh-aw-firewall/pull/9399), and
[#9441](https://github.com/github/gh-aw-firewall/pull/9441); it does not claim
that #9395 or the prior pull requests established these live assertions.

### Explicit enclave acceptance dispatch

This is a manual, secret-bearing operation requiring separate maintainer
authorization. Creating the follow-up PR does **not** authorize release
publication or acceptance dispatch.

1. Merge the reviewed acceptance changes, then separately authorize the
   [supported release workflow](releasing.md) on `main`. Wait for the complete
   signed artifact set to be published. Do not infer a version or use `latest`.
2. Set `RELEASE_TAG` to that exact published tag and `ACCEPTANCE_COMMIT` to the
   full reviewed follow-up SHA recorded in the PR. Verify the tag contains that
   SHA and `scripts/ci/cloud-hypervisor-enclave-startup-faults.js`. The workflow
   enforces both checks with a full-history checkout, and requires tag/package
   equality. Existing `v0.23.1` lacks the assets; `v0.28.31` predates the
   acceptance changes. Neither is an acceptable substitute.
3. Confirm `COPILOT_GITHUB_TOKEN` is configured as a repository secret and
   usable for the configured Copilot model. After explicit authorization,
   dispatch **both** gates in the same run:

```bash
RELEASE_TAG='<exact-published-tag-containing-the-reviewed-follow-up>'
ACCEPTANCE_COMMIT='<full-reviewed-follow-up-commit-SHA>'
gh workflow run test-cloud-hypervisor-enclaves.yml \
  --repo github/gh-aw-firewall --ref "$RELEASE_TAG" \
  -f run_host_probes=true -f run_live_kvm=true \
  -f acceptance_commit="$ACCEPTANCE_COMMIT"
gh run list --repo github/gh-aw-firewall \
  --workflow test-cloud-hypervisor-enclaves.yml --event workflow_dispatch --limit 5
# Select the run for that exact tag; then inspect all three jobs.
gh run view '<run-id>' --repo github/gh-aw-firewall
```

Keep the PR draft until deterministic conformance, privileged host probes, and
live broker-to-VM acceptance all pass on the supported GitHub-hosted
Ubuntu 24.04 x86_64 KVM/cgroup-v2 runner. A skipped job is not acceptance.
The live job must include the two-role startup probes, resource cleanup,
crash recovery without replay, and redaction assertions. A primary-agent
Cloud Hypervisor smoke run is not enclave acceptance. macOS cannot validate
the privileged mounts or KVM boundaries. Failure diagnostics remain private
on the ephemeral runner; guest output and credentials are not uploaded.

### Public enclave environment probe dispatch

The same workflow has a distinct, false-by-default `run_environment_probe`
input. Its `environment-probe` job runs only the script-only public
[environment probe](../examples/enclave-environment-probe/README.md) through
`scripts/ci/cloud-hypervisor-enclave-environment-probe.js`. It reuses the live
harness's release-asset setup, gateway fixture, AWF launch, startup diagnostics,
readiness waits, and cleanup, but configures no agent executor or API proxy and
receives no Copilot or model secret; only the job's `github.token` is used for
release metadata and public seed staging. It does not depend on the full
acceptance or host-limit jobs, yet repeats their release, host, and artifact
prerequisites: the release gate runs with `--environment-probe`, so the
published package-matched tag must contain `acceptance_commit`, the
startup-fault harness, the probe harness, and the probe example. Both
downloaded manifests must name the checked-out tag commit, and the runner must
be an eligible GitHub-hosted Ubuntu 24.04 x86_64 KVM/cgroup-v2 host.

After AWF reports actual host gateway readiness, the harness requires the
public tool list to be exactly `enclave_run_script` and submits the request
generated by `build-request.py` (the `probe.py` source is never executed on the
host). It prints one `AWF_ENCLAVE_ENVIRONMENT_PROBE_RESULT` line only for a
canonical `status: ok` result that validates against the probe's finite schema
within 8192 bytes. A canonical error, invalid result, or earlier startup
failure fails the job; startup failures emit only the sanitized
`AWF_HOST_STARTUP_DIAGNOSTIC` metadata. Nothing is uploaded, and private AWF
logs are removed.

`v0.28.37` and earlier predate the probe (#9499) and its integration, so they
are ineligible. After a future authorized release whose tag contains both:

```bash
RELEASE_TAG='<exact-published-tag-containing-the-probe-integration>'
ACCEPTANCE_COMMIT='<full-probe-integration-commit-SHA>'
gh workflow run test-cloud-hypervisor-enclaves.yml \
  --repo github/gh-aw-firewall --ref "$RELEASE_TAG" \
  -f run_environment_probe=true \
  -f acceptance_commit="$ACCEPTANCE_COMMIT"
```

The probe cannot execute until host startup and broker readiness succeed, so
existing startup failures can still prevent guest execution.

### Standard enclave startup checklist

Every enclave-enabled AWF startup runs an always-on, versioned checklist before
the primary agent can start; this is not controlled by the optional CI host
probe. `enclaveStartup.startupChecks` has schema version 1, a cumulative
`checks` map keyed by `scope/check-id`, and an overall `ready` boolean. Each
map value is the fixed tuple `[result, reason]`. The list preserves earlier
storage and trust outcomes when connectivity starts, and resets for each new
startup instead of inheriting prior success. The primary-agent startup hook
requires every applicable check to pass. Only explicitly configuration-dependent
checks can be `not-required`; required checks cannot be skipped.

The common checklist covers configuration, enabled runtime availability,
private storage isolation, directory layout, run identity, seed catalog and
private capability custody, network enforcement, Compose configuration,
infrastructure service startup, gateway identity and exclusive network membership,
actual MCP initialize/initialized/exact-tools proof, optional GitHub route
attachment/readiness, and optional dynamic admission. A gateway handshake
alone is not overall readiness. The existing guest isolation controls remain
per-invocation controls; this host startup checklist does not claim guest
boot, guest DNS, data-plane connectivity, or workload execution.

`src/cloud-hypervisor/host-preflight-schema.json` is the canonical catalog of
check IDs, optional checks, and safe reason codes, shared by AWF and the
diagnostic harness. New prerequisites must be added there, instrumented at
their actual fail-closed operation, and covered by failure-injection and
readiness-blocking tests. There must not be a second, ad-hoc implementation
of a prerequisite or an inferred pass from stderr. The deterministic enclave
suite exercises the catalog, workflow gate, storage and gateway origins, safe
serialization, and exact bounds on every PR.

### Fine-grained host preflight diagnostics

The optional `enclaveStartup.hostPreflight` record identifies the checks AWF
actually executes, not guesses derived from stderr. Its schema version is 1;
`scope` identifies the currently executing group. Each fixed check ID has a
`result` of `not-attempted`, `not-required`, `attempted`, `passed`, or `failed`,
plus an allowlisted `reason` (`none` unless
failed). Later unexecuted checks remain `not-attempted`; checks skipped by a
different code path are not claimed to have passed. The canonical plans and
reason allowlist are in `src/cloud-hypervisor/host-preflight-schema.json`,
shared by AWF and the harness.

| Scope | Actual prerequisite checks |
|---|---|
| `startup` | Common lifecycle gates and overall readiness before primary-agent startup |
| `enclave-runtime` / `enclave-storage` | Enabled runtime prerequisites and the private seed/storage/capability staging gates |
| `gateway-attachment` / `gateway-handshake` | Compiler contract, container identity, network attachment/membership, and actual bounded MCP requests and tool contract |
| `host-isolation` / `provider-selection` | Recovery-journal, invocation, and allocation-root isolation from primary-agent mounts; missing trusted storage provider |
| `storage-admission` | Root UID, existing GitHub-hosted eligibility helper, Ubuntu distribution, effective mount capability, kernel tmpfs support, KVM access/device/open, writable cgroup hierarchy, and CPU/memory/PID controllers |
| `bounded-runtime` | Configured role, mount/umount lookup, invocation directory trust, journaled aggregate storage allocation/mount/private-propagation/layout/verification, artifact configuration/trust/snapshot/attestation/digests/versions, each required host tool, platform/architecture, KVM access/group, root/kernel controls/cgroup v2, Docker daemon and Compose |
| `artifact-snapshot` | Actual staging root validation, directory creation/identity capture, per-artifact copy and chmod, directory mode, mount intent/bind/identity capture, read-only executable remount, and sealed aggregate storage verification |
| `storage-mount-capture` | Snapshot mount canonical path, actual mount-table read/parse, exact match count, filesystem/source validation, and each durable journal commit operation |
| `bounded-cleanup` | Identity-journaled storage close, captured invocation directory release, and journal completion; original failure evidence is retained if cleanup also fails |
| `bounded-artifacts` | The same bounded allocation and invocation checks, rsync lookup, verification directory, and enclave artifact verification (distinct from runtime preflight) |

`bounded-runtime/artifact-snapshot` remains the enclosing gate.
`bounded-runtime/snapshot-journal` identifies preparation of the recovery
journal before any snapshot directory is created. Within `artifact-snapshot`,
`vmm`, `virtiofsd`, `kernel`, `rootfs`, `supervisor`, `manifest`, and `bundle`
each have separate `-copy` and `-mode` checks. A successful copy is not a
sealed artifact: `readonly-exec` and `sealed-storage` must also pass before
attestation, digests, or execution. `partial-remove` is not required after a
successful copy; after a failed copy it records actual partial-directory
cleanup. Disabled development-only manifest/bundle copies are explicitly not
required. No source metadata, file contents, paths, or command output are
included in these check records.

`artifact-snapshot/mount-capture` now publishes the nested, required
`storage-mount-capture` scope. Its successful checks eliminate hypotheses
**at that capture**, not for every future invocation. No diagnostic retry,
alternate namespace, mount selection, or cleanup bypass is introduced.

| Hypothesis | Discriminating evidence | Coverage |
|---|---|---|
| Stacked or repeated bind | `match-count` fails with `storage-mount-multiple`; exactly one matching mount passes | Injected duplicate entries and real Linux stacked binds |
| Path or namespace mismatch | `canonical-path` rejects canonical-path divergence; a mount absent from the reader's namespace fails `match-count` with `storage-mount-missing` | Injected canonical/missing paths; real symlink-resolving mount and isolated child mount namespace |
| Wrong backing filesystem or source | Separate `filesystem` / `source` checks fail with `storage-mount-filesystem` / `storage-mount-source` | Injected foreign identities, real disk-backed bind, and foreign tmpfs source |
| Mount-table read or parse failure | Separate `mountinfo-read` errno and `mountinfo-parse` / `mountinfo-malformed` checks | Injected read/malformed-table failures, escaped paths and unknown optional fields, plus real Linux mount-table reads |
| Journal persistence failure after valid capture | All identity checks pass; the failing `journal-*` check identifies staging open/write/file sync/close, publication, directory sync, or staging removal | Per-operation errno injection, durable-intent recovery rejection before publication, and a real successful fsync/rename commit |

A zero match alone does not distinguish a namespace mismatch from an absent
mount; it is not a namespace diagnosis. Filesystem/source values and paths
are never exported. Later checks remain `not-attempted` when an earlier gate
fails; finalizers can still report their actually executed close/removal checks.
`bounded-cleanup/storage-close` distinguishes
`storage-identity-uncommitted` (including a pending mount capture),
`storage-mount-identity-changed`, and `storage-mount-unrecorded`. It does not
automatically adopt or unmount an unidentified mount.

The real mount tests are a separate step in the existing false-by-default
privileged host-probe job, before the broader storage/network suites. They
exercise production capture and journaling in a private Linux mount namespace,
not a guest VM or the released environment probe. Deterministic fault injection
can establish diagnostic discrimination, but cannot establish which condition
occurred on the failing hosted runner.

Filesystem exceptions retain only allowlisted errno classifications.
`mount-noexec` identifies an observed staging mount that rejects execution;
sealed verification distinguishes `storage-mount-options`,
`storage-path-changed`, and `storage-cap-changed`. The trusted rsync invocation
reports fixed exit classes: `rsync-file-io` (11), `rsync-partial-transfer` (23),
and `rsync-source-vanished` (24), otherwise `command-failed`. An rsync I/O or
partial-transfer exit does **not** prove `ENOSPC`; stderr is never parsed into
a checklist reason. Other unclassified failures remain `unknown`. If both
preparation and cleanup fail, the thrown error retains the original error as
`cause` and the cleanup exception as `cleanupError`; both failing check
records survive. Cleanup never falls back to lazy unmount or releases an
unconfirmed active allocation.

The startup failure descriptor stays bounded to 16 KiB. If the cumulative
checklist plus a duplicate active `hostPreflight` scope exceeds that bound,
the writer omits the optional duplicate `hostPreflight`, retaining **every**
`startupChecks` entry and its schema version. It never truncates the catalog
or substitutes success for missing evidence.

For the public environment probe in
[run 37546226833](https://github.com/github/gh-aw-firewall/actions/runs/37546226833)
(v0.28.39), startup failed at artifact preparation before guest execution.
The published enclave manifest records script/agent rootfs logical sizes of
127,422,464 / 1,026,367,488 bytes, respectively. The main runtime archive's
tar header records `rootfs.ext4` at 1,314,160,640 bytes; that main runtime
image is also staged before enclave-specific verification. These are
**logical sizes**, not allocated bytes. The role-sized aggregate caps remain
1 GiB (script) and 512 MiB (agent), including artifacts and writable state.
Sparse copying can fit an image whose logical size exceeds its cap, so neither
the manifest sizes nor the compressed archive size establishes exhaustion.
The failed subcheck and its reason are the next discriminating evidence;
the root cause remains unconfirmed. See the
[published manifests and archive](https://github.com/github/gh-aw-firewall/releases/tag/v0.28.39).

In [run 37554009561](https://github.com/github/gh-aw-firewall/actions/runs/37554009561)
(v0.28.40), artifact copies and the bind passed, while mount capture and storage
close failed with unknown reasons; read-only sealing, gateway readiness, and
guest execution were not attempted. That immutable release does not contain
the nested capture diagnostics. A new release containing these checks and an
authorized release-pinned environment probe are required to distinguish the
five hypotheses on the original execution path.

### Snapshot bind topology evidence

The v0.28.41
[probe run 37562487508](https://github.com/github/gh-aw-firewall/actions/runs/37562487508)
identified `storage-mount-multiple`: canonical path and mount-table reading/
parsing passed, but more than one entry matched the snapshot directory. This
does not yet distinguish actual stacked mounts from repeated mount-table rows,
or explain which operation introduced them.

Snapshot startup now retains a bounded `enclaveStartup.mountTopology` record
with schema version 1, `bindCalls` (`zero`, `one`, `multiple`), and nullable
`before` / `after` observations. `artifact-snapshot/topology-before` reads the
table immediately before binding. `storage-mount-capture/mountinfo-topology`
derives the after observation from the **same table read** used by the
exact-one-match guard, before that guard can reject the mount. No second
post-bind read or retry can substitute a different observation.

Every observation contains only the fixed enums in
`src/cloud-hypervisor/mount-topology-schema.json`. It reports root/artifact-parent
propagation classes, whether those mounts share an overlapping local peer group,
whether peers outside the allocation are visible, zero/one/multiple snapshot
entries, unique/repeated/mixed snapshot IDs, and whether distinct snapshot IDs
form a parent stack. It never publishes mount IDs, peer IDs, device numbers,
namespace identities, paths, sources, filesystem contents, or raw optional
fields. `null` means not observed, not an inferred zero or private mount.

| Hypothesis | Evidence that can eliminate it for the observed bind | Remaining uncertainty |
|---|---|---|
| Local overlapping shared peers duplicate the nested bind | Root/artifact-parent `private`, or a known `not-shared` / `different-group` relation, excludes the specific same-group local mechanism | `same-group-overlap` is supporting topology, not proof of causation |
| Propagation from external peers/namespaces | Both root and artifact parent `private` exclude incoming propagation through those observed mounts | `visibleOutsidePeers: absent` covers only this namespace and cannot rule out peers in another namespace; a slave can receive events without a visible shared peer |
| AWF calls the same snapshot bind twice | `bindCalls: one` excludes repeated calls to this allocation's wrapper for that directory | Counts exclude other processes, other allocation instances, and extra syscalls inside the mount helper |
| Snapshot is already mounted before AWF binds | `before.snapshotEntries: zero` excludes a mount present at that observation | An external mount can still race between observation and bind |
| Duplicate rows rather than distinct kernel mounts | `after.snapshotIds: unique` excludes repetition of an identical mount ID within the captured table | `repeated` / `mixed` is not itself proof of a kernel bug; unknown topology stays unknown |

Before/after evidence survives the outer failure, subsequent cleanup scopes,
and omission of the duplicate active host-preflight scope. The complete
catalog plus maximum-size topology evidence is tested against the unchanged
16 KiB descriptor bound. A new startup clears the previous observations.
Missing or failed observation checks block readiness; no check selects a
topmost mount, deduplicates the table, changes propagation, or adopts an
unrecorded resource.

The opt-in Linux mount suite compares a minimal unisolated shared-parent
baseline against the actual production allocation, artifact-parent self-bind,
invocation bind, and snapshot sequence beneath private and shared synthetic
parents in separate private namespaces. Shared propagation is intentionally
enabled only inside the disposable test namespace. These tests are
host-topology reproductions, not live VM acceptance; they require a supported
privileged Linux runner and are not claimed to have passed from deterministic
mocks.

### Private invocation allocation propagation

The v0.28.42
[probe run 37566610268](https://github.com/github/gh-aw-firewall/actions/runs/37566610268)
reported zero snapshot entries before a single wrapper bind, followed by
multiple distinct mount IDs. Both the allocation root and artifact parent were
shared members of the same overlapping peer group, with outside peers visible.
That evidence supports local shared-peer propagation rather than repeated
wrapper calls or repeated identical rows; it does not alone exclude incoming
events from outside peers.

Production storage now breaks that propagation relationship at the freshly
mounted, identity-journaled invocation tmpfs **before** creating its layout or
any child bind. `storage-propagation-set` verifies the journal's exact mount
identity and executes `mount --make-private <allocation-root>`.
`storage-propagation` verifies the identity again and requires exactly one
mount-table entry with private propagation. Both are mandatory in
`bounded-runtime` and `bounded-artifacts`; an error, a successful no-op mount
command, missing/duplicate entries, or residual shared/slave/unbindable state
blocks setup before child mounts. Ordinary journal cleanup remains available
for the identity-known root if setup fails.

This is a non-recursive operation on a new, empty allocation, not on `/`,
`/run`, the shared storage parent, another invocation, or the whole host mount
namespace. It preserves the tmpfs mount identity, source, allocation ceiling,
and noexec/nosuid/nodev flags. Binds from that private domain remain private
only when the destination covering mount is also non-shared. Every later
storage-option verification also checks private
propagation on the allocation, invocation state, runtime/rootfs directories,
artifact parent, and sealed snapshot; a propagation change fails with
`storage-mount-propagation`. No duplicate is selected, deduplicated, or adopted,
and exact-one-match capture and identity-checked cleanup are unchanged.

The Linux regression suite asserts that the unisolated baseline has duplicate
distinct IDs, while fixed production snapshots have a single entry beneath
either parent mode, both root/artifact-parent observations are private, the
parent's original shared/private state is unchanged, and ordinary allocation
close succeeds. It is still opt-in and needs real privileged Linux execution.
A new release containing this fix and a release-pinned environment probe are
required to establish whether startup progresses beyond the original failure.
The immutable v0.28.39 and v0.28.42 assets are not patched by source changes or
workflow dispatches.

### Post-bind storage propagation evidence

The v0.28.43
[probe run 37571367739](https://github.com/github/gh-aw-firewall/actions/runs/37571367739)
passed setting and immediately verifying private allocation propagation, layout,
artifact/run binds, and the invocation bind. Later `bounded-runtime/storage-verification`
failed with `storage-mount-propagation`; all bounded cleanup checks passed.
Snapshot preparation, guest boot, and gateway readiness were not attempted.
There is no matching diagnosis-registry finding and no confirmed root cause yet.

The missing distinction is **which mount role** failed and whether the guard
saw non-private propagation, zero entries, or multiple entries. The guard's
aggregate reason covers all three. Journal identity verification had already
passed, so missing/duplicate-entry alternatives require a later change or
different table observation; they are less likely than destination inheritance.

The source and destination are not the same storage location. Production
`mountTmpfs` binds `<allocation>/state` onto the separately derived
`plan.invocationHostDir` under `run.invocationsDir`. Making the allocation
private does not make that external destination's covering mount private.
Linux's [shared-subtree bind semantics](https://docs.kernel.org/filesystems/sharedsubtree.html)
explicitly make a private-source clone shared when it is attached to a shared
destination mount. The kernel
[`attach_recursive_mnt()` implementation](https://github.com/torvalds/linux/blob/v6.8/fs/namespace.c)
tests the destination and calls `set_mnt_shared()` on the attached tree.
This kernel reference establishes the mechanism, not the probe's unrecorded
exact kernel version. A
[`remount,bind`](https://man7.org/linux/man-pages/man8/mount.8.html)
changes per-mount flags, not automatically its propagation class.

These are five hypotheses, ordered by code/semantic support, not five findings:

| Hypothesis | Diagnostic that can disprove it for the observed failure |
|---|---|
| Private state source is bound beneath a shared external invocation destination | A known non-shared `destinationBeforeBind`, or a unique private `invocationAfterBind`, excludes immediate shared-destination inheritance at that observation. A private source, shared destination, then one shared invocation entry supports it. |
| Allocation root regains non-private propagation after the initial private check | A unique private `rootVerified` from the failing verification table excludes root propagation as that guard's culprit. Compare `rootAfterPrivate` and `rootAfterLayout` for the interval of change; identities remain independently checked. |
| A local artifact/run/rootfs child bind or remount introduces non-private propagation | Unique private observations for all three local roles after layout and at verification exclude those roles. A private root with a non-private local child separates this from a changed root. Invocation after-bind/after-remount observations separately identify a helper-time transition. |
| The propagation reason actually represents ambiguous duplicate entries | One exact entry at the failed role excludes ambiguity. Multiple entries with unique IDs distinguish distinct mounts from repeated or mixed IDs, without selecting a topmost entry or blaming the kernel. |
| The expected exact entry is absent because of a late removal or path/view mismatch | An exact entry at the failed role excludes absence. Zero exact entries distinguish normalized-only spelling from no normalized match. This does not identify a symlink target, prove a namespace mismatch, or distinguish removal from a wrong view. |

Startup retains fixed-size `enclaveStartup.storagePropagation`, schema version
1. `invocationLocation` is only `inside`/`outside`; `sourceBeforeBind` and
`destinationBeforeBind` are propagation classes of the most specific visible
covering mounts immediately before binding. An ambiguous covering mount or
stacked ancestor is `unknown`; this observation never authorizes selection
among stacked mounts.
`null` means unobserved. Pre-bind observations cannot exclude a subsequent race.

`mounts` has exactly fourteen fixed slots: the root after the private check;
root/artifacts/runs/rootfs after local layout binds; invocation before bind,
after bind, and after remount; and root/invocation/runs/rootfs/artifacts/snapshot
at verification. Each non-null slot is a compact four-element tuple:

| Tuple position | Codes |
|---|---|
| 0: exact entry count | `0` zero, `1` one, `2` multiple |
| 1: propagation | `0` private, `1` shared, `2` slave, `3` shared-slave, `4` unbindable, `5` unknown |
| 2: mount-ID relationship | `0` none, `1` unique, `2` repeated, `3` mixed |
| 3: path-match relationship | `0` exact, `1` normalized-only, `2` absent |

Thus `[1,1,1,0]` means one exact shared entry; `[2,5,1,0]` means multiple
distinct-ID exact entries with no single propagation class. The canonical
allowlist and legend live in `src/cloud-hypervisor/storage-propagation-schema.json`.
No IDs, paths, namespace identifiers, device numbers, sources, raw rows,
stderr, or filesystem content are exported. A normalized-only observation
does not weaken the exact-match guard.

The nested `storage-verification` checklist identifies journal identity,
mount-table read/observation, and allocation-root, invocation-state,
run-storage, rootfs-preparation, artifact-parent, and sealed-snapshot checks.
The snapshot check is `not-required` only while no sealed snapshot exists.
All applicable mount-role checks still require private propagation and the
original mount options. Every verified role's evidence is derived **before
the first role guard from the same single read used by all role guards**;
no second read can replace the failed observation. If journal identity fails
first, the verification slots are reset to null: prior phase evidence is not
evidence of the failed identity-check table. Each verification attempt clears
all six verification slots before reading, so an unreadable/malformed later
table cannot inherit a previous successful observation.

Evidence survives cleanup and omission of the duplicate active scope, is
deep-copied, and resets on a new startup/allocation. Compact tuples keep the
full 188-check catalog and both evidence records inside the existing 16 KiB
descriptor limit. When the total would exceed the bound, only the duplicate
active scope and then the optional fatal-message text are replaced/omitted;
the complete cumulative checklist and evidence remain. No guard, storage cap,
trust requirement, propagation operation, or cleanup policy is relaxed.

The opt-in Linux suite now varies the allocation parent and **separate
invocation destination** independently, inside disposable private namespaces.
This closes the earlier fixture gap that left the invocation destination under
a private namespace while varying only the allocation parent. These tests do
not run on macOS and are not guest acceptance.

### Private invocation state mount

The v0.28.44
[probe run 37576714531](https://github.com/github/gh-aw-firewall/actions/runs/37576714531)
failed only `storage-verification/invocation-state` with
`storage-mount-propagation`; cleanup passed. The evidence was
`invocationLocation: outside`, `sourceBeforeBind: private`,
`destinationBeforeBind: shared`, `invocationBeforeBind: [0,5,0,2]`, and one
exact shared invocation entry (`[1,1,1,0]`) after bind, after remount, and at
verification. Root, artifacts, runs, and rootfs were unique private entries
after layout and at verification. That supports the first hypothesis and
disproves the other four for this failure.

Production `mountTmpfs` therefore keeps the identity-journaled bind, then
re-verifies the journal and executes non-recursive
`mount --make-private <invocation-state>` before the restrictive remount.
`invocationAfterBind` still records the inherited class, while
`invocationAfterRemount` must be one exact private entry; otherwise setup
fails with `storage-mount-propagation` and ordinary journal cleanup unmounts
the captured identity. The shared destination's covering mount, the host
namespace, and every other mount are left unchanged. As with any bind beneath
a shared mount, the kernel may already have propagated a copy to destination
peers at bind time; those copies keep the shared parent's unmount propagation
and are not adopted or selected.

A failed mount command remains a tool failure: a nonzero exit is reported as
`command-failed`, while an execution error retains its allowlisted errno (for
example, `EPERM`). `storage-mount-propagation` specifically reports a mount
command that succeeds but leaves the invocation mount shared, including a
subsequent remount that re-shares it.

The opt-in Linux shared-destination cases now expect the invocation to be
shared after bind, private after remount and at verification, a single-entry
sealed snapshot, an unchanged shared destination, and successful allocation
cleanup. A new release and release-pinned environment probe are required to
establish whether live startup progresses beyond this guard.

Host-tool failures distinguish `tool-not-found`, unsafe ancestor/file
symlink, ownership, write permissions, file type, and allowlisted access
errno such as `EACCES`, `EPERM`, or `ENOTDIR`. Version checks distinguish
`version-format`, `version-mismatch`, execution errno, and `command-failed`.
Unsupported errors stay `unknown`: messages, stderr/stdout, PATH values,
paths, hostnames, credentials, and repository contents are never copied into
the public subcheck record. Ownership, executable, digest, attestation,
mount, and eligibility requirements are unchanged; no fallback is introduced.
Nested failures can mark both an aggregate gate and its more specific child.

The original admission error is still the no-fallback storage-provider error,
with its cause retained privately. Before these subchecks, that one error
collapsed all admission failures. Private-root mount isolation also runs under
`host-preflight` before admission. The `v0.28.38` environment probe's
`host-preflight` / `not-attempted` failure therefore establishes no gateway
request or guest execution and does not establish which host requirement
failed. There is no matching diagnosis-registry finding for its specific cause.
A future authorized release containing this change, followed by the same
release-pinned environment probe, is needed to obtain that evidence.

The gated privileged `host-probes` job also executes the same production
admission method through
`scripts/ci/cloud-hypervisor-enclave-host-preflight.js`. It emits a bounded
`AWF_HOST_PREFLIGHT_PROBE` with perspective `preflight-harness`, passes or
fails explicitly, and does not allocate storage, expose a listener, or boot a
VM. This separate read-only observation cannot prove AWF passed admission,
gateway readiness, or guest success. Local macOS tests exercise rejection
and injected Linux prerequisites, not live eligible-Linux/KVM/mount behavior.

The acceptance harness also distinguishes actual AWF host gateway readiness
from broker health and its own independent MCP requests. Bounded schema-2
startup diagnostics identify earlier preflight/artifact/storage/recovery stages,
explicitly not-attempted readiness, and allowlisted DNS, connectivity, HTTP,
protocol, or readiness-deadline failures. A successful AWF initialize and exact
tools proof and complete startup checklist emit `AWF_HOST_GATEWAY_READINESS`
before harness requests begin (older records without a checklist retain their
handshake-only semantics).
This is a host-to-loopback Docker gateway observation, not CH guest DNS or
data-plane evidence. See [diagnostic fields and bounds](INTEGRATION-TESTS.md#unified-enclave-coverage).
The cause of the `v0.28.36` pre-broker exit remains unknown; immutable releases
cannot receive these diagnostics, and an authorized future release and eligible
live run are required to establish it.

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
