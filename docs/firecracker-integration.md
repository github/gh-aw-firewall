---
title: Firecracker microVM integration (preview)
description: Architecture, threat model, prerequisites, workspace semantics, networking, API proxy, lifecycle, diagnostics, and CLI reference for the Firecracker v1.16.1 microVM preview backend.
---

import { Aside } from '@astrojs/starlight/components';

:::danger[Explicit preview opt-in required — not a production default]
The Firecracker backend is a **preview** that requires every flag described in
this document. It is **not** enabled by default, does **not** auto-activate, and
is **never** a fallback for any other runtime. You must supply
`--container-runtime firecracker --firecracker-preview` together with all
artifact paths and their SHA-256 digests on every invocation. Omitting any
required input is a hard failure.

**Linux/KVM only.** macOS and Windows are unsupported and will never silently
pass; the preflight fails immediately on non-Linux hosts. CI specifically
supports GitHub-hosted x64 `ubuntu-24.04`, which exposes `/dev/kvm`. KVM remains
mandatory, and any host without a readable and writable `/dev/kvm` fails closed.
:::

This document covers the AWF Firecracker v1.16.1 microVM preview. It is
structured for two audiences:

1. **Operators** who want to set up and run the preview on a capable Linux/KVM
   host.
2. **Engineers** who want to understand the implementation design and trust model.

For the Docker-compose defaults see [Architecture](./architecture.md). For
gVisor (OCI runtime, no separate kernel) see [gVisor integration](./gvisor-integration.md).
For Docker Sandboxes (sbx) see [sbx integration](./sbx-integration.md). For
sandbox design rationale see [Sandbox design](./sandbox-design.md).

---

## Part 1 — What Firecracker adds and why it is a preview

### What Firecracker is

[Firecracker](https://firecracker-microvm.github.io/) is a minimal virtual
machine monitor (VMM) built by AWS for serverless/container workloads. It uses
Linux's KVM subsystem to boot a separate Linux kernel inside a hardware-isolated
virtual machine. The guest is completely isolated from the host kernel; the only
communication surfaces are the Firecracker control API socket, a vsock channel,
and explicit network interfaces.

AWF's Firecracker preview runs the **agent command** inside the microVM while
keeping the host-side egress filtering infrastructure (Squid proxy, API proxy,
iptables/nftables rules) on the host. The guest kernel never touches host memory;
the agent can only reach host-side services through explicit permitted
network endpoints.

### Why it is a preview

The Firecracker backend adds meaningful defense-in-depth but also imposes
requirements that make it unsuitable as a universal default:

- **Hard host requirements** — Linux kernel with KVM, specific system tools,
  cgroup v1 or v2, passwordless sudo for the operator account.
- **Operator-managed artifacts** — there is no auto-download. Every artifact
  (Firecracker binary, jailer binary, guest kernel, rootfs, guest supervisor)
  must be supplied by the operator with an exact SHA-256 digest.
- **Pinned to Firecracker v1.16.1** — the version pin is enforced at runtime;
  any other version fails preflight.
- **x86_64 only for test artifacts** — the released test artifact set targets
  x86_64. aarch64 is supported at the code level (preflight will accept it) but
  no pre-built aarch64 test artifact is shipped.
- **Topology restrictions** — topology peers, enclaves, Docker-in-Docker,
  extra volume mounts, TTY, host access, and DNS-over-HTTPS all fail closed.

These constraints are intentional. Relaxing them, especially artifact management
and topology completeness, is a prerequisite for promotion to non-preview.

### Comparison with the other isolation backends

| Property | Docker (default) | gVisor | sbx | Firecracker |
|----------|-----------------|--------|-----|-------------|
| Isolation mechanism | Linux namespaces/cgroups | Userspace application kernel | Docker Sandboxes microVM (KVM) | Firecracker microVM (KVM) |
| Separate Linux kernel | No | No (own syscall surface) | Yes | Yes |
| Requires KVM | No | No (systrap platform) | macOS/Win: platform hypervisor; Linux: KVM | Yes — hard requirement |
| Works on GitHub-hosted runners | Yes | Yes | macOS only | Yes — x64 `ubuntu-24.04` with KVM |
| Workspace delivery | bind mount | bind mount | virtiofs passthrough | ext4 image copy-in / copy-back |
| Virtiofs / live bind mounts | N/A | N/A | Yes (default) | **No** |
| Docker-in-Docker | Supported | Supported | Yes (in-VM engine) | **Not supported** |
| Topology peers / enclaves | Supported | Supported | Supported | **Not supported (preview)** |
| TTY | Supported | Supported | Supported | **Not supported (preview)** |
| Credential isolation | API proxy (optional/required in strict) | API proxy | API proxy (host-side injection) | API proxy — **mandatory** |
| Auto-download artifacts | N/A | N/A | Yes (sbx binary) | **No — operator-managed** |
| Version pin | N/A | N/A | N/A | v1.16.1 — hard enforcement |

---

## Part 2 — Architecture

### Host-side components

```
┌─────────────────────────────────────────────────────────────────────┐
│  Host (Linux, x86_64, KVM-capable)                                  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  AWF CLI (runs as root via sudo from the non-root operator)  │  │
│  │  - Validates all artifacts and digests (preflight)           │  │
│  │  - Starts Docker Compose: Squid + API proxy containers       │  │
│  │  - Creates dedicated network namespace (awffc-<runId>)       │  │
│  │  - Sets up TAP device + nftables rules inside namespace      │  │
│  │  - Creates ext4 workspace image, copies workspace in         │  │
│  │  - Launches Firecracker via jailer in the namespace          │  │
│  │  - Waits for vsock supervisor handshake                      │  │
│  │  - Executes agent command via vsock protocol                 │  │
│  │  - Copies changed workspace files back after completion      │  │
│  │  - Cleans up namespace, jail, images                        │  │
│  └──────────────────────────────────────────────────────────────┘  │
│           │                       │                                 │
│           ▼                       ▼                                 │
│  ┌──────────────────┐   ┌──────────────────────────────────────┐   │
│  │  Squid Proxy     │   │  Firecracker jailer chroot           │   │
│  │  (Docker)        │   │  (/tmp/awf-.../firecracker-jailer/   │   │
│  │  172.30.0.10:3128│   │   <runId>/root/)                     │   │
│  └──────────────────┘   │  ┌──────────────────────────────────┐│   │
│           │              │  │  Firecracker VMM (pid inside     ││   │
│  ┌──────────────────┐   │  │  netns awffc-<runId>)            ││   │
│  │  API Proxy       │   │  │  Kernel: vmlinux.bin             ││   │
│  │  (Docker)        │   │  │  Rootfs: rootfs.ext4 (priv copy) ││   │
│  │  172.30.0.30     │   │  │  Workspace: workspace.ext4 (rw)  ││   │
│  └──────────────────┘   │  │  Supervisor: vsock port 52       ││   │
│                          │  └──────────────────────────────────┘│   │
│                          └──────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                   ↕ nftables-enforced per-namespace egress
                   (only Squid port 3128 and API proxy reachable from guest)
```

### Guest contents

The guest rootfs (`rootfs.ext4`) is a minimal ext4 image containing:

- **BusyBox** — static binary providing `/bin/sh`, `wget`, `nc`, `nslookup`,
  `ip`, `timeout`, and other standard utilities
- **AWF guest supervisor** (`/sbin/awf-supervisor`) — a statically compiled Go
  binary that listens on vsock port 52, receives execution requests from the
  host, runs the agent command, and streams stdin/stdout/stderr back
- **CA bundle** — a pinned Mozilla CA bundle (date-stamped, SHA-256 verified)
  at `/etc/ssl/certs/ca-certificates.crt`
- **Minimal /etc/passwd, /etc/group** — defines `root`, `awf` (uid/gid 1000),
  and `nobody`
- **Empty /etc/resolv.conf** — direct DNS is intentionally absent; the comment
  states this explicitly (see §Networking)

The workspace is a **separate** writable ext4 image (`workspace.ext4`) mounted
at `/workspace` inside the VM. It is not part of the shared rootfs.

### Control flow

1. **Preflight** — validate host (Linux, x86_64 or arm64, `/dev/kvm` r/w,
   required tools, cgroup hierarchy, Docker, passwordless sudo), validate all
   five artifact files (type, permissions, ownership, digest)
2. **Infrastructure start** — Docker Compose brings up Squid and the API proxy
   in the same network as usual; the host bridge is discovered
3. **Network namespace** — a dedicated namespace `awffc-<runId>` is created with
   a veth pair (host side joins the infrastructure bridge; namespace side is
   wired to a TAP device for the VM) and nftables rules that allow only the
   Squid port and the API proxy from the guest
4. **Workspace image** — `mke2fs` creates `workspace.ext4`; the host workspace
   and a `.awf-home` directory are copied in via `rsync` then `debugfs`; a
   pre-run manifest is recorded
5. **Jailer launch** — Firecracker is launched by the jailer inside the network
   namespace; the jailer establishes a chroot under
   `<workDir>/firecracker-jailer/<runId>/root/` and drops to a non-root uid/gid
6. **API configuration** — AWF configures the VMM via its Unix socket:
   kernel boot params, vcpu count, memory, TAP network interface, rootfs block
   device (private writable copy), workspace block device (read-write), vsock
   device (CID 3, port 52)
7. **Boot** — the VM boots; the supervisor starts and waits on vsock port 52
8. **Connectivity probe** — host confirms Squid reachability and API proxy
   `/reflect` endpoint from inside the guest before the agent is started
9. **Agent execution** — host sends the execution request over vsock; supervisor
   forks the agent command, forwards stdin/stdout/stderr; exit code returned
10. **Copy-back** — workspace.ext4 is read back via `debugfs`; files changed
    relative to the pre-run manifest are extracted and conflict-checked against
    the host workspace before writing back
11. **Cleanup** — network namespace, veth pair, TAP device, and jail directory
    are removed; images are deleted unless `--keep-containers` was given

---

## Part 3 — Threat model and trust boundaries

### What the microVM boundary enforces

- **Host kernel isolation** — agent processes are inside a separate kernel with
  hardware memory isolation. A memory corruption exploit in the agent cannot
  directly access host memory.
- **No direct host filesystem access** — the only data path between guest and
  host is the workspace ext4 image (explicit, bounded, copy-in/copy-back with
  conflict checking) and the vsock protocol (explicit RPC).
- **No virtiofs / live bind mounts** — the preview does not expose any live
  filesystem passthrough. Guest filesystem writes are bounded to `workspace.ext4`
  and are checked on copy-back.
- **No host daemon access** — the guest cannot reach the host Docker socket,
  the host Docker Engine, or any host Unix sockets.
- **Egress fully mediated** — guest direct egress is blocked at the nftables
  level inside the network namespace. The guest can reach only Squid (port 3128)
  and the API proxy. Direct IP connections, arbitrary TCP/UDP, and raw DNS are
  all denied.
- **Credential isolation** — real API credentials (OpenAI, Anthropic, Copilot,
  Gemini, GitHub token) are **never** passed as guest environment variables. An
  explicit assertion at boot time verifies none of the configured secret values
  appear in any guest environment variable. The API proxy on the host side
  injects credentials into provider calls at the HTTP layer.
- **No metadata reachability** — the EC2/GCP/Azure instance metadata IP
  (`169.254.169.254`) and link-local range are blocked in the guest network
  namespace.

### What the microVM boundary does NOT protect

- **Agent trust** — the agent command runs as the configured uid/gid (default:
  the operator's uid from `SUDO_UID`). A malicious agent can read and modify
  all files in the workspace image and communicate with Squid.
- **Workload secrets passed explicitly** — any environment variable the operator
  explicitly passes to the guest (not the credential set above) is in-scope for
  the guest agent.
- **CPU side-channels** — Firecracker does not mitigate Spectre/Meltdown-class
  attacks beyond what the host kernel provides. Multi-tenant use on the same
  physical core requires additional host-level mitigations.
- **Jailer uid/gid** — the jailer drops to a non-root uid, but this uid must
  exist on the host. The jailer process itself runs in the operator's sudo
  session.

### Trust boundaries summary

| Boundary | Enforced by | Notes |
|----------|------------|-------|
| Guest ↔ host kernel | KVM hardware isolation | Hard boundary; VM escape requires VMM/KVM vulnerability |
| Guest filesystem ↔ host filesystem | Explicit ext4 image + copy-back | No live mounts; changes are conflict-checked |
| Guest ↔ host network | nftables rules in dedicated network namespace | Only Squid + API proxy reachable from guest |
| Agent credentials ↔ guest env | Explicit assertion at boot | Fails hard if any secret would enter guest env |
| Guest DNS | DNS-over-Squid only | Direct DNS denied; resolv.conf empty |
| Guest direct egress | nftables DENY | All outbound except proxy ports blocked |

---

## Part 4 — Prerequisites and supported hosts

### Supported host configurations

| Requirement | Value |
|-------------|-------|
| Operating system | **Linux only** — macOS and Windows are unsupported and fail preflight immediately |
| Architecture | x86_64 (primary) — aarch64 accepted by preflight code but no pre-built test artifacts are released |
| KVM device | `/dev/kvm` must exist and be readable + writable by the workflow user |
| CI runner | GitHub-hosted x64 `ubuntu-24.04` with readable + writable `/dev/kvm` |

:::caution[KVM requirement]
The CI-supported host is GitHub-hosted x64 `ubuntu-24.04`. Do not infer support
for other GitHub-hosted images or architectures. The preflight checks the actual
host capabilities, including a readable and writable `/dev/kvm`, and fails
closed when any requirement is absent.
:::

### Required host tools

The following tools must be present on `PATH` and executable:

| Tool | Purpose |
|------|---------|
| `ip` | Network namespace and veth management |
| `nft` | nftables rules inside the network namespace |
| `mke2fs` | Create the workspace ext4 image |
| `debugfs` | Populate and extract workspace image content |
| `e2fsck` | Verify the workspace image after creation |
| `rsync` | Stage workspace content for `debugfs` import |
| `sha256sum` | Artifact digest verification in CI scripts |
| `timeout` | Bounded tool invocations in CI scripts |
| `docker` | Docker Engine (host-visible, local Unix socket) |
| `docker compose` v2 | Compose v2 for Squid/API proxy infrastructure |
| `sudo` | Passwordless sudo for jailer and netns setup |

:::note
The Docker daemon must be reachable via a local Unix socket. A remote Docker
host (e.g., `DOCKER_HOST=tcp://...`) is rejected at preflight because the
infrastructure bridge created by Docker Compose must be directly visible on the
host's network stack.
:::

### Required kernel controls

The following host kernel paths must be readable:

- `/proc/sys/net/ipv4/ip_forward`
- `/proc/sys/net/ipv6/conf/all/disable_ipv6`
- `/proc/sys/kernel/seccomp/actions_avail`

One of the following cgroup hierarchies must be available:

- `/sys/fs/cgroup/cgroup.controllers` (cgroup v2)
- `/sys/fs/cgroup` writable (cgroup v1)

### Operator account

AWF must be invoked through `sudo` from a **non-root** account. The jailer
specifically rejects a root `SUDO_UID`/`SUDO_GID` (the actual uid inside the
jail must be non-root). The `SUDO_UID` and `SUDO_GID` environment variables set
by sudo are used to determine the jailer uid/gid and the guest execution identity.

---

## Part 5 — Artifact policy

### Why artifacts are operator-managed

The Firecracker preview does **not** auto-download any artifacts. There is no
"latest" mode, no demo asset, and no unverified download path. Every artifact
must be:

1. Obtained by the operator from a trusted source
2. Supplied by absolute path on the CLI or in the config file
3. Accompanied by its exact SHA-256 digest

At runtime, AWF computes the SHA-256 of every artifact file and compares it to
the supplied digest before the VM boots. A mismatch is a hard failure with no
retry.

### Required artifacts

| Artifact | CLI flag | Digest flag | Description |
|----------|---------|-------------|-------------|
| Firecracker binary | `--firecracker-binary` | `--firecracker-binary-sha256` | Firecracker VMM binary, **must be v1.16.1** |
| Jailer binary | `--firecracker-jailer-binary` | `--firecracker-jailer-sha256` | Jailer binary, same version as Firecracker binary |
| Guest kernel | `--firecracker-kernel` | `--firecracker-kernel-sha256` | A KVM-compatible Linux bzImage |
| Guest rootfs | `--firecracker-rootfs` | `--firecracker-rootfs-sha256` | Ext4 base image; staged as a private writable copy per run |
| Guest supervisor | `--firecracker-supervisor` | `--firecracker-supervisor-sha256` | AWF vsock supervisor binary |

All five digests are required. Supplying any subset causes a hard pre-boot
validation failure.

### Version pin

The Firecracker binary and jailer binary are both pinned to **v1.16.1**. The
preflight:

1. Runs `firecracker --version` and `jailer --version`
2. Parses the version strings
3. Requires both to report exactly `1.16.1`
4. Requires both to match each other

Any version mismatch — including a newer Firecracker release — fails preflight.

### Artifact file security requirements

Each artifact file is validated for:

- **Absolute path** — relative paths are rejected
- **Regular file** — symbolic links are rejected
- **Not group- or world-writable** — mode bits `o022` must not be set
- **Owned by root or the operator uid** — other owners are rejected
- **Correct access mode** — Firecracker/jailer binaries must be executable; kernel/rootfs/supervisor must be readable

### Releasing test artifacts

The release workflow and `test-firecracker.yml` (see §CI workflow) build the
same reproducible artifact set:
`release/firecracker-test-x86_64/awf-firecracker-test-x86_64.tar.gz`.
The release workflow publishes the tarball, checksum manifest, build manifest,
and SPDX SBOM as versioned GitHub Release assets. CI uploads the unpacked set as
a 7-day workflow artifact for validation.

This tarball contains:

| File | Description |
|------|-------------|
| `firecracker` | Firecracker v1.16.1 binary (extracted from upstream release, SHA-256 verified) |
| `jailer` | Jailer v1.16.1 binary |
| `vmlinux.bin` | Linux 6.1.141 bzImage built from upstream source with a pinned kernel config |
| `rootfs.ext4` | Minimal BusyBox + supervisor rootfs image |
| `awf-firecracker-supervisor` | AWF guest supervisor binary |
| `SHA256SUMS` | SHA-256 digests for all five files |
| `manifest.json` | Human-readable manifest of versions and build inputs |
| `sbom.spdx.json` | SPDX 2.3 software bill of materials |

:::danger[Test artifacts — not production defaults]
The release artifact set is an **x86_64 test/preview artifact set**. It is
purpose-built for integration testing and preview evaluation. It is:

- **Not** an auto-downloaded default
- **Not** a production-ready distribution
- **Not** intended for use as a stable base for production workloads without
  independent review
- **Distributed only as an explicitly named test/preview GitHub Release asset**,
  never selected or downloaded automatically by AWF

Production use requires operators to obtain, verify, and manage their own
kernel and rootfs images appropriate to their workload security requirements.
The published `firecracker-test-x86_64.SHA256SUMS` covers the five extracted
runtime files, not the tarball itself; extract the bundle before checking it.
:::

### Guest kernel requirements

Operators who want to supply their own guest kernel (recommended for production
evaluation) must use a Linux kernel built with a KVM-microVM-compatible
configuration. The Firecracker project publishes reference kernel configs at
`resources/guest_configs/` in the Firecracker repository. The kernel pin in the
test artifact set is **Linux 6.1.141** with the upstream Firecracker CI config
`microvm-kernel-ci-x86_64-6.1.config`.

Operators are responsible for ensuring their guest kernel is:

- A KVM guest kernel (not a full machine kernel)
- Compatible with Firecracker v1.16.1
- Sourced from a trusted build and verified by digest

AWF does not impose a specific kernel version beyond the version of the
Firecracker binary that boots it.

---

## Part 6 — Workspace image semantics

### What gets copied into the VM

Before boot, AWF creates a writable ext4 image (`workspace.ext4`) sized to hold
the workspace with 128 MiB headroom (minimum 256 MiB, maximum 8 GiB). The image
file is created exclusively with host mode `0600`, so a pre-existing path cannot
be reused and only the operator can read or modify the staged workspace image. It
contains:

- The entire `$GITHUB_WORKSPACE` (or `cwd()` if the variable is unset) directory,
  copied via `rsync` then loaded into the image via `debugfs`
- A `.awf-home` subdirectory at the workspace root, used as `$HOME` inside the
  guest (`/workspace/.awf-home`)

:::caution[No virtiofs, no live bind mounts]
The Firecracker preview does **not** use virtiofs or any live filesystem
passthrough. The host workspace is snapshotted at boot time into a bounded ext4
image. Changes the host makes to the workspace directory after the VM boots are
not visible to the guest, and changes the guest makes are not visible to the
host until copy-back completes after the agent exits.
:::

### Copy-back and conflict detection

After the agent command exits, AWF extracts the workspace image content via
`debugfs` and compares it to the pre-run manifest:

- **New or modified files** — written back to the host workspace
- **Deleted files** — removed from the host workspace by the authoritative
  `rsync --delete` copy-back
- **Conflict detection** — any concurrent host-only or divergent host/guest
  change aborts copy-back rather than overwriting host work; AWF preserves the
  changed raw workspace image for recovery

### Recovery image

If copy-back fails partway through, AWF writes the raw `workspace.ext4` to a
recovery path (`<workDir>/firecracker-recovery/<runId>-workspace.ext4`) before
cleanup. This allows manual recovery using standard `debugfs` or `mount` tools.
The recovery path is logged at `warn` level so it is visible even if the overall
command exits non-zero.

### Bounded image size

The workspace image is bounded to a maximum of **8 GiB** by default
(`FIRECRACKER_DEFAULT_MAX_WORKSPACE_IMAGE_BYTES`). If the workspace content
exceeds this bound (after accounting for the 128 MiB headroom), preflight fails
with an explicit size error before the VM is launched.

---

## Part 7 — Networking and egress guarantees

### Network topology

Each Firecracker run gets a **dedicated network namespace** named `awffc-<runId>`.
Inside the namespace:

- A **veth pair** connects the namespace to the host infrastructure bridge
  (the same bridge used by the Docker Compose Squid/API-proxy services)
- A **TAP device** connects the namespace to the Firecracker VMM
- **nftables rules** are installed that:
  - Allow guest → Squid (`172.30.0.10:3128`)
  - Allow guest → API proxy (if enabled)
  - Drop all other guest-initiated outbound connections

### Guest IP addressing

Guest VMs are assigned IPs from the `100.64.0.0/10` range (IANA shared address
space), using `/30` subnets. Each run gets a unique `/30` subnet derived from
a 20-bit hash of the run ID, providing up to ~1 million distinct slots.

### What the guest cannot reach

| Target | Status |
|--------|--------|
| Arbitrary internet hosts (direct) | **Blocked** — all direct egress denied |
| Arbitrary TCP/UDP (not via Squid) | **Blocked** |
| Raw DNS (port 53, including 8.8.8.8) | **Blocked** — `/etc/resolv.conf` is empty; direct DNS denied |
| EC2/GCP/Azure metadata (`169.254.169.254`) | **Blocked** — link-local range blocked |
| Multicast (`224.0.0.0/4`) | **Blocked** |
| Host Docker socket | **Not accessible** — no socket mount |
| Host network | **Not accessible** — isolated namespace |
| Squid proxy | **Allowed** — all HTTP/HTTPS goes through Squid; Squid enforces `--allow-domains` ACL |
| API proxy | **Allowed** (mandatory in Firecracker) — credential injection only |

### DNS in the guest

The guest rootfs has an intentionally empty `/etc/resolv.conf`. The comment in
the file states: _"Direct DNS is intentionally unavailable in the Firecracker
preview."_

Hostname resolution for allowed domains goes through the Squid proxy's own DNS
resolution on the host. The guest does not perform independent DNS lookups. This
design means the guest cannot bypass the Squid domain ACL by resolving allowed
domain IPs and connecting to them directly — any direct IP connection is blocked
at the nftables layer.

### Egress is proxy-mandatory

All outbound HTTP/HTTPS traffic from the guest must go through the Squid proxy.
AWF sets `HTTP_PROXY`, `HTTPS_PROXY`, and related variables in the guest
environment pointing to Squid. Tools that ignore these variables (or that make
direct TCP connections) will fail because the nftables rules block direct
outbound connections.

---

## Part 8 — API proxy and credential isolation

### Why the API proxy is mandatory

Unlike older Docker and gVisor configurations where the API proxy could be optional in
non-strict mode), the Firecracker preview **requires** the API proxy. The
runtime validation enforces this:

```
Firecracker preview requires API proxy credential isolation
```

The rationale is that the API proxy is the only path by which provider
credentials (OpenAI, Anthropic, Copilot, Gemini, GitHub) can reach their
destinations. Real credential values are explicitly **never** placed in guest
environment variables.

### Credential isolation enforcement

At the moment the guest environment is assembled, AWF runs an explicit assertion
(`assertNoProviderSecrets`) that scans every guest environment variable value
for any substring matching a configured provider credential. If a match is found,
AWF throws:

```
Refusing to pass a real provider credential through Firecracker guest variable <name>
```

This is a hard failure before the VM boots. The check covers:
- `openaiApiKey`
- `anthropicApiKey`
- `copilotGithubToken`
- `copilotProviderApiKey`
- `geminiApiKey`
- `googleApiKey`
- `githubToken`

### How credentials flow

Provider API calls made by the agent:
1. Guest provider base URLs point directly at the API proxy's IP:port (e.g.,
   `http://172.30.0.30:10001`); that IP is also listed in `NO_PROXY`, so the
   request goes straight to the API proxy without traversing Squid
2. API proxy injects the real `Authorization` / `x-api-key` header
3. API proxy's own upstream request to the real provider goes through Squid
   (domain-ACL enforced)
4. Response is relayed back to the agent

The guest never sees the real credential value; it sees only the API proxy
endpoint, which is accessible only from inside the AWF network. Squid enforces
egress policy on the API proxy's outbound request, not on the guest's request
to the API proxy.

### API proxy connectivity probe

After the VM boots but before the agent command is sent, AWF probes the API
proxy's `/reflect` endpoint from inside the guest:

```sh
curl --fail --silent --show-error --max-time 5 --noproxy '*' \
    --output /dev/null http://<apiProxyIp>:10000/reflect
```

If this probe fails, the agent command is never started and the VM is shut down.
The probe timeout is bounded at 15 seconds total (shared with the Squid probe).

---

## Part 9 — Lifecycle, signals, and partial-start cleanup

### Normal lifecycle

```
preflight → infrastructure start → network namespace create →
workspace image create → jailer launch → VM boot → supervisor handshake →
connectivity probe → agent execution → copy-back → cleanup
```

### Signal handling and cancellation

When the AWF process receives `SIGTERM` or is cancelled:

1. AWF calls `manager.cancel()` with reason `"AWF cleanup"`, which sends a
   cancellation message over vsock to the supervisor
2. AWF waits up to **3 seconds** (`FIRECRACKER_CANCEL_GRACE_MS`) for the active
   execution to finish
3. AWF calls `manager.stop()` which terminates the Firecracker process and
   removes the jail
4. The network namespace and all associated interfaces are cleaned up
5. The workspace image and staging directories are removed (unless
   `--keep-containers` was given)

The CI live-smoke test verifies this: it sends `SIGTERM` after the namespace
appears, waits for the process to exit, and asserts no namespace residue remains.
Expected exit code after `SIGTERM` is **143** (128 + 15).

### Partial-start cleanup

If the VM fails to start after the jailer has been launched (e.g., a bad rootfs,
an API timeout, or a vsock handshake failure), AWF performs the same cleanup
sequence as normal stop. Workspace images, the jail directory, and the network
namespace are all removed. The cleanup result is logged; if cleanup itself fails,
the combined error (startup failure + cleanup failure) is reported with both
causes.

### Keep mode (`--keep-containers`)

When `--keep-containers` is set:

- The network namespace `awffc-<runId>` is **not** deleted
- The jail directory `<workDir>/firecracker-jailer/<runId>/` is **not** deleted
- The workspace image directory `<workDir>/firecracker-images/<runId>/` is **not** deleted
- AWF logs the jail root path, the image directory, and the network namespace name

On successful `--keep-containers` completion, the live-smoke test verifies:

```
sudo ip netns list | grep -q '^awffc-'  # namespace preserved
test -d "$keep_work/firecracker-jailer"  # jail preserved
```

Preserved resources must be cleaned up manually. See §Troubleshooting for
manual cleanup commands.

### Resource residue policy

Any network namespace matching `awffc-*` that persists after a run is considered
residue. The CI workflow's final step enforces this:

```bash
while read -r namespace _; do
  case "$namespace" in
    awffc-*) sudo ip netns delete "$namespace" ;;
  esac
done < <(sudo ip netns list)
if sudo ip netns list | grep -q '^awffc-'; then
  echo "::error::Firecracker namespace residue remains after cleanup"
  exit 1
fi
```

Operators should include a similar cleanup step in any runner maintenance workflow.

---

## Part 10 — CPU and memory controls

### Virtual CPUs

Default: **2 vCPUs**. Configure with `--firecracker-vcpus <count>`.

The guest vCPU count maps directly to Firecracker's vCPU configuration. The host
kernel schedules these as regular Linux threads inside the jailer process. There
is no CPU pinning by default; operators who need it should apply host-side cgroup
CPU sets to the jailer cgroup.

### Memory

Default: **512 MiB**. Configure with `--firecracker-memory-mib <mib>`.

The memory limit is enforced by Firecracker's VMM; the guest cannot exceed the
configured allocation. The host-side cgroup enforced by the jailer also applies
the allocation. Memory is not overcommitted within a single run.

### Jailer cgroup enforcement

The Firecracker jailer places the VMM process in a cgroup. AWF's preflight
detects whether cgroup v1 or v2 is available and passes the version to the
jailer. The jailer creates its own cgroup hierarchy under its assigned uid/gid
group. Operators can apply additional cgroup controls (memory limits, CPU shares)
at the runner level by configuring the jailer's parent cgroup.

---

## Part 11 — Bounded diagnostics, logging, and metrics

### What is collected

When `--keep-containers` is used or when `collectDiagnostics()` is called (e.g.,
on workflow failure), AWF writes the following to `<auditDir>/firecracker/`:

| File | Content | Size bound |
|------|---------|-----------|
| `network-plan.json` | Full network plan including namespace name, veth names, TAP name, IP assignments, allowed endpoints | Small (JSON) |
| `firecracker.log` | Firecracker VMM log (passed via the Firecracker API) | **1 MiB total** (truncated by AWF capture) |
| `firecracker.metrics.jsonl` | Firecracker metrics JSONL stream | **1 MiB total** (truncated by AWF capture) |
| `jailer-stdout.log` | Jailer process stdout capture | **1 MiB total** |
| `jailer-stderr.log` | Jailer process stderr capture | **1 MiB total** |

All captured diagnostic files are individually bounded at **1 MiB**
(`FIRECRACKER_CAPTURE_LIMIT_BYTES = 1024 * 1024`). Files that exceed the capture
limit are truncated; the truncation is silent (no error thrown).

The CI live-smoke test asserts this bound:

```bash
find "$keep_audit/firecracker" -type f -size +1048576c -print -quit \
  | grep -q . && {
    echo "Firecracker diagnostic artifact exceeded the 1 MiB bound" >&2
    exit 1
  }
```

### What the CI diagnostic collection step gathers

The CI workflow's "Collect redacted diagnostics" step gathers only:

- Files under `*/audit/*`
- Files under `*/proxy-logs/*`
- `stdout.log` and `stderr.log` for each test case

Before uploading, the step scans all collected files for the secret sentinel
string (`awf-firecracker-real-secret-do-not-expose`). If found, the step fails
the workflow with an error annotation.

### Proxy logs

Squid access logs (`proxy-logs/`) are collected as in all other AWF runs. These
contain the Squid access log with per-request domain decisions (`TCP_TUNNEL`,
`TCP_DENIED`, etc.). Since the Firecracker guest always proxies through Squid,
the proxy logs are the definitive record of what the agent accessed.

### Structured logging

AWF emits structured JSON logs at the host level (not inside the guest). Key
Firecracker-specific log entries include:

- `[firecracker] Agent command exited with code <N>` — normal agent exit
- `[firecracker] Guest supervisor, Squid, and API proxy connectivity verified` — successful probe
- `[firecracker] Preserved jail: <path>` — keep-mode notification
- `[firecracker] Preserved images: <path>` — keep-mode notification
- `[firecracker] Preserved network namespace: <name>` — keep-mode notification

---

## Part 12 — Topology and feature restrictions

The following features are **fail-closed** in the Firecracker preview: requesting
any of them produces a hard validation failure before the VM is launched.

| Feature | Status | Error |
|---------|--------|-------|
| Topology peers (`--topology-attach`) | **Rejected** | "topology peers and enclaves are disabled" |
| Enclaves (`enclaves.enabled`) | **Rejected** | Same as above |
| Docker-in-Docker (`--enable-dind`) | **Rejected** | "does not support Docker-in-Docker or split filesystems" |
| Split Docker host path prefix | **Rejected** | Same as above |
| ARC DinD runner topology | **Rejected** | Same as above |
| Host access (`--enable-host-access`) | **Rejected** | "does not support host access" |
| Host ports (`--allow-host-ports`) | **Rejected** | Same as above |
| Host service ports | **Rejected** | Same as above |
| Extra volume mounts (`--volume-mount`) | **Rejected** | "does not support additional host volume mounts" |
| DNS-over-HTTPS (`--dns-over-https`) | **Rejected** | "does not support DNS-over-HTTPS" |
| TTY (`--tty`) | **Rejected** | "guest supervisor does not support TTY execution" |
| Remote Docker host (non-Unix socket) | **Rejected** | "requires a local Unix-socket Docker daemon" |
| Disabled API proxy (`--no-enable-api-proxy`) | **Rejected** | "requires API proxy credential isolation" |
| Legacy security mode (`--legacy-security`) | **Rejected** | "requires strict --network-isolation security" |

:::caution[Enclaves never fall back]
If enclaves are enabled in the config and `--container-runtime firecracker` is
selected, the validation failure is immediate and hard. There is no fallback to
a non-Firecracker runtime. If you need enclaves, use a different runtime.
:::

### Primary agent only

The Firecracker backend supports **only the primary agent** execution path. It
does not participate in the enclave executor stack (script executor or agent
executor). Enclave executors that select `firecracker` as their runtime will
fail validation.

---

## Part 13 — CLI reference

### Minimal invocation

```bash
sudo -E awf \
  --container-runtime firecracker \
  --firecracker-preview \
  --firecracker-binary /path/to/firecracker \
  --firecracker-jailer-binary /path/to/jailer \
  --firecracker-kernel /path/to/vmlinux.bin \
  --firecracker-rootfs /path/to/rootfs.ext4 \
  --firecracker-supervisor /path/to/awf-firecracker-supervisor \
  --firecracker-binary-sha256 <64-hex-chars> \
  --firecracker-jailer-sha256 <64-hex-chars> \
  --firecracker-kernel-sha256 <64-hex-chars> \
  --firecracker-rootfs-sha256 <64-hex-chars> \
  --firecracker-supervisor-sha256 <64-hex-chars> \
  --allow-domains example.com \
  -- my-agent-command
```

:::note
`sudo -E` is required. The `-E` flag preserves environment variables (including
`GITHUB_WORKSPACE` and provider token variables). The jailer requires root.
Firecracker options derive the non-root jail identity from `SUDO_UID`/`SUDO_GID`.
:::

### Full CLI option reference

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--container-runtime firecracker` | string | — | **Required.** Selects the Firecracker backend. |
| `--firecracker-preview` | boolean | false | **Required.** Explicit opt-in gate. Artifact flags do not bypass this gate; the runtime refuses to start without it. |
| `--firecracker-binary <path>` | string | `/usr/local/bin/firecracker` | Absolute path to the Firecracker v1.16.1 binary. |
| `--firecracker-jailer-binary <path>` | string | `/usr/local/bin/jailer` | Absolute path to the matching jailer binary. |
| `--firecracker-kernel <path>` | string | — | **Required.** Absolute path to the guest Linux kernel image. |
| `--firecracker-rootfs <path>` | string | — | **Required.** Absolute path to the guest rootfs ext4 image. |
| `--firecracker-supervisor <path>` | string | — | **Required.** Absolute path to the AWF guest supervisor binary. |
| `--firecracker-vcpus <count>` | integer | 2 | Guest virtual CPU count. |
| `--firecracker-memory-mib <mib>` | integer | 512 | Guest memory in MiB. |
| `--firecracker-api-timeout-ms <ms>` | integer | 5000 | Bounded Firecracker API socket readiness timeout in milliseconds. |
| `--firecracker-binary-sha256 <digest>` | string | — | **Required.** 64-character hex SHA-256 of the Firecracker binary. |
| `--firecracker-jailer-sha256 <digest>` | string | — | **Required.** 64-character hex SHA-256 of the jailer binary. |
| `--firecracker-kernel-sha256 <digest>` | string | — | **Required.** 64-character hex SHA-256 of the guest kernel. |
| `--firecracker-rootfs-sha256 <digest>` | string | — | **Required.** 64-character hex SHA-256 of the guest rootfs. |
| `--firecracker-supervisor-sha256 <digest>` | string | — | **Required.** 64-character hex SHA-256 of the AWF guest supervisor. |

### Using test artifacts

If you have unpacked `awf-firecracker-test-x86_64.tar.gz` to `$ARTIFACTS`:

```bash
# Read digests from SHA256SUMS
ARTIFACTS=/path/to/firecracker-test-x86_64
digest() { awk -v f="$1" '$2==f{print $1;exit}' "$ARTIFACTS/SHA256SUMS"; }

sudo -E awf \
  --container-runtime firecracker \
  --firecracker-preview \
  --firecracker-binary   "$ARTIFACTS/firecracker" \
  --firecracker-jailer-binary "$ARTIFACTS/jailer" \
  --firecracker-kernel   "$ARTIFACTS/vmlinux.bin" \
  --firecracker-rootfs   "$ARTIFACTS/rootfs.ext4" \
  --firecracker-supervisor "$ARTIFACTS/awf-firecracker-supervisor" \
  --firecracker-binary-sha256   "$(digest firecracker)" \
  --firecracker-jailer-sha256   "$(digest jailer)" \
  --firecracker-kernel-sha256   "$(digest vmlinux.bin)" \
  --firecracker-rootfs-sha256   "$(digest rootfs.ext4)" \
  --firecracker-supervisor-sha256 "$(digest awf-firecracker-supervisor)" \
  --allow-domains example.com \
  -- curl -s https://example.com
```

### Config file equivalent

```json
{
  "containerRuntime": "firecracker",
  "firecracker": {
    "previewEnabled": true,
    "firecrackerBinary": "/path/to/firecracker",
    "jailerBinary": "/path/to/jailer",
    "kernelPath": "/path/to/vmlinux.bin",
    "rootfsPath": "/path/to/rootfs.ext4",
    "supervisorPath": "/path/to/awf-firecracker-supervisor",
    "vcpuCount": 2,
    "memoryMib": 512,
    "apiTimeoutMs": 5000,
    "sha256": {
      "firecracker": "<64-hex-chars>",
      "jailer": "<64-hex-chars>",
      "kernel": "<64-hex-chars>",
      "rootfs": "<64-hex-chars>",
      "supervisor": "<64-hex-chars>"
    }
  }
}
```

---

## Part 14 — CI workflow

### Trigger conditions

The Firecracker CI workflow (`test-firecracker.yml`) triggers **only** on:

- `workflow_dispatch` — manual trigger from the Actions UI or `gh workflow run`;
  `run_live_kvm: false` validates the deterministic artifact build without
  queueing the KVM job
- Any pull request open, synchronize, or reopen event builds and verifies the
  deterministic guest artifacts on `ubuntu-24.04`
- A pull request being **labeled** with `firecracker-kvm` additionally enables
  the live KVM job

It does **not** run on push or schedule. Unlabeled pull requests run only the
artifact build; the live KVM job runs only when explicitly requested by manual
dispatch or the `firecracker-kvm` label.

### Jobs

#### `build-test-artifacts` (runs on `ubuntu-24.04`)

This job runs on a GitHub-hosted `ubuntu-24.04` runner. It does **not** require
KVM. It:

1. Checks out the repository
2. Sets up Go 1.25.0
3. Installs deterministic build prerequisites (`bc`, `binutils`, `bison`,
   `build-essential`, `cpio`, `e2fsprogs`, `file`, `flex`, `libelf-dev`,
   `libssl-dev`, `rsync`, `xz-utils`)
4. Runs `guest/firecracker/build-test-artifacts.sh` — downloads Firecracker
   v1.16.1 (SHA-256 verified), Linux 6.1.141 (SHA-256 verified), BusyBox 1.36.1
   (SHA-256 verified), and a pinned CA bundle; builds kernel, BusyBox, and
   supervisor; creates rootfs; produces `SHA256SUMS`, `manifest.json`, and
   `sbom.spdx.json`; archives everything as
   `release/firecracker-test-x86_64/awf-firecracker-test-x86_64.tar.gz`
5. Runs `guest/firecracker/verify-test-artifacts.sh` against the output
6. Attests artifact provenance via `actions/attest-build-provenance`
7. Uploads `release/firecracker-test-x86_64/` as artifact `firecracker-test-x86_64`
   with 7-day retention

#### `live-kvm` (runs on `ubuntu-24.04`)

This job runs on a GitHub-hosted x64 `ubuntu-24.04` runner. Its preflight
requires a readable and writable `/dev/kvm` and fails closed rather than
silently skipping the live suite if the runner lacks KVM or another required
host capability.

It:

1. Downloads the `firecracker-test-x86_64` artifact from the build job
2. Runs `scripts/ci/firecracker-host-preflight.sh` — verifies Linux, x86_64,
   `/dev/kvm`, required tools, Firecracker/jailer version strings, and all five
   SHA-256 digests via `sha256sum --check --strict SHA256SUMS`
3. Installs NPM dependencies, builds the AWF distribution, and builds the
   Squid and API proxy container images locally
4. Runs `scripts/ci/firecracker-live-smoke.sh` — the live test suite
5. Collects redacted diagnostics (audit, proxy-logs, stdout/stderr) and scans
   for the secret sentinel before uploading
6. Enforces final residue cleanup of all `awffc-*` network namespaces

### Live smoke test assertions

The live smoke test (`firecracker-live-smoke.sh`) runs these named cases:

| Case | Expected exit | Assertion |
|------|--------------|-----------|
| `allowed-https` | 0 | `wget https://example.com` succeeds and returns "Example Domain" |
| `blocked-domain` | 0 | `wget https://github.com` fails (not in `--allow-domains`) |
| `direct-egress` | 0 | Unsets `HTTP_PROXY`/`HTTPS_PROXY`; direct `wget https://example.com` fails |
| `arbitrary-tcp` | 0 | `nc -z 1.1.1.1 443` fails (direct TCP blocked) |
| `dns-denial` | 0 | `nslookup example.com 8.8.8.8` fails (direct DNS blocked) |
| `metadata-denial` | 0 | Unsets proxy vars; `wget http://169.254.169.254/latest/meta-data/` fails |
| `api-proxy-reflect` | 0 | API proxy `/reflect` endpoint reachable from guest; response contains "providers"; `env` does not contain the secret sentinel |
| `workspace-copyback` | 0 | Guest writes `.hidden`, `bin/run` (chmod 755), `run-link` (symlink); all appear on host after run |
| `exit-code` | 37 | `exit 37` inside guest propagates as AWF exit code 37 |
| `timeout-124` | 124 | `sleep 90` with `--agent-timeout 1` exits with code 124 |
| `partial-start-cleanup` | 1 | Corrupt rootfs (valid digest, invalid content) causes startup failure; no namespace residue |
| `cancellation` | 143 | `SIGTERM` after namespace appears; no namespace residue |
| `keep` (keep mode) | 0 | `--keep-containers`; namespace preserved; jail preserved; diagnostic files present; all bounded ≤1 MiB |

After every case (except `keep`), the test asserts:

- No `awffc-*` network namespaces remain
- No `fch*`, `fcn*`, or `fct*` veth/TAP interfaces remain

### Secret sentinel check

All smoke test cases set `OPENAI_API_KEY=awf-firecracker-real-secret-do-not-expose`.
After each run, the test scans `stdout.log`, `audit/`, and `proxy-logs/` for
this sentinel string. Finding it means a real credential would have leaked into
guest-visible or diagnostic output, which is a test failure.

---

## Part 15 — Troubleshooting

### Preflight failures

**`Firecracker requires Linux with KVM; found darwin`**

You are running on macOS. Firecracker is Linux/KVM only. macOS and Windows are
permanently unsupported. This development session cannot perform a live KVM boot.

**`Firecracker requires readable and writable /dev/kvm`**

The runner either lacks `/dev/kvm` (not a KVM-capable host, or a GitHub-hosted
runner) or the operator account lacks read/write access.

Check: `ls -la /dev/kvm` — if the device does not exist, the host lacks KVM
support. If it exists but is not accessible, add the user to the `kvm` group:
`sudo usermod -aG kvm $USER` (requires re-login).

**`Firecracker is pinned to v1.16.1; found v<other>`**

The Firecracker binary on the supplied path is not v1.16.1. Obtain the correct
version. Do not attempt to bypass the version check.

**`<artifact> SHA-256 mismatch: expected <A>, got <B>`**

The artifact file does not match the supplied digest. Either the wrong digest
was provided, the file was modified after download, or the file is corrupt.
Re-obtain the artifact from a trusted source and recompute the digest.

**`Firecracker jailer requires a non-root target uid/gid`**

The operator account is root (uid 0), or `SUDO_UID`/`SUDO_GID` were not set
(i.e., `sudo -E` was not used correctly). The jailer requires a non-root jail
identity. Run as a non-root user through `sudo`.

**`required host tool "<tool>" was not found on PATH`**

Install the missing tool. Common package names:
- `ip`, `sysctl`, `nft` — `iproute2`, `procps`, `nftables`
- `mke2fs`, `debugfs`, `e2fsck` — `e2fsprogs`
- `rsync` — `rsync`

**`Firecracker and Docker-in-Docker are mutually exclusive`**

The config or CLI has both Firecracker and DinD/ARC-DinD selected. Remove the
DinD-related flags. The Firecracker backend does not support Docker-in-Docker
in this preview.

### Boot failures

**`Firecracker guest connectivity probe failed with exit code <N>`**

The VM booted but the guest could not reach Squid or the API proxy within the
15-second probe timeout. Possible causes:

1. The infrastructure bridge is not ready — check `docker inspect <bridgeName>`
2. The nftables rules were not installed correctly — check with
   `sudo ip netns exec awffc-<runId> nft list ruleset`
3. The guest IP was not assigned — check the network plan in
   `<auditDir>/firecracker/network-plan.json`

Enable `--log-level debug` to see detailed network setup steps.

**`Firecracker manager did not expose the configured guest IP`**

The VM started but the guest supervisor did not report a guest IP via vsock
handshake. Check `<auditDir>/firecracker/jailer-stderr.log` for VMM errors
and `<auditDir>/firecracker/firecracker.log` for boot errors.

**API timeout (startup)**

If the Firecracker API socket does not become ready within `--firecracker-api-timeout-ms`
(default 5000 ms), startup fails. On slow hosts or under memory pressure, try
increasing to 10000 ms.

### Cleanup / residue

**Namespace residue after a failed run:**

```bash
# List residue
sudo ip netns list | grep awffc

# Remove specific namespace
sudo ip netns delete awffc-<runId>

# Remove all AWF Firecracker namespaces
sudo ip netns list | awk '/^awffc-/{print $1}' | \
  xargs -r -I{} sudo ip netns delete {}
```

**Jailer directory residue (only if stop failed):**

```bash
# Find residue
ls /tmp/awf-*/firecracker-jailer/ 2>/dev/null

# Remove (be certain this is AWF residue before removing)
sudo rm -rf /tmp/awf-<timestamp>/firecracker-jailer/<runId>
```

**Docker infrastructure (Squid/API proxy) not cleaned up:**

```bash
sudo docker compose -f /tmp/awf-<timestamp>/docker-compose.yml down --volumes --remove-orphans
```

### Workspace copy-back recovery

If copy-back fails and a recovery image was preserved:

```bash
# Mount the recovery image (requires root or loop mount capability)
sudo mkdir -p /mnt/awf-recovery
sudo mount -o loop <workDir>/firecracker-recovery/<runId>-workspace.ext4 /mnt/awf-recovery

# Browse or extract files
ls /mnt/awf-recovery/workspace/

# Unmount when done
sudo umount /mnt/awf-recovery
```

Alternatively, use `debugfs` directly:

```bash
debugfs -R 'ls /workspace' <path-to-recovery.ext4>
debugfs -R 'dump /workspace/output.txt /tmp/recovered-output.txt' <path-to-recovery.ext4>
```

---

## Part 16 — Known limitations

This section documents known gaps in the current preview. Items here are expected
to be addressed before promotion out of preview.

| Limitation | Details |
|-----------|---------|
| **x86_64 test artifacts only** | No pre-built aarch64 test artifact is released. aarch64 is accepted by preflight code but must be built by the operator. |
| **No topology peers or enclaves** | The MCP gateway path is not proved in the Firecracker network model. Topology attachment and enclave execution are disabled. |
| **No TTY** | The guest supervisor does not implement a PTY multiplexer. Interactive agents requiring TTY cannot run. |
| **No virtiofs / live bind mounts** | Workspace is snapshotted at boot. Files created on the host after VM start are not visible to the guest. |
| **No Docker-in-Docker** | The guest has no Docker daemon. Agents that build or run containers cannot use Docker inside the VM. |
| **Single agent only** | The Firecracker path supports one agent execution per VM. Multi-agent or parallel executor models are not supported. |
| **Narrow CI host support** | CI specifically supports GitHub-hosted x64 `ubuntu-24.04`; other hosts must satisfy every preflight requirement and fail closed otherwise. |
| **macOS/Windows unsupported** | Firecracker requires Linux KVM; the preview fails preflight on these hosts. |
| **No unverified latest/demo assets** | There is no "just try it" path. Operators must manage and verify all artifacts. |
| **8 GiB workspace image ceiling** | Workspaces larger than 8 GiB cannot be used with Firecracker. |
| **Workspace copy-back is authoritative** | Guest deletions are applied with `rsync --delete`. Any concurrent host-only or divergent change fails copy-back and preserves the changed image for recovery instead of overwriting host work. |
| **No DNS-over-HTTPS in guest** | The DoH proxy is a host-side service; the guest does not participate. |
