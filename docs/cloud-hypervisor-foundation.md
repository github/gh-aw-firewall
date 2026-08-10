---
title: Cloud Hypervisor foundation (not yet a runnable backend)
description: Pinned versions/digests, configuration surface, preflight/artifact validation module, and guest artifact pipeline for the Cloud Hypervisor microVM foundation. There is no lifecycle backend yet.
---

:::caution[Foundation only — no lifecycle backend]
This document describes **preparatory** work for a future Cloud Hypervisor
microVM backend: configuration/artifact plumbing, fail-closed preflight
validation, and a guest artifact build pipeline. **`cloud-hypervisor` is not a
valid `--container-runtime` value in this release** and no workload can be
executed with it. Firecracker (see
[Firecracker microVM integration (preview)](./firecracker-integration.md))
continues to work unchanged and is unaffected by this foundation.
:::

## What this adds

- A `cloudHypervisor` config-file block and matching `--cloud-hypervisor-*`
  CLI flags (see [`docs/awf-config-spec.md`](./awf-config-spec.md) §4.1 for
  the normative property list and CLI mapping) so artifact paths and SHA-256
  digests can be pinned and round-tripped through config today.
- [`src/cloud-hypervisor/preflight.ts`](../src/cloud-hypervisor/preflight.ts):
  fail-closed host and artifact validation mirroring
  [`src/firecracker/preflight.ts`](../src/firecracker/preflight.ts) — pinned
  version parsing, trusted-owner/non-writable regular-file checks for the
  binary/kernel/rootfs/supervisor, digest verification, `/dev/kvm` access,
  and required trusted host tools (`ip`, `nft`, `sysctl`, `mke2fs`,
  `debugfs`, `e2fsck`, `rsync`).
- [`src/cloud-hypervisor/host-eligibility.ts`](../src/cloud-hypervisor/host-eligibility.ts):
  a narrow, independently-tested helper distinguishing GitHub-hosted Ubuntu
  x86_64 KVM runners from self-hosted or non-Ubuntu hosts. This is a
  necessary-but-not-sufficient check — it does not open `/dev/kvm` or verify
  artifacts; `runCloudHypervisorPreflight` does that.
- [`guest/cloud-hypervisor/build-test-artifacts.sh`](../guest/cloud-hypervisor/build-test-artifacts.sh)
  and
  [`verify-test-artifacts.sh`](../guest/cloud-hypervisor/verify-test-artifacts.sh):
  a reproducible guest artifact pipeline that produces a pinned Cloud
  Hypervisor binary, a PCI-capable guest Linux kernel, a deterministic raw
  ext4 rootfs (BusyBox + CA bundle + the shared AWF guest supervisor),
  `SHA256SUMS`, `manifest.json`, and an SPDX SBOM.

## Pinned versions and digests

| Artifact | Version | SHA-256 |
|---|---|---|
| `cloud-hypervisor` (x86_64 static) | v53.0 | `448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc` |
| Linux kernel source | 6.1.141 | `bc3c45faf6f5f0450666c75fa9dad9bc7c0cf7c7cba0dbd94e5cfdc58229c116` |
| Kernel config | firecracker v1.16.1 `microvm-kernel-ci-x86_64-6.1.config` | `adbc70ab5e89213ba00594b12d25e09bdf8bb1ed3c252d7449326bb14c22963b` |
| BusyBox source | 1.36.1 | `b8cc24c9574d809e7279c3be349795c5d5ceb6fdf19ca709f80cde50e47de314` |
| CA bundle | 2025-02-25 | `50a6277ec69113f00c5fd45f09e8b97a4b3e32daa35d3a95ab30137a55386cef` |

Cloud Hypervisor v53.0 was the current upstream release as of this writing
([cloud-hypervisor/cloud-hypervisor releases](https://github.com/cloud-hypervisor/cloud-hypervisor/releases)).
Both the binary digest and the source-tarball digest were independently
verified against the GitHub release assets before pinning.

### Why the guest kernel reuses the Firecracker config

`guest/cloud-hypervisor/build-test-artifacts.sh` intentionally builds from the
**same Linux kernel source and the same pinned Firecracker
`microvm-kernel-ci-x86_64-6.1.config`** used by
[`guest/firecracker/build-test-artifacts.sh`](../guest/firecracker/build-test-artifacts.sh).
That config already enables everything Cloud Hypervisor's direct-kernel-boot,
virtio-pci transport needs — `CONFIG_PCI`, `CONFIG_VIRTIO_PCI`,
`CONFIG_PCI_MMCONFIG` (ACPI MCFG/PCIe ECAM), `CONFIG_VIRTIO_BLK`,
`CONFIG_VIRTIO_NET`, `CONFIG_VIRTIO_CONSOLE`, `CONFIG_VSOCKETS` /
`CONFIG_VIRTIO_VSOCKETS`, `CONFIG_EXT4_FS`, and `CONFIG_PVH` for
firmware-less direct boot — while leaving virtio-fs, VFIO, vhost-user, vDPA,
snapshot/restore, hotplug, and confidential-computing options off. Reusing
one reviewed, pinned kernel config keeps both VMM backends' guest kernels
identical instead of maintaining a second hand-curated config.

### Why the guest supervisor is shared, unmodified

[`guest/firecracker-supervisor/`](../guest/firecracker-supervisor/) documents
itself as VMM-neutral: its length-prefixed JSON framing protocol
(`protocol.go`) mirrors `src/microvm/guest-protocol.ts` on the host side and
does not depend on any Firecracker-specific transport. The Cloud Hypervisor
guest pipeline invokes
`guest/firecracker-supervisor/build.sh` as-is to produce the same
`awf-supervisor` binary used in both guest rootfs images.

## Explicit scope limits (this layer)

- **Direct kernel boot only.** No UEFI/firmware layer.
- **Raw ext4 disks only.** No virtio-fs, snapshot/restore, hotplug, VFIO,
  vhost-user, vDPA, or confidential computing.
- **virtio-pci transport only** for block, net, and vsock devices.
- **GitHub-hosted Ubuntu x86_64 KVM runners only.** Self-hosted runners and
  non-Ubuntu/non-x86_64 hosts are explicitly out of scope; see
  `evaluateGithubHostedRunnerEligibility()` in
  [`src/cloud-hypervisor/host-eligibility.ts`](../src/cloud-hypervisor/host-eligibility.ts).
- **No REST control-plane client, launcher, or manager.** No
  `--container-runtime cloud-hypervisor` registration. No live KVM
  integration test. These arrive in a later layer once the lifecycle backend
  exists.

Passing `--container-runtime cloud-hypervisor` fails immediately with an
explicit error (`assertCloudHypervisorNotYetAvailable`) instead of silently
falling through to the generic unknown-runtime passthrough.
