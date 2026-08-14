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
8. Create and boot the VM, connect to the guest supervisor over VSOCK, and
   probe infrastructure connectivity.
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

### Guest cannot reach Squid or the API proxy

Check the namespace nftables rules, TAP state, and Squid/API proxy health. The
guest must not have a direct route to the internet; fixing connectivity by
loosening the default-deny policy would break the security boundary.

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
