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

#### Native macOS sandbox evaluation (Seatbelt + pf)

**Status: evaluation only, not an implemented backend or supported runner.**
This evaluates [AWF #11712](https://github.com/github/gh-aw-firewall/issues/11712)
and [gh-aw #78360](https://github.com/github/gh-aw/issues/78360).
The recommendation is a **conditional go for a disposable-runner feasibility
spike, not for production enablement**. There is no native-macOS runtime option
to select today; existing Docker/Linux behavior and macOS rejection remain
unchanged.

The candidate runs the agent directly on Darwin, so it could use the installed
Xcode SDKs, `xcodebuild`, SwiftPM, and simulator. It requires neither Docker nor
nested virtualization. Earlier Apple Container proposals used a Linux guest on
self-hosted Apple Silicon: even if that guest could start, it would not supply
native Xcode. This proposal is a different isolation model, not a revival of
that backend.

**Proposed trust boundary**

```text
macOS: trusted supervisor + native proxies (separate from agent UID)
           |
           +-- sandbox-exec --> non-admin agent UID + descendants
                                |
                                +-- exact loopback proxy endpoint only
                                           |
                                   domain ACL --> DNS --> upstream

Linux: threat detection --> safe-output validation and execution
       (consumes untrusted macOS results; write credentials stay here)
```

All of the following are requirements for a future opt-in backend, not claims
that the current implementation meets them:

1. **Seatbelt enforcement.** Generate a `sandbox-exec` profile that denies
   network access except outbound TCP to `localhost` on the proxy's designated
   port. Seatbelt's remote filters accept `localhost` or `*`, not a numeric
   loopback address; use `pf` to enforce the proxy's exact loopback address.
   Do not allow arbitrary localhost ports, inbound listeners, direct IPv4/IPv6
   connections, UDP/QUIC, ICMP echo, or agent-side DNS. Apply restrictions
   before executing any agent-controlled command, including shell startup files
   and build scripts, and verify inheritance across child processes. Start from
   deny-by-default policy with explicit filesystem and IPC permissions; escape
   generated profile values rather than interpolating workflow text as policy.
   `sandbox-exec` is deprecated and its policy interface is not a stable public
   contract, so availability and effective enforcement need per-image checks.
2. **Native domain proxy.** Prefer native Squid with AWF's existing
   [domain ACL generation](../src/squid/config-generator.ts), rather than a
   second domain-matching implementation. Audit its generated Linux paths,
   listener bindings, source-address exemptions, and container-specific routes
   before reuse: loopback source IPs cannot distinguish the agent from trusted
   native services. Bind only the designated loopback endpoint, run outside the
   agent's Seatbelt profile under a separate trusted identity, and protect its
   executable, configuration, and logs from agent writes. Check the requested
   hostname against the ACL **before DNS resolution**, and resolve/connect only
   inside this trusted proxy. Preserve exact/subdomain/wildcard and deny-rule
   semantics, HTTP and CONNECT port restrictions, and TLS authority checks.
   Reject unapproved IP-literal destinations and prevent allowed hostnames from
   rebinding to loopback, private, link-local, or metadata addresses. Test the
   actual connected address, including IPv6 and mapped-address forms.
   Redirected requests must undergo the same checks. A domain allowlist is not
   content-level exfiltration prevention for allowed destinations.
3. **Dedicated UID and pf defense in depth.** A trusted privileged supervisor
   creates a run-specific non-admin user with no sudo authorization, admin group,
   or reusable runner credentials. Launch with a minimal environment, private
   home/tmp, and no inherited network sockets or privileged file descriptors.
   Before launch, install and verify an AWF-owned `pf` anchor restricting that
   UID's TCP/UDP egress to the designated proxy endpoint, with IPv4/IPv6 coverage.
   Do not assume a syntactically valid rule is effective: existing quick rules,
   state entries, loopback `set skip`, and UID attribution can defeat the
   intended fence. This UID-scoped rule does not cover ICMP echo, which Seatbelt
   must block, or constrain traffic sent by a system daemon on the agent's behalf;
   Seatbelt/IPC restrictions remain essential.
   The proxy UID must remain able to reach upstreams. Isolate per-run anchors
   and serialize privileged setup/cleanup so concurrent runs cannot remove
   each other's protections. Never flush the host ruleset, globally disable
   `pf`, or disrupt the runner's control connection.
4. **No delegated escape.** Allow only individually justified Unix sockets and
   Mach/XPC services. DNS via `mDNSResponder`, URL-opening helpers, Apple Events,
   launch services, and simulator/build daemons must not become unsandboxed
   network deputies. A child process inheriting Seatbelt does not prove that a
   separately launched service inherits it. Blanket Mach lookup or Unix-socket
   permission to make Xcode work is not an acceptable fix.
5. **Native control plane, not just a native agent.** The current
   [external-agent lifecycle](../src/external-runtime-backend.ts) explicitly
   retains Compose infrastructure; adding a runtime registry entry alone cannot
   remove Docker. Squid, credential-injecting API proxies, MCP gateway/server
   launch, readiness, diagnostics, and cleanup all need a non-container path.
   Model credentials stay in a trusted native proxy, never in the agent
   environment. Any local API/MCP endpoints require narrowly scoped,
   authenticated exceptions, not general localhost access or a generic relay.
   Container-only MCP servers, Docker sockets/DinD, Linux chroot/mount flags,
   and enclaves must be rejected unless separately implemented and validated.
6. **Fail-closed lifecycle.** Preflight must establish the exact runner image,
   Seatbelt behavior, UID separation, proxy health, and effective `pf` rules
   before releasing the agent. Missing privileges, unsupported options, or
   failed probes must abort, never fall back to an unsandboxed command.
   Proxy/supervisor failure must not create another egress path. On completion,
   timeout, cancellation, or partial startup failure, terminate and verify all
   agent-UID processes and attributable delegated work before removing the
   fence, proxy, files, or account. Do not recycle a UID while processes or
   matching network state remain; uncertain cleanup requires runner disposal.

**Weaker guarantee and workflow integration**

This would be host-kernel Seatbelt policy plus ordinary user permissions and
`pf`, **not** a container, VM, chroot, private filesystem view, or PID namespace.
Filesystem/process protection beyond normal UID separation depends on the
Seatbelt profile. Shared readable files, caches, host services, kernel attack
surface, and delegated processes remain concerns. A non-admin account alone
does not hide world-readable runner secrets or prevent access through an
over-permissive service. Protect the runner account, keychains, signing
identities, Actions command/environment files, proxy credentials, and
supervisor state; scope writable paths to the workspace and private build
state. Shared or persistent self-hosted Macs are outside the initial target.
Code signing with production identities is not an initial acceptance goal.

Keep threat detection and safe outputs in separate **Linux jobs**, including
their write-capable tokens. Treat all macOS artifacts, logs, paths, and proposed
outputs as untrusted data; do not execute uploaded scripts during privileged
post-processing. Moving these jobs does not repair a bypass of the macOS agent
boundary.

The upstream compiler's
[`runs_on_validation.go`](https://github.com/github/gh-aw/blob/main/pkg/workflow/runs_on_validation.go)
rejects macOS labels today. A later coordinated compiler change must require an
explicit native-sandbox opt-in for the agent job, generate native setup instead
of Docker steps, and retain Linux placement for threat detection and safe
outputs. Do not simply remove label validation. This evaluation adds no compiler
syntax, implicit fallback, or claim of upstream product support.

[Anthropic sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime#how-it-works)
is precedent for macOS Seatbelt plus localhost HTTP/SOCKS proxies and filesystem
restrictions, not evidence that AWF's UID/`pf`, Xcode, or compiler integration
already works. Compare reuse against AWF's policy and credential-custody
requirements before choosing a dependency; no dependency is added here.

**Required evidence and decision gates**

Run a bounded spike on disposable GitHub-hosted macOS VMs, recording exact image,
OS, architecture, Xcode, proxy, and policy versions. Use packet capture and
controlled authoritative-DNS logs to observe traffic, including delegated work,
rather than relying only on command exit codes. No live macOS acceptance has
been performed for this evaluation; Linux unit tests or generated policy
snapshots cannot substitute for these checks:

| Area | Required positive and adversarial checks |
|------|-----------------------------------------|
| Network policy | Allowed HTTP/HTTPS succeeds; denied hosts, sibling/suffix tricks, blocked-over-allowed rules, redirects, malformed CONNECT/Host authorities, CONNECT/SNI disagreement, unauthorized ports, and IP literals fail. Prove rejected hostnames are not resolved. |
| Bypass resistance | Unset all proxy variables; attempt raw TCP, IPv4/IPv6, UDP/QUIC, ICMP echo, DNS over UDP/TCP, system-resolver IPC, non-proxy localhost ports, private/metadata targets, rebinding, Unix sockets, and Mach/XPC deputies. Each must fail without widening policy. |
| Independent layers | In trusted test fixtures, exercise Seatbelt and the UID-scoped TCP/UDP `pf` fence separately, as well as together, including loopback skip, existing states, and rule ordering. Verify Seatbelt blocks ICMP echo; record that ICMP is outside the UID-scoped `pf` guarantee and note any other coverage differences rather than claiming interchangeable enforcement. |
| Identity and files | Agent and grandchildren cannot sudo, switch UID, inspect proxy credentials, read runner secrets/keychains, modify policy/binaries, signal trusted services, or write Actions control files. Check symlink/path aliases and shared caches. |
| Native tools | Fetch an allowlisted SwiftPM dependency and reject a denied one; run `xcodebuild` build/test and simulator launch/test under the dedicated UID. Check build plugins and simulator/system-daemon traffic, not just command exit status. |
| Failure and cleanup | Missing `sandbox-exec`, unavailable privileges, invalid profile/anchor, proxy death, port squatting (including listeners on the designated port at both `127.0.0.1` and `::1`), partial startup, timeout, cancellation, and supervisor death never produce unrestricted execution. Prove descendants/delegated work are reaped and unrelated host rules survive cleanup. |
| Workflow handoff | Native agent results reach Linux threat detection/safe outputs without exposing write tokens or running agent-supplied code outside the sandbox. Unsupported Docker-only features fail before agent launch. |

Proceed to a separately reviewed experimental backend only if those gates pass
without broad IPC/network exceptions and the residual risk is explicitly
accepted. Otherwise the result is **no-go for the affected runner/toolchain**:
keep macOS unsupported rather than relaxing the boundary to make a build pass.

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
