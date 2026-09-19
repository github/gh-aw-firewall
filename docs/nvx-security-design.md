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
- the pinned NVX host tooling;
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
role substitution.

Development-only artifacts may use a conspicuous dual opt-in plus complete
digests. They must never be accepted by default or silently replace failed
provenance verification.

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
services. The guest must not be able to weaken this policy.

NVX's `portable` profile, deny rules, and explicit allow rules may be part of
the implementation, but AWF must verify the effective host-side state and run
adversarial bypass probes. An unsupported or partially applied rule is a
startup failure.

## Filesystem and guest image boundary

Phase 2 will implement the image builder, but Phase 1 fixes its contract:

- build deterministic EROFS lower layers from allowlisted inputs;
- do not pass arbitrary host paths directly to OpenVMM;
- exclude credentials, sockets, devices, and host control files regardless of
  workspace contents;
- bind each layer's UUID, digest, role, and source manifest into the artifact
  manifest;
- create a fresh sparse ext4 scratch image for every invocation;
- mount lower layers read-only and scratch `rw,nosuid,nodev`;
- reject symlinks or aliases that escape the staged build root;
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
