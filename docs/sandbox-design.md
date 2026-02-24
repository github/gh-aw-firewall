---
title: Sandbox design
description: Why the firewall uses Docker containers instead of microVMs for network sandboxing in CI/CD environments.
---

The firewall sandboxes AI agent network traffic using Docker containers and a Squid proxy. This document explains why Docker was chosen over alternative isolation technologies like microVMs (Firecracker, Kata Containers).

## Threat model

The firewall provides **L7 HTTP/HTTPS egress control** — it prevents AI agents from exfiltrating data to unauthorized domains. It does *not* attempt to provide full system isolation or protect against kernel exploits.

This distinction is critical: the sandbox only needs to control **network egress**, not compute, memory, or process isolation. Docker containers with iptables NAT rules are sufficient for this threat model.

:::note
For full system isolation (untrusted binary execution, kernel-level threats), a microVM approach would be more appropriate. That is not this project's scope.
:::

## Why Docker

### GitHub Actions runners are already VMs

Each GitHub Actions runner is an isolated virtual machine. The runner VM provides:

- Process and memory isolation from other tenants
- Dedicated kernel and filesystem
- Network isolation from other tenants/VMs

Adding a microVM inside this VM would create **nested virtualization** — a VM inside a VM — with minimal additional security benefit for network-only filtering.

### MicroVMs require KVM access

MicroVM runtimes (Firecracker, Cloud Hypervisor) require:

- KVM access (`/dev/kvm`), which standard GitHub-hosted runners don't expose
- Custom kernel images and rootfs preparation
- Additional orchestration tooling

Docker, by contrast, is pre-installed on GitHub-hosted Ubuntu runners and requires no additional setup.

### Fast startup

Container startup time directly impacts every workflow run:

| Approach | Typical startup | Notes |
|----------|----------------|-------|
| Docker container | ~1-2s | Image pull cached across runs |
| Firecracker microVM | ~3-5s | Kernel boot + rootfs mount |
| Kata Container | ~5-10s | Full VM boot with guest kernel |

For a firewall that wraps every AI agent invocation, these seconds compound across workflow steps.

### Filesystem sharing is trivial

The agent needs full access to the repository checkout and tool configurations (`.claude.json`, `.npm`, `.cargo`, etc.). Docker provides this through bind mounts:

```yaml
# Simplified example: AWF selectively mounts the workspace and specific paths,
# not the entire host filesystem.
volumes:
  - ${GITHUB_WORKSPACE}:/workspace:rw
  - ~/.npm:/host/home/runner/.npm:rw
  - ~/.cargo:/host/home/runner/.cargo:rw
```

See [selective mounting](./selective-mounting.md) for the full mount strategy. MicroVM filesystem sharing requires virtio-fs or 9p, which are slower and add configuration complexity for read-write overlay semantics.

## How Docker's weaker isolation is mitigated

Docker provides namespace isolation, not a hardware boundary. The firewall compensates with defense-in-depth:

### Capability dropping

The agent container starts with `NET_ADMIN` to configure iptables rules, then **drops the capability** before executing user commands:

```bash
# In entrypoint.sh
exec capsh --drop=cap_net_admin -- -c "$USER_COMMAND"
```

Without `NET_ADMIN`, agent code cannot modify iptables rules to bypass the proxy.

### Transparent traffic interception

All HTTP (port 80) and HTTPS (port 443) traffic is redirected to Squid via iptables DNAT rules in the NAT table. This is transparent to the agent — routing is enforced even if applications ignore any `HTTP_PROXY`/`HTTPS_PROXY` environment variables.

:::tip
AWF sets `HTTP_PROXY`/`HTTPS_PROXY` in the container for compatibility and defense-in-depth, but kernel-level iptables DNAT enforces routing regardless. The agent cannot bypass this from userspace without `NET_ADMIN`.
:::

### DNS restriction

DNS traffic is restricted to whitelisted servers only (default: Google DNS `8.8.8.8`, `8.8.4.4`). This prevents DNS-based data exfiltration where an agent encodes data in DNS queries to an attacker-controlled nameserver.

### Outer VM boundary

In GitHub Actions, even a complete container escape still lands inside the runner VM. The VM boundary provides the hard isolation layer.

:::caution
On bare metal or shared infrastructure without an outer VM, Docker alone would not provide sufficient isolation for running untrusted code. The firewall's security model assumes an outer VM boundary exists.
:::

## When microVMs would be the right choice

MicroVMs (Firecracker, Kata Containers) provide stronger isolation at the cost of complexity and performance. Other sandboxing runtimes like gVisor (a userspace kernel) can also harden isolation without full VM overhead. These approaches would be appropriate when:

- **Running untrusted binaries** that might attempt kernel exploits
- **Multi-tenant isolation** on shared bare-metal infrastructure
- **Regulatory requirements** mandate hardware-level separation
- **No outer VM boundary** exists (bare metal hosts)

## Summary

| Criterion | Docker | MicroVM |
|-----------|--------|---------|
| Sufficient for network egress control | Yes | Yes (overkill) |
| Available on GitHub Actions runners | Yes | No (needs KVM) |
| Startup overhead | ~1-2s | ~3-10s |
| Filesystem sharing | Bind mounts (fast) | virtio-fs/9p (slower) |
| Isolation strength | Namespace (+ outer VM) | Hardware boundary |
| Operational complexity | Low | High |

Docker is the right trade-off for a network egress firewall running inside CI/CD VMs: it provides sufficient isolation with minimal startup cost and zero additional infrastructure requirements.
