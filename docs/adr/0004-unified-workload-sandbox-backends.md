# ADR 0004: Unified workload sandbox backends

## Status

Accepted direction; implementation is incremental. Backend resolution,
inheritance of omitted enclave runtimes, and conflict rejection are implemented.
The internal Cloud Hypervisor primary/enclave lifecycle is composed with the
existing host executor and boot loop. Docker verification is complete.
Cloud Hypervisor primary-with-enclave production execution remains gated on
real end-to-end acceptance, and NVX enclaves remain unsupported.

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
2. **Unified Cloud Hypervisor with static enclaves:** integrate the primary
   instance and fresh static script/agent enclave instances under the resolved
   Cloud Hypervisor backend. Retain the current gate until end-to-end acceptance
   demonstrates the required artifact, isolation, credential, resource, result,
   cancellation, cleanup, and recovery boundaries.
3. **Unified NVX:** leverage the shared microVM architecture where practical,
   with NVX-specific trust and isolation acceptance before enabling its enclaves.

### Upstream compiler contract blocking unified acceptance

The pinned gh-aw compiler `v0.91.7` rejects a workflow that combines
`sandbox.agent.runtime: cloud-hypervisor` with any `enclaves` entry, with the
validation error that Cloud Hypervisor is incompatible with enclaves. This was
confirmed by compiling the proposed manual acceptance workflow with the exact
compiler version in the existing workflow lock metadata. The closed
[gh-aw#66639](https://github.com/github/gh-aw/issues/66639) supports a
Cloud Hypervisor enclave with a Docker primary; it does not support the unified
primary-plus-enclave selection.

Because compilation stops before generating a workflow, current compiler-owned
mcpg and release-artifact setup cannot yet be verified for this combination.
The precise upstream dependency is compiler support for compiling a Cloud
Hypervisor primary with a static script enclave while preserving the existing
artifact and mcpg handoff contracts. Track this as a separate gh-aw compiler
follow-up; do not work around the rejection with a generated-lock edit, a mock
gateway, or a general AWF configuration bypass. Keep the AWF production guard
in place until gh-aw can compile this path and it passes real-KVM validation.

The lifecycle regression tests use a mocked VM/host-service boundary and a
readiness callback; they are not real-KVM or real-mcpg acceptance. No workflow
dispatch or production enablement is part of this slice. Subsequent acceptance
must first run a Cloud Hypervisor primary with a static script enclave through
compiler-owned **real mcpg**, then a static agent enclave with the dedicated
model proxy. It must establish:

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
