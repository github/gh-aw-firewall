---
title: NVX one-shot security design
description: Phase 1 security contract for a future opt-in NVX primary-agent backend.
---

# NVX one-shot security design

This document defines the Phase 1 security contract for evaluating NVX as an
AWF primary-agent microVM backend. It is a design contract, not an implemented
runtime.

The design is pinned to NVX release `v0.1.0-dev.d561c4300ebe`, commit
`d561c4300ebe854baba5d154056ead6f9d462047`, and OpenVMM commit
`0bc357bbcf3a654b63dfb51f1103c5751bf3d31f`.

## Decision: one-shot execution

AWF needs one long-lived agent command per sandbox invocation. The agent owns
its internal turns and child processes; AWF does not submit each tool call as a
separate guest execution.

The NVX backend will therefore use one-shot execution:

1. validate the host, policy, and trusted artifacts;
2. start AWF's host-side Squid and API proxy;
3. prepare immutable guest layers and a fresh writable scratch image;
4. launch one NVX microVM with the complete agent command;
5. stream filtered output and collect a structured outcome;
6. propagate the exit status; and
7. destroy all per-run resources.

NVX managed sessions and repeated `sandbox exec` requests are out of scope.
Their availability or failure does not gate an AWF NVX backend.

TTY execution, VM reuse between jobs, resume, snapshot/restore, and arbitrary
host-to-guest command injection are also out of scope.

## Security objective

Running an untrusted agent command through NVX must not give that command:

- provider or GitHub credentials;
- direct network egress that bypasses AWF policy;
- access to host paths not explicitly included in the guest image;
- host root, KVM, TAP, OpenVMM control, or cleanup authority;
- a runner-command injection channel through stdout or stderr; or
- the ability to retain host resources after the AWF process exits.

The guest kernel and OpenVMM isolate the workload from the host. AWF remains
responsible for artifact trust, host process confinement, network policy,
credential isolation, filesystem construction, output filtering, diagnostics,
and crash-safe cleanup.

Host root and a compromised GitHub Actions runner are outside this boundary.
Compromise of a trusted NVX, OpenVMM, kernel, initramfs, or guest-layer artifact
is also outside the runtime boundary, which is why provenance is mandatory.

## Trusted computing base

The initial trusted computing base contains:

- the AWF CLI and its privileged host launcher;
- the pinned OpenVMM binary;
- the NVX guest kernel and initramfs;
- AWF-produced EROFS layers and their source inputs;
- the host kernel's KVM, namespace, cgroup v2, Landlock, seccomp, and firewall
  implementations;
- Squid and the credential-holding AWF API proxy; and
- the minimal host tools used for launch, verification, and cleanup.

The agent command, guest scratch filesystem, workspace contents, guest output,
downloaded repository content, and model-generated instructions are untrusted.

## Required security contract

| Boundary | Phase 1 requirement | Owner |
| --- | --- | --- |
| Artifacts | Every launched byte is bound to an expected release, source commit, role, architecture, filename, size, and SHA-256 digest. Provenance is verified before use. | AWF |
| Artifact immutability | Verified inputs are copied into a root-owned, non-writable per-run snapshot before verification and launch. Caller paths are never executed directly after validation. | AWF |
| Host eligibility | Fail unless the host is supported Linux x86_64 with KVM, cgroup v2, required namespace/firewall features, and known-compatible NVX/OpenVMM versions. Landlock is required only when the selected OpenVMM release exposes a verifiable self-confinement contract. | AWF |
| VMM identity | OpenVMM runs as a random dedicated per-run system identity with no login shell, home, or supplementary groups. | AWF |
| Device access | Grant that identity temporary access only to the exact devices required by the selected NVX networking mode. Revoke the exact ACLs during cleanup. | AWF |
| VMM launch | Launch with an argument vector, never a shell. Set `no_new_privs`, empty all capability sets and supplementary groups, enter dedicated mount and network namespaces plus a bounded cgroup, and restrict host filesystem visibility to the staged run directory and required device nodes. | AWF |
| Live verification | Before treating the VM as ready, verify the VMM executable, PID start time, uid/gid, capabilities, seccomp state, namespace, cgroup membership, and configured limits from host kernel state. | AWF |
| Network | Host-enforced policy permits only the required paths to Squid, API-proxy ports, and explicitly configured control peers. Direct internet, metadata, arbitrary DNS, host loopback, ingress, and lateral traffic are denied. | AWF + NVX |
| Filesystem | Guest lower layers are immutable EROFS images. Each run receives a new private ext4 scratch image mounted `nosuid,nodev`. No host path is exposed implicitly. | AWF + NVX |
| Workload identity | The guest command runs as an image-defined non-root uid/gid with cleared supplementary groups, `no_new_privs`, and no capabilities. | NVX, verified by AWF |
| Credentials | Real provider credentials remain only in the host API proxy. The guest receives non-secret endpoint configuration and placeholder material only when required by the agent. | AWF |
| Resources | Memory, process, CPU, disk, file-size, and wall-clock limits are explicit and applied before the workload starts. Unsupported limits fail closed rather than being ignored. | AWF + NVX |
| Output | Treat serial output as hostile. Neutralize GitHub Actions workflow commands before writing to runner stdout/stderr and retain bounded raw evidence privately. | AWF |
| Outcome | Distinguish successful guest exit, nonzero guest exit, host launch failure, timeout, cancellation, signal termination, and missing outcome. Preserve the guest exit code; AWF timeouts return `124`. | AWF + NVX |
| Cleanup | Teardown is idempotent, ownership-checked, and attempts every cleanup stage even after an earlier error. Startup writes durable recovery state before privileged resources become live. | AWF |

## Artifact trust

The upstream release currently has a pinned archive checksum but no
GitHub-verifiable build-provenance attestation. A checksum fetched from the same
release location as the archive is integrity evidence, not independent
provenance.

Production or preview integration must use one of these fail-closed models:

1. upstream publishes attestations that bind the NVX release artifacts to its
   protected build workflow and source commit; or
2. AWF reproducibly builds and publishes an AWF-owned NVX artifact bundle with
   an AWF release attestation.

The manifest must bind NVX, OpenVMM, kernel, initramfs, base layer, agent layer,
and any host helper. Validly attested artifacts from an unexpected release,
commit, architecture, role, or filename are rejected to prevent rollback and
role substitution. Per-role size ceilings also bound pre-copy disk exposure.
The pinned 481,508,816-byte OpenVMM binary is limited to 512 MiB, while the
kernel and initramfs retain their separately bounded role limits.

Development-only artifacts may use a conspicuous dual opt-in plus complete
digests. They must never be accepted by default or silently replace failed
provenance verification.

## Phase 3d implementation status

Phase 3d provides an internal direct-OpenVMM launch executor; it still does not
register `nvx` as a selectable AWF runtime. The runtime name
`nvx` is reserved and rejected by the CLI/runtime resolution path so it cannot
silently fall through as a raw Docker runtime while live evidence is under
review.

Implemented boundary:

- a per-run NVX layout that derives trusted artifact snapshots, writable run
  state, cleanup records, cgroups, and network namespace names from the same
  canonical 32-character run ID;
- dedicated per-run VMM account allocation with `useradd --system
  --user-group --no-create-home --home-dir /nonexistent --shell
  /usr/sbin/nologin`, validation through `id`/`getent`, and deletion only after
  re-validating the account identity;
- serialized ACL-only device access for `/dev/kvm`, including
  recorded device/inode identity, uid-specific `rw-` ACL evidence, validation
  before launch, and exact revocation validation during cleanup;
- cgroup v2 setup for the run subtree with explicit `memory.max`, `cpu.max`,
  and `pids.max` writes followed by read-back verification and exact
  `cgroup.procs` membership checks;
- a no-TAP NVX network plan that runs OpenVMM in an AWF-owned namespace and
  enforces deny-by-default nftables output policy around portable Consomme host
  sockets, permitting Squid, enabled API-proxy ports, and explicitly configured control
  peers while denying arbitrary DNS, metadata/link-local, host gateway,
  infrastructure IP, unsolicited ingress, and lateral traffic. The matching
  OpenVMM policy uses default-deny plus exact `/32` endpoint allows; it does not
  add a catch-all deny rule that would override those allows or misuse
  `--network-proxy`, whose pinned ABI is only for guest-gateway-to-host-loopback
  translation;
- exact direct OpenVMM argv equivalent to the pinned `nvx.py sandbox run`
  implementation, including ordered sandbox blocks, workload identity,
  one-shot lifecycle, KVM, memory, kernel/initramfs, NVX-owned kernel command
  line, portable network policy, outcome report, and an initial paused state;
- a Bubblewrap `--block-fd` / `--json-status-fd` readiness gate. AWF records
  and cgroups the launcher and sandbox child before releasing Bubblewrap,
  discovers the exact OpenVMM executable from cgroup and procfs state, captures
  its mount namespace, and completes live confinement verification. Because
  the pinned OpenVMM initially routes stdin to the guest console, AWF clears
  the inherited environment, sets `TERM=dumb`, places OpenVMM's REPL state
  under the per-run writable directory with `XDG_STATE_HOME`, writes Ctrl-Q,
  waits for the exact flushed `openvmm> ` prompt, and only then writes `resume`
  to the REPL. The bounded Bubblewrap JSON status channel remains drained
  through EOF so final sandbox status cannot terminate Bubblewrap with
  `SIGPIPE`;
  and
- an explicit x86_64 cBPF seccomp denylist passed to Bubblewrap on inherited
  FD 5 before `setpriv` and OpenVMM execute. The filter rejects host-management,
  kernel-module, namespace-changing, cross-process-memory, keyring, BPF,
  performance, and privileged mount syscalls while leaving the KVM and
  Consomme syscall surface available; confinement verification requires every
  OpenVMM thread to report seccomp filter mode 2.
- shared one-shot validation, bounded workflow-command-filtered output,
  structured outcome parsing, timeout, cancellation, and signal semantics.

The live KVM validation workflow,
`.github/workflows/nvx-phase-3b-live-kvm.yml`, is deliberately opt-in for pull
requests via the `nvx-live-kvm` label (and always available through
`workflow_dispatch`). Phase 3d added probes for the direct constrained argv,
the Bubblewrap readiness FD contract, KVM-only device access, and no-TAP
namespace policy. Phase 3e adds workflow-attested artifacts and end-to-end
manager guest-boot and timeout-cleanup evidence. Phase 3f extends that same
production path with the remaining promotion evidence.

Configurations that cannot provide Linux x86_64 KVM, cgroup v2
`cpu`/`memory`/`pids` controllers, trusted host tools, or exact cleanup evidence
fail closed. Promotion to a selectable runtime requires reviewed live evidence
for complete guest launch, Copilot API-proxy inference, adversarial network and
filesystem probes, timeout/cancellation process-tree termination, stale
recovery, and concurrent-run isolation.

## Phase 3d internal manager boundary

The `NvxManager` orchestration boundary remains internal without adding an
`nvx` CLI option or runtime registration. The manager owns stale-record
reaping, creation of a pending cleanup record, artifact snapshot journaling,
dedicated-account and device-ACL observers, host network and cgroup setup,
construction of the constrained launch plan, launch-process hooks, live
confinement verification, and reverse-order cleanup. Cleanup records are
removed only after every cleanup stage succeeds; ambiguous identities and
cleanup failures retain the record for recovery.

The default dependency now uses the production direct executor. The broken flat
`nvx.py` launcher is no longer attested, copied, mounted, or invoked; the
artifact set is OpenVMM, kernel, and initramfs only. Injection remains available
for deterministic tests.

Promotion beyond this boundary still requires reviewed live KVM evidence for a
complete guest boot and exit, Copilot inference through the credential-holding
API proxy, adversarial network and filesystem probes, timeout/cancellation
cleanup, stale recovery, and concurrent-run isolation. Until that evidence is
accepted, `NvxManager` remains internal infrastructure only.

## Phase 3e live manager evidence

Phase 3e adds the first end-to-end live evidence lane for the production
`NvxManager` path without registering an external runtime:

- the release workflow downloads the pinned upstream NVX package, verifies its
  archive and internal checksums, stages only OpenVMM, the kernel, and the
  initramfs, generates the schema-v2 AWF manifest, and attests that manifest
  from the protected AWF release workflow;
- the opt-in live-KVM workflow creates an equivalent workflow-attested bundle
  for pull-request validation. Preflight accepts this only when the caller
  explicitly pins that exact validation workflow; the production default
  remains the release workflow and there is no unsigned fallback;
- the live runner builds a deterministic EROFS layer from a digest-pinned
  Alpine root, invokes the real `NvxManager`, and requires a successful guest
  boot, `/bin/true` execution, structured outcome, live confinement evidence,
  and residue-free cleanup; and
- a second manager invocation runs `/bin/sleep` with a bounded wall-clock
  timeout and requires exit `124` plus the same residue-free cleanup checks.

This evidence removes the attested-bundle and basic manager-boot blockers. It
does not by itself authorize runtime registration. Promotion still requires
reviewed Copilot API-proxy inference, adversarial network and filesystem
denials, cancellation, stale-recovery, and concurrent-run isolation evidence.

Executable immutable snapshots use the dedicated
`/var/lib/awf-nvx/trusted-artifacts` root because the Ubuntu host's volatile
`/run` mount is `noexec`. Writable per-run state and cleanup records remain
under `/run/awf-nvx`.

## Phase 3f promotion evidence

Phase 3f extends the opt-in live-KVM workflow without registering `nvx` as a
runtime:

- the workflow creates the fixed AWF infrastructure network and starts pinned
  Squid and API-proxy images in a dedicated secret-bearing setup step. The
  job-scoped GitHub credential has only the explicit `copilot-requests: write`
  permission needed for inference and is present only in that host step and the
  API-proxy container; the guest-layer assembly and manager execution step has
  no credential environment;
- the guest layer includes a pinned Copilot CLI and credential-free entrypoint
  that rejects provider/GitHub credential variables and common credential
  paths, places its runtime home, cache, config, and state only in the private
  bounded 1 GiB scratch overlay, sets only AWF's fixed non-secret
  GitHub-token-shaped placeholder and offline mode, and then completes
  authenticated inference through API-proxy port `10002`;
- adversarial guest entrypoints verify that direct internet and metadata
  connections remain denied, only the configured Squid/API-proxy endpoints are
  reachable, nested credential paths are excluded from the EROFS layer, no
  implicit host root is present, and writes land in the private scratch
  overlay;
- an abort signal must produce the distinct cancellation outcome and remove
  the complete VMM process tree and all per-run resources;
- a manager process is killed with `SIGKILL` only after its durable cleanup
  record reports a live launcher. A subsequent manager invocation must reap
  the identity-validated stale process, account, device ACL, cgroup, network,
  filesystem, artifact snapshot, and cleanup record before executing; and
- two managers are started concurrently with distinct run IDs and must receive
  distinct run directories, cgroups, and network namespaces, complete
  successfully, and leave no residue.

Successful reviewed Phase 3f evidence satisfies the remaining Phase 3
promotion gate. Runtime registration, the mandatory preview flag, configuration
surface, and external-backend adapter remain a separate change.

## Host OpenVMM confinement

Phase 0 observed `NoNewPrivs: 1`, seccomp filter mode, empty capability sets,
and an isolated network namespace. It did not establish AWF parity: OpenVMM ran
as the runner identity with KVM supplementary-group access, not a dedicated
per-run identity with ACL-only device access; it had no dedicated bounded
cgroup; and no Landlock or equivalent host-filesystem confinement was verified.

The NVX launcher must follow the Cloud Hypervisor post-launch verification
model:

1. create a root-owned private run directory and durable cleanup record;
2. allocate a random per-run VMM uid/gid;
3. stage trusted artifacts and create only the required sockets and files;
4. grant narrow uid-specific device ACLs after recording the intended identity,
   without retaining the host KVM group or any supplementary group;
5. enter the run's private mount and network namespaces and bounded cgroup;
6. construct a private host-filesystem view containing only the staged run
   directory and required device nodes, then apply `no_new_privs`, empty
   capabilities, and the supported OpenVMM seccomp policy;
7. launch NVX/OpenVMM without a shell; and
8. verify the resulting process and every relevant thread through `/proc` and
   cgroup files before accepting readiness.

Socket creation or a responsive control endpoint is not confinement evidence.
Any identity, executable, capability, seccomp, namespace, or cgroup mismatch
terminates the process and aborts the run.

Landlock can only be applied by the confined process. AWF cannot impose it on
an already executing OpenVMM process. If an OpenVMM release exposes a
verifiable self-applied Landlock contract, AWF should require and verify it.
Otherwise, the AWF-owned mount namespace and filesystem jail are the mandatory
host-filesystem boundary.

The design must identify whether NVX can run under this wrapper unchanged. If a
required host path or syscall cannot be narrowly declared, the backend remains
blocked until that dependency is understood; the wrapper must not broaden its
policy until the launch happens to work.

## Network boundary

Proxy environment variables are compatibility settings, not enforcement.

The one-shot VM must run in an AWF-owned network namespace with host policy that
allows only:

- the Squid endpoint used for domain-filtered HTTP and HTTPS;
- enabled API-proxy provider ports;
- explicitly declared MCP or other AWF control peers; and
- the minimum local traffic required by the NVX/OpenVMM network device.

The policy must deny direct external TCP, UDP, ICMP, DNS, instance metadata,
host loopback, unsolicited ingress, and lateral access to other runner
services. The guest must not be able to weaken this policy. `NvxManager`
snapshots the host resolver configuration into the identity-owned run
directory and binds that regular file read-only at `/etc/resolv.conf` because
the `consomme` backend requires resolver initialization. Host policy continues
to deny guest DNS traffic.

NVX's `portable` profile, deny rules, and explicit allow rules may be part of
the implementation, but AWF must verify the effective host-side state and run
adversarial bypass probes. An unsupported or partially applied rule is a
startup failure.

## Filesystem and guest image boundary

Phase 2 will implement the image builder, but Phase 1 fixes its contract:

- build deterministic EROFS lower layers from allowlisted inputs;
- use the reproducible fixed-timestamp and fixed-UUID options available in the
  Ubuntu 24.04 `erofs-utils` 1.7.1 production baseline;
- do not pass arbitrary host paths directly to OpenVMM;
- exclude credentials, sockets, devices, and host control files regardless of
  workspace contents;
- bind each layer's UUID, digest, role, and source manifest into the artifact
  manifest;
- create a fresh sparse ext4 scratch image for every invocation;
- mount lower layers read-only and scratch `rw,nosuid,nodev`;
- rewrite absolute guest-root symlinks to equivalent relative targets and
  reject relative symlinks or aliases that escape the staged build root;
- cap scratch size and verify teardown; and
- never reuse guest-writable state across workflow runs.

The guest image must contain the selected non-root account. NVX must reject
root, unknown identities, supplementary groups, and retained capabilities
before executing the agent.

## Credentials and environment

The one-shot command line must not contain secrets. AWF constructs a minimal
guest environment from an allowlist rather than sanitizing and forwarding the
entire host environment.

Real provider credentials stay in the host API proxy. Agent configuration in
the guest points to the proxy's non-secret address. The design must preserve
the Phase 0 Copilot proof: no `GH_TOKEN`, `GITHUB_TOKEN`, or
`COPILOT_GITHUB_TOKEN` is present in the guest while authenticated inference
succeeds through the Copilot proxy port.

If an agent requires a credential that cannot be isolated behind an AWF-owned
proxy, that provider is unsupported for NVX until a non-command-line,
non-persistent delivery design is reviewed.

## One-shot execution and outcomes

The backend sends exactly one complete agent command to NVX. The guest may run
arbitrary child processes beneath that command, subject to its limits.

Required behavior:

- preserve exit codes from `0` through `255`;
- return `124` for an AWF wall-clock timeout;
- terminate OpenVMM's process group on cancellation or timeout;
- reject a missing, malformed, duplicated, or mismatched structured outcome;
- collect bounded serial output without using marker text alone as proof of
  success;
- reject TTY mode; and
- clean up after success, workload failure, launch failure, timeout, signal,
  and partial startup.

Interactive stdin is not required for the initial preview. If the selected
agent needs stdin, Phase 2 must provide a bounded, explicit one-shot channel or
reject that agent configuration.

## Output and diagnostics

Guest stdout and stderr are untrusted. Before forwarding the serial-console
byte stream to a GitHub Actions runner, AWF must use a streaming state machine
that neutralizes both `::...::` and legacy `##[...]` workflow-command syntax
across arbitrary read and frame boundaries. Per-line post-processing is not
sufficient.

The diagnostic bundle should contain bounded, mode-`0600` evidence:

- artifact manifest and verification result;
- launch argument summary with secrets excluded;
- stable VMM process identity and confinement observations;
- network plan and effective-policy verification;
- guest-layer and scratch identities;
- structured workload outcome;
- bounded raw stdout/stderr tails;
- cleanup record and stage results; and
- NVX/OpenVMM logs with environment values redacted.

Diagnostics must remain available when startup verification or cleanup fails.
They must not expose provider credentials, raw host environment variables, or
unbounded guest-controlled data.

## Crash-safe cleanup

Before creating the first privileged resource, AWF writes a root-owned durable
record containing the owner process identity and exact identities of every
resource created for the run.

Normal and stale cleanup must:

- verify PID start time and executable before signaling a process;
- verify uid/gid before deleting a per-run account;
- verify namespace, interface, route, cgroup, file, mount, and ACL identities
  before removal;
- remove resources in dependency order while continuing after individual
  failures;
- preserve the record and evidence when ownership cannot be proven; and
- delete the record only after every required cleanup stage succeeds.

A resource name or PID alone is never sufficient ownership evidence. Concurrent
runs must not be able to reap each other's resources.

## Unsupported initial configurations

The first NVX preview must fail closed for:

- non-Linux or non-x86_64 hosts;
- hosts without usable KVM, cgroup v2, required namespace/filesystem-jail
  primitives, or required firewall support;
- remote Docker daemons and ARC/DinD split filesystems;
- TTY mode or interactive shells;
- custom kernels, initramfs files, OpenVMM binaries, or unverified layers;
- arbitrary host volume mounts;
- reusable or managed NVX sessions;
- unsupported topology peers or enclave combinations; and
- any security setting that the backend cannot enforce and verify.

There is no fallback from an explicitly requested NVX runtime to Docker,
gVisor, sbx, or Cloud Hypervisor. Preflight or startup failure is terminal.

## Phase 1 exit criteria

Phase 1 is complete when maintainers have reviewed and accepted:

1. the one-shot lifecycle and unsupported-feature boundary;
2. the artifact provenance and immutable-snapshot model;
3. the dedicated VMM identity, ACL-only device access, empty supplementary
   groups, mount-namespace filesystem jail, cgroup, optional OpenVMM Landlock,
   seccomp, and post-launch verification design;
4. the host-enforced network policy and adversarial verification plan;
5. the deterministic EROFS plus private ext4 scratch boundary;
6. the credential-free guest environment and API-proxy routing model;
7. structured outcome, output filtering, timeout, and cancellation semantics;
8. durable cleanup and stale-recovery ownership rules; and
9. the exact evidence that Phase 2 tests must produce.

Phase 2 may then implement the deterministic filesystem builder and one-shot
execution adapter. Managed execution is not an exit criterion.

## Phase 2 implementation boundary

Phase 2 adds reusable foundations without making `nvx` a selectable AWF
runtime:

- `src/nvx/filesystem-builder.ts` creates ordered deterministic EROFS layers
  from explicitly selected source roots, excludes known credential paths at
  any depth, rejects escaping links and special files, records source and image
  identities, and creates one fresh bounded ext4 scratch image per invocation.
  Staging requires Linux `/proc/self/fd` and no-follow directory descriptors to
  prevent source-tree path races;
- `src/nvx/one-shot-adapter.ts` constructs only `nvx.py sandbox run`, launches
  without a shell or inherited credential environment, applies a host
  wall-clock timeout or cancellation to the full process group, filters
  workflow-command syntax as a byte stream, and retains bounded raw output
  tails; and
- `src/nvx/outcome.ts` requires the exact one-shot outcome and teardown schema,
  preserves guest status codes including `125`, and verifies that NVX reports
  the requested fail-closed network policy.

The adapter intentionally requires a prebuilt absolute entrypoint and
whitespace-free NVX arguments. Complex agent commands must be placed in an
immutable layer as an entrypoint script because the pinned NVX kernel-command
line ABI rejects whitespace-bearing `--arg` values.

Phase 2 does not add `nvx` to the runtime registry or CLI. Selection remains
blocked until Phase 3 supplies the dedicated VMM identity, ACL-only device
access, filesystem jail, cgroup, host-enforced network namespace, live
confinement verification, artifact attestation, and durable stale cleanup.

## Phase 3a implementation boundary

Phase 3a adds fail-closed artifact-trust and host-confinement foundations while
continuing to keep `nvx` absent from the runtime registry and CLI:

- `src/nvx/artifact-manifest.ts` defines an exact AWF-owned manifest contract
  binding an AWF release to the pinned NVX and OpenVMM source revisions,
  artifact roles, basenames, architecture, sizes, and SHA-256 digests;
- `src/nvx/preflight.ts` requires Linux x86_64, root, usable KVM and TUN
  devices, cgroup v2 CPU/memory/PID controllers, seccomp support, trusted host
  tools resolved only from root-owned standard system directories
  (`/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`), source metadata matching the
  manifest before copying, and a private per-run immutable snapshot whose
  manifest has a GitHub-verified AWF release attestation and whose artifact
  sizes and digests match the manifest;
- `src/nvx/confinement.ts` constructs a shell-free
  `ip netns exec` → Bubblewrap → `setpriv` → NVX launch chain with a private
  mount namespace, minimal device exposure, a fixed read-only system allowlist,
  a dedicated uid/gid, empty supplementary groups, no capabilities, and
  `no_new_privs`. It also verifies the live OpenVMM process and every thread
  against the expected executable, identity, namespace, cgroup membership,
  limits, capabilities, seccomp mode, and stable process identity; and
- `src/nvx/cleanup-record.ts` defines the exact durable ownership record used
  by future normal and stale cleanup. It binds each cleanup stage to
  independently verifiable process, filesystem, namespace, account, cgroup,
  and device-ACL identities rather than accepting names or PIDs alone; and
- `src/nvx/run-layout.ts` derives the artifact snapshot, writable run
  directory, cleanup record, cgroup, and network namespace from one 32-character
  run identity, and provides checked host-to-jail path translation. Preflight
  now stages artifacts at that exact identity-bound path, while confinement
  rejects artifact and writable directories from different runs.

These modules remain internal foundations, not a selectable backend. Phase 3d
supersedes the earlier TAP design with KVM-only device access, direct OpenVMM
launch, portable Consomme networking, and a pre-resume verification gate. A
GitHub-hosted x86_64 KVM workflow must still demonstrate complete guest launch,
enforcement, adversarial probes, teardown, and recovery evidence before `nvx`
can be registered as an opt-in runtime.
