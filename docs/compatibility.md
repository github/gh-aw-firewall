# Compatibility

This document describes Agentic Workflow Firewall (AWF) prerequisites, implemented capabilities, and CI coverage. It is not an end-to-end GitHub Agentic Workflows product support matrix.

## Environment and runner applicability

> [!IMPORTANT]
> **Firewall capability is not upstream product support.** GHES endpoint routing and ARC/DinD execution capability alone do not establish official Agentic Workflows support on GHES, or on any particular GHES release.

Keep these three kinds of evidence separate:

- **Implemented AWF capability:** code handles a configuration; it does not prove that every dependent service is available.
- **CI coverage:** the repository configures checks for specific environments. Mocked endpoint tests, live DinD tests, and live enterprise/ARC deployments are different evidence.
- **Upstream product support:** applicability and version commitments for Agentic Workflows belong to its upstream owners, not AWF.

### GitHub deployment

Choose a deployment independently of the runner topology below.

| Deployment | Implemented AWF capability | Evidence and boundary |
|------------|----------------------------|-----------------------|
| github.com (including GHEC organizations on github.com) | Public GitHub/Copilot endpoint defaults and domain filtering | Repository CI runs on github.com. This is not a promise for every engine or workflow feature. |
| GHEC with data residency (`*.ghe.com`) | Tenant-specific Copilot routing, domain auto-population, and `GH_HOST` injection | Endpoint/configuration unit tests; no live tenant deployment matrix is declared here. |
| GHES (custom hostname) | Enterprise Copilot routing, `GH_HOST` injection, and `ENGINE_API_TARGET` domain auto-population | Endpoint/configuration unit tests, not a live GHES release matrix. Routing to a cloud Copilot endpoint does not make Copilot or Agentic Workflows available on the server. |

Implementation evidence: [API domain configuration](../src/api-proxy-config-domains.ts) and [its tests](../src/api-proxy-config-domains.test.ts), [Copilot endpoint selection](../containers/api-proxy/providers/copilot-auth.js) and [routing tests](../containers/api-proxy/server.routing.test.js), and [GitHub environment injection](../src/services/agent-environment/github-actions-environment.ts). See [Enterprise configuration](enterprise-configuration.md) for endpoint selection and overrides.

### Runner topology

| Topology | AWF applicability and prerequisites | CI coverage and limitations |
|----------|-------------------------------------|-----------------------------|
| GitHub-hosted Linux | Linux Docker daemon and Compose; compatible chroot tooling | Hosted Ubuntu build and live integration checks are listed [below](#ci-test-matrix). They are not GHES or tenant-specific tests. |
| Self-hosted Linux, same runner/daemon filesystem | Same runtime prerequisites; Docker access and daemon-visible workspace/tool paths | Hosted-runner checks do not certify arbitrary self-hosted images, security policies, or persistent state. Validate the actual runner. |
| Self-hosted ARC/DinD, split runner/daemon filesystems | Accessible Docker daemon (normally a privileged DinD sidecar), shared workspace/tool cache, `DOCKER_HOST`, sysroot staging, and daemon-visible mounts | Live split-DinD CI is explicitly **not Kubernetes ARC**. ARC cluster, chart, and GHES version combinations are not established by that test. Kubernetes mode without a Docker daemon does not satisfy AWF's Docker requirements. |

AWF's default Docker network-isolation mode uses an internal agent network and a dual-homed Squid proxy, without host iptables or runner `NET_ADMIN`. Legacy iptables mode has different privilege requirements; neither mode removes the DinD daemon's privilege requirements. See [network isolation](network-isolation-design.md) and [ARC/DinD configuration](arc-dind.md), including staging, writable home/output paths, and tool-cache limitations.

### Upstream applicability and unconfirmed details

Consult the upstream-owned [Agentic Workflows enterprise guidance](https://github.github.com/gh-aw/reference/enterprise-configuration/), [self-hosted runner reference](https://github.github.com/gh-aw/reference/self-hosted-runners/), and [ARC/DinD walkthrough](https://github.github.com/gh-aw/reference/arc-dind-copilot-agent/). For Copilot licensing, policy, and connectivity, follow [upstream GHES engine prerequisites](https://github.github.com/gh-aw/troubleshooting/common-issues/#copilot-engine-prerequisites-on-ghes).

Confirm applicability for the exact compiler, engine, MCP gateway, Actions runner, and GitHub deployment versions you use. Component compatibility modes and examples are not a blanket support statement. AWF does not establish a minimum GHES release or ARC chart version; an end-to-end commitment not explicitly confirmed upstream remains **unconfirmed**, not inferred from this guide.

The authoritative support statement, cross-links from gh-aw's overview/quickstart, clarification of announcement wording, and a product/version selector on the gh-aw site require coordination with the gh-aw/Next and Docs owners. An AWF-only selector would not resolve that upstream documentation gap.

## Version-specific prerequisites and optional runtimes

Use a reviewed AWF release and matching container images; record `awf --version`, image tags/digests, and upstream component versions when validating an enterprise runner. These feature-specific floors are not a minimum GHES or ARC version:

| Feature | Version-specific guidance | Scope |
|---------|---------------------------|-------|
| GHES domain auto-population from `ENGINE_API_TARGET` | Documented since AWF v0.24.0 in the [enterprise guide](enterprise-configuration.md#auto-population-for-github-agentic-workflows) | Firewall allowlist configuration only |
| Java/.NET procfs support in chroot | Documented since AWF v0.13.13 in [chroot mode](chroot-mode.md#procfs-mounting-for-java-and-net) | Container-scoped procfs and startup capabilities; tool runtimes must still be installed |
| ARC/DinD walkthrough log-permission fixes | The [upstream walkthrough's required versions](https://github.github.com/gh-aw/reference/arc-dind-copilot-agent/#7-required-versions) specify AWF v0.27.22+ | Follow that guide's compiler and runner requirements too; this is not certification of an ARC/GHES combination |

Optional runtimes have their own prerequisites, not inherited coverage from the Docker matrix: [gVisor](gvisor-integration.md) requires an installed/configured OCI runtime, and [Docker Sandboxes](sbx-integration.md) requires its separate sandbox runtime. [Cloud Hypervisor (preview)](cloud-hypervisor-foundation.md) pins Cloud Hypervisor v53.0 and currently limits deployment to GitHub-hosted Ubuntu x86_64 KVM runners; it does not claim self-hosted/ARC support. [NVX/OpenVMM (preview)](nvx-security-design.md) requires explicit opt-in and Linux x86_64 KVM. Do not infer enterprise availability or arm64 support for these previews from standard Docker capability.

## Runtime prerequisites

### Node.js

| Version | Status | Notes |
|---------|--------|-------|
| Node.js 22.x | CI build coverage | Build Verification and live Docker/chroot checks |
| Node.js 20.x | CI build coverage | Minimum: 20.19.0 |
| Node.js 24.x | Documentation/release tooling | Used by docs CI and standalone executable packaging |
| Node.js < 20.19 | ❌ Not Supported | Below minimum engine requirement |

The minimum Node.js version for source/npm execution is specified in [`package.json`](../package.json) under `engines.node: ">=20.19.0"`. Standalone executables bundle Node.js; the sandboxed command's language runtime is a separate prerequisite.

### Ubuntu / Linux

| Version | Status | Notes |
|---------|--------|-------|
| Ubuntu 24.04 (Noble) | CI integration coverage | Explicit hosted Docker/chroot checks |
| Ubuntu 22.04 (Jammy) | CI integration coverage | Hosted chroot browser checks |
| Ubuntu 20.04 (Focal) | Not in the current CI matrix | Validate runtime and chroot tooling yourself |
| Other Linux distros | Configuration-dependent | Compatible Docker, Compose, and glibc-based chroot tooling required; iptables for legacy mode |

**Note:** Agent image bases vary by image/release. Chroot execution uses host or staged sysroot binaries and libraries, so a container image does not make all host operating systems equivalent. See [agent images](agent-images.md) and [chroot mode](chroot-mode.md).

### Docker

| Component | Minimum Version | Notes |
|-----------|-----------------|-------|
| Docker Engine | 20.10+ | Required for container networking |
| Docker Compose | v2.0+ | Used for container orchestration |

These are the [documented installation baselines](quickstart.md#prerequisites), not an exact-version CI matrix. The current CI workflows use the Docker/Compose versions provisioned on their runner images.

### GitHub Actions Runners

| Runner | Architecture | Status | Notes |
|--------|-------------|--------|-------|
| `ubuntu-latest` | x86_64 | CI coverage | Primary build/unit-test runner; OS alias can change. |
| `ubuntu-24.04` | x86_64 | CI integration coverage | Explicit Ubuntu 24.04 (Noble). |
| `ubuntu-22.04` | x86_64 | CI integration coverage | Chroot browser tests on Ubuntu 22.04 (Jammy). |
| `ubuntu-24.04-arm` | arm64 | Architecture capability, not current live CI coverage | Verify all selected images and upstream components support arm64. |
| `macos-latest` | arm64 | ❌ Not Supported | macOS runners are VMs without nested virtualization — Docker cannot run. See below. |
| `macos-*` (any) | arm64/x86_64 | ❌ Not Supported | Same limitation as above. |
| `windows-*` | x86_64 | ❌ Not Supported | AWF's Docker path requires Linux containers and compatible Linux chroot tooling. |

### Why macOS runners are not supported

GitHub-hosted macOS runners are themselves virtual machines (`Apple M1 (Virtual)`) that do not support nested virtualization. AWF requires Docker for the Squid proxy container, agent container, and MCP Gateway — all of which need a Linux VM on macOS. Docker Desktop, colima (with both `vz` and `qemu` VM types), and Apple's `container` tool were all tested and none can provide Docker on these runners. The root cause error is: `Virtualization is not available on this hardware`.

### Architecture

| Architecture | Status | Notes |
|--------------|--------|-------|
| x86_64 (amd64) | CI integration coverage | Primary hosted-runner platform |
| arm64 (aarch64) | Release artifacts available | [Release workflow](../.github/workflows/release.yml) builds Linux arm64 executables and multi-architecture images; not every image/runtime is arm64 |

## CI Test Matrix

The checked-in workflows configure the following checks (subject to their event/path filters). This describes coverage, not a claim that every run passed or a product support commitment.

| Workflow | Runner / Node.js | What it exercises |
|----------|------------------|-------------------|
| [Build Verification](../.github/workflows/build.yml) | `ubuntu-latest`; Node 20, 22 on PRs and main pushes | TypeScript build/lint and API/CLI proxy unit tests |
| [Test Coverage](../.github/workflows/test-coverage.yml) | `ubuntu-latest`; Node 20 | Root Jest unit/regression suite, including endpoint/configuration tests |
| [Chroot Integration Tests](../.github/workflows/test-chroot.yml) | Browser: `ubuntu-22.04`, `ubuntu-24.04`; languages: `ubuntu-latest`; Node 22 | Live Docker chroot execution |
| [Live Docker harness observations](../.github/workflows/test-docker-harness-observation.yml) | `ubuntu-24.04`; Node 22 | Provider-free native Docker and real split-filesystem DinD execution, explicitly not Kubernetes ARC |

No live GHES release, `*.ghe.com` tenant, or Kubernetes ARC cluster matrix is established by these checks. Validate those deployment combinations separately and keep exact versions and redacted run evidence.

## Verifying Compatibility

To check if your environment meets the requirements:

```bash
# Check Node.js version
node --version  # Should be v20.19.0 or higher

# Check Docker version
docker --version  # Should be 20.10 or higher

# Check Docker Compose version
docker compose version  # Should be v2.0 or higher

# Check Docker is running
docker info
```

## Troubleshooting

### Node.js Version Too Old

If you see errors about unsupported syntax or modules:

```bash
# Install Node.js 22 using nvm
nvm install 22
nvm use 22

# Or using apt (Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Docker Not Available

If Docker is not available:

```bash
# Install Docker on Ubuntu
curl -fsSL https://get.docker.com | sudo sh

# Add your user to the docker group
sudo usermod -aG docker $USER

# Start Docker service
sudo systemctl start docker
sudo systemctl enable docker
```

## Reporting Compatibility Issues

If you encounter compatibility issues with a supported configuration, please:

1. Check the [Troubleshooting Guide](troubleshooting.md)
2. Search existing [GitHub Issues](https://github.com/github/gh-aw-firewall/issues)
3. Open a new issue with:
   - Node.js version (`node --version`)
   - Docker version (`docker --version`)
   - Operating system and version (`cat /etc/os-release`)
   - Full error message and logs
