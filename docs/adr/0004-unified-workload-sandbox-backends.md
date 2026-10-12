# ADR 0004: Unified workload sandbox backends

## Status

Accepted direction; implementation is incremental. Backend resolution,
inheritance of omitted enclave runtimes, and conflict rejection are implemented.
The internal Cloud Hypervisor primary/enclave lifecycle is composed with the
existing host executor and boot loop. Docker verification is complete.
The gh-aw v0.91.8 compiler supports the static-script unified workflow, and a
manual/tagged acceptance path is implemented in source. Published AWF release
coordination and real end-to-end acceptance remain outstanding before that
path can run. Production execution remains gated, and NVX enclaves remain
unsupported.

This decision complements [ADR 0001](0001-agent-enclaves.md) and refines the
run-level integration of
[ADR 0002](0002-cloud-hypervisor-enclave-executor.md). It does not replace that
ADR's host executor, trust boundaries, protocol, or lifecycle requirements.

## Context

AWF has primary workload backends and enclave executors with distinct lifecycle
and isolation requirements. Independently selecting their runtimes permits
mixed-backend runs, complicating configuration, acceptance evidence, and cleanup
without making workload boundaries easier to understand.

Cloud Hypervisor already has primary-agent managers, workload profiles, an
authenticated host broker/executor path, and artifact, confinement, storage,
network, and recovery mechanisms. Unifying backend selection must preserve
these mechanisms rather than replace them with a new generic launcher.
NVX should leverage shared microVM orchestration where practical, but sharing
code must not erase backend-specific trust or isolation requirements.

## Decision

### One backend, separate workload instances

An enclave-enabled run resolves exactly one workload sandbox backend for the
primary workload and every enabled enclave executor. The primary and each
accepted enclave invocation use **separate isolated instances** of that backend.
They do not share a guest, container, writable workload state, or authority
merely because their backend is the same.

The primary instance lasts for the primary workload's lifecycle. Each enclave
invocation creates a fresh, single-use instance with its own bounded resources,
policy-derived inputs, result collection, cancellation, and cleanup.

Squid, API proxies, and compiler-owned `gh-aw-mcpg` may remain supporting Docker
infrastructure. Their placement does not select a second workload backend or
authorize broader workload access to them.

### Resolution and compatibility

An omitted primary runtime, `docker`, or `runc` resolves to Docker; `runsc`
resolves to gVisor. gVisor remains a distinct workload backend even though it
uses Docker orchestration. Other known backend selections retain their identity.

An omitted enclave runtime inherits the resolved primary backend. An explicit
enclave runtime must match it. AWF rejects conflicts during configuration
assembly and validates already assembled configurations before seed staging or
infrastructure startup. It neither silently rewrites an explicit selection nor
implicitly switches the primary backend.

Enclave-enabled runs have no cross-backend fallback. If the selected backend
cannot support the requested combination or meet its required isolation and
lifecycle gates, the run fails closed. Consistent selection alone is not proof
that a combination is implemented.

This change leaves existing standalone behavior unchanged, including the
Cloud Hypervisor unsupported-host fallback. It does not assert that every
standalone run already prohibits fallback.

### Preserve mechanisms; share orchestration deliberately

Cloud Hypervisor integration builds on the existing managers, workload profiles,
host broker/executor, verified artifacts, isolation controls, and lifecycle
mechanisms. ADR 0002 continues to govern authenticated host execution, bounded
invocation plans, credential custody, cancellation, settlement, and orphan
recovery. Its executor is not a route to a supported Docker-primary /
Cloud-Hypervisor-enclave combination.

Cloud Hypervisor and NVX should share microVM orchestration and code where the
contracts genuinely align, including workload-instance lifecycle coordination
and bounded result handling. Backend-specific artifact attestation, launch
authority, guest profiles, filesystem and network isolation, credential
handoffs, resource enforcement, and recovery checks remain explicit and
mandatory. Code reuse must not introduce a permissive lowest-common-denominator
backend or bypass existing checks.

### Cloud Hypervisor lifecycle integration (gated)

The existing enclave preparation path stages static seeds and starts the
authenticated host service only after its host, artifact, and bounded-storage
preflight. Structural validation of that trusted service is separate from
production authorization; the CLI workflow and primary runtime compatibility
checks still reject Cloud Hypervisor primary-with-enclave execution. There is
no new configuration or environment-variable bypass.

The primary boot loop requires that exact configuration's host lifecycle to be
ready before starting supporting Compose infrastructure. Its infrastructure
callback attaches compiler-owned mcpg, verifies the enabled tool contracts, and
performs any required GitHub readiness checks through the existing workflow
path. The boot loop requires callback completion, rechecks admissions, and
revalidates the discovered topology before creating the primary manager. The
existing primary profile permits discovered gateway peers only on port 8080,
publishes their host aliases, and bypasses Squid for those peers in the guest
environment. It does not attach the primary VM to the private enclave network.
Guest connectivity probes remain separate from mcpg tool-contract readiness.

Before planning virtio-fs mounts, AWF checks every actual primary export source,
including runner-temporary and tool-cache exports, against private seed,
ingress/capability, broker transport, invocation, allocation, and recovery roots.
Read-only exports and symlink aliases are also rejected on overlap; a readonly
mount is not a confidentiality boundary. This supplements, rather than replaces,
the staging-time mount-policy checks and existing guest credential exclusions.

Primary execution rechecks host-lifecycle readiness. Shutdown closes admissions
before primary cancellation, drains invocation VMs even if primary termination
fails, and releases enclave storage only after the existing recovery checks.
Concurrent stop/preserve calls share teardown, and another configuration cannot
close the owning run's admissions or storage. The CLI cleanup path retains
sidecars, gateway attachments, and private recovery state if either primary
or enclave VM cleanup is uncertain. Keeping primary diagnostics does not keep
enclave admissions or invocation VMs alive.

## Rollout and acceptance

1. **Docker verification (complete):** verify existing Docker execution and the
   resolution, inheritance, and early conflict checks. This PR does not enable
   new microVM combinations.
2. **Unified Cloud Hypervisor with static enclaves:** primary and fresh
   single-use enclave instances use the resolved Cloud Hypervisor backend.
   The manual static-script workflow and narrowly scoped acceptance authorization
   (authorizing the reviewed official workflow on `refs/heads/main` to test an
   independently pinned published release, alongside the approved tagged path)
   are implemented. Keep ordinary production configurations gated until the
   policy-containing AWF release is published and live acceptance demonstrates
   the required artifact, isolation, credential, resource, result, cancellation,
   cleanup, and recovery boundaries.
3. **Unified NVX:** leverage the shared microVM architecture where practical,
   with NVX-specific trust and isolation acceptance before enabling its enclaves.

### Historical compiler blocker (resolved by gh-aw v0.91.8)

The gh-aw v0.91.7 compiler rejected
`sandbox.agent.runtime: cloud-hypervisor` combined with an enclave. That was
the compiler blocker recorded in #9805; it is no longer the current blocker.
Upstream [gh-aw#67772](https://github.com/github/gh-aw/pull/67772) added the
compiler support in v0.91.8 and closed
[gh-aw#67752](https://github.com/github/gh-aw/issues/67752).
The target manual workflow compiles with the exact v0.91.8/v0.91.9 compiler and emits
the Cloud Hypervisor primary selection, static script executor, supporting
Docker infrastructure, compiler-owned mcpg discovery/readiness and
authentication handoffs, and primary/script artifact setup. The generated lock
records the compiler version. Do not edit the generated lock to evade compiler validation.

### AWF release and live acceptance remain blocked

Earlier acceptance gates required the workflow execution tag to equal the
verified artifact release tag. That created an endless circular dependency
where a release tag could not pin its own yet-to-be-published version.
The updated acceptance policy authorizes the reviewed official workflow on
`main` (`refs/heads/main`) to test an independently pinned published release,
while preserving the approved tagged path.

However, existing published AWF host binaries (including v0.28.52 and v0.28.53)
only contain the older tag-only guard. Because the acceptance workflow executes
the installed released binary rather than local unverified source, dispatching
on `main` against an unchanged existing release binary fails the host-side gate.

A new AWF release containing this reviewed acceptance policy must be published
before live acceptance can execute on `main`. The rollout proceeds in safe stages:
1. Merge the acceptance policy and documentation into `main`.
2. Cut and publish a new AWF release containing the updated acceptance policy,
   along with matching container images and release-attested Cloud Hypervisor artifacts.
3. Update the manual workflow pin to that new release and regenerate its lock.
4. With separate authorization, dispatch live acceptance on `main`:
   `gh aw run smoke-enclave-cloud-hypervisor --ref main`.

Do not run the workflow against local unverified binaries or bypass the
acceptance gate. No release operation or live acceptance dispatch is authorized
by this pull request.

The lifecycle regression tests and source gate tests are local regressions, not
real-KVM or real-mcpg acceptance. The v0.91.8 compile and lock inspection are
compiler evidence only. No workflow dispatch or production enablement is part
of this slice. After release coordination and explicit authorization,
acceptance must run a Cloud Hypervisor primary with a static script enclave
through compiler-owned **real mcpg**, then a static agent enclave with the
dedicated model proxy. The script acceptance must establish:

- Fresh independent invocation VMs, release-attested artifacts, bounded
  resources/storage, and bounded schema-valid results.
- Guest reachability of the compiler's public gateway route and denial of the
  broker, seed, capability, storage, and recovery paths, including carried-in
  submounts and filesystem alias/race cases. Path-overlap checks alone are not
  proof of live virtio-fs confinement.
- Credential exclusion, no-network script execution, and dedicated agent
  network membership without access to the primary, general proxy, or control
  plane.
- Normal completion, cancellation, readiness/startup failure, concurrent
  shutdown, uncertain teardown, and restart/orphan reconciliation without
  releasing infrastructure or protected state before VMs are reaped.

Static agent GitHub tools have an additional unresolved contract: the host
backend requires a compiler-scoped executor bearer handoff; the existing static
identity alone is insufficient. AWF retains that explicit rejection and must not
substitute a gateway-wide key or broaden the guest's network privileges. An
agent acceptance run without GitHub tools does not satisfy that separate gate.

Dynamic repository admission is a separate capability from on-demand creation
of fresh enclave instances. Static enclaves already require fresh instances per
invocation; they do not require runtime repository admission. Dynamic admission
comes after static acceptance for the relevant backend and retains ADR 0001's
one-repository delegation, credential handoff, revocation, and information-ledger
requirements. Selecting a unified backend does not enable dynamic admission.

## Consequences

Configuration has a single workload-backend meaning while workload instances
remain independently isolated. Explicit mixed-backend enclave configurations
that previously selected independent executors are now rejected, not migrated
implicitly. Operators must choose a matching supported backend.

Shared orchestration can reduce duplication across microVM implementations, but
backend-specific acceptance remains necessary. The existing Cloud Hypervisor
host-executor internals remain useful foundations even while unified
primary-with-enclave execution is gated.
