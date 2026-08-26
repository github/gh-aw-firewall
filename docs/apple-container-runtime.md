# Apple Container runtime (preview)

`--container-runtime apple-container` runs the AWF agent inside an Apple
Virtualization.framework VM launched by Apple's [`container`][apple-container]
CLI, instead of in a Docker container. AWF's infrastructure — Squid, the API
proxy sidecar, the CLI proxy — keeps running under Docker Compose exactly as it
does for every other runtime; only the agent crosses the hypervisor boundary.

> **Preview.** Requires an explicit `--apple-container-preview` opt-in and a
> self-hosted bare-metal Apple Silicon runner. Unit- and contract-tested in
> hosted CI; end-to-end behaviour is validated only by the self-hosted live
> smoke workflow described below.

## Why this runtime is shaped the way it is

The agent VM is launched with `--network none`, so it has **zero network
interfaces**. That single flag is the confinement:

- Direct IP egress, DNS, DNS-over-HTTPS, IPv6, raw sockets, the
  `169.254.169.254` metadata address, and every host network path are
  unreachable *by construction*, not by rule. There is no firewall to
  misconfigure and no rule to race, because there is no interface to send on.
- Apple Container has no daemon-side forced-proxy setting, so `HTTP_PROXY` is
  advisory here — which does not matter, because a request that ignores the
  proxy has nowhere to go.

Omitting `--network` would attach Apple's default vmnet network and hand the
agent unfiltered egress, so AWF always emits the flag explicitly and asserts it
again immediately before the VM is created.

A NIC-less guest still has to reach AWF's own services. The only transport Apple
Container offers such a VM is `--publish-socket`, which exposes one host Unix
socket at one guest path. AWF relays a **closed allowlist** of capabilities over
it — see [apple-container-transport.md](apple-container-transport.md) for the
transport's own design and threat model.

```
 macOS host                                    │ VM boundary │      guest (Linux arm64)

 Docker Compose                                │             │
   squid-proxy   ──publish──▶ 127.0.0.1:3128 ◀─┤ AWF relay   │
   api-proxy     ──publish──▶ 127.0.0.1:1000x ◀┤   ↕ Unix    ├──▶ 127.0.0.1:3128  ──▶ agent
   cli-proxy     ──publish──▶ 127.0.0.1:11000 ◀┤   sockets   │    127.0.0.1:1000x
                                               │             │    127.0.0.1:11000
```

## Requirements

| Requirement | Why |
| --- | --- |
| **Self-hosted, bare-metal Apple Silicon runner** | Virtualization.framework needs real hardware virtualization. |
| **macOS 26 or newer** | The `container` CLI's supported baseline. |
| **`kern.hv_support=1`** | Proves the host can actually create a VM. |
| **Apple `container` CLI ≥ 0.4.0, < 1.0.0** | `--publish-socket` and `--init-image` are load-bearing and only guaranteed from 0.4.0. The upper bound is exclusive because a major release may move Apple's own init inside the init image, which would silently break the guest handoff. |
| **`container system start` healthy** | The service must be running before AWF will launch anything. |
| **Local Unix-socket Docker daemon** | AWF's infrastructure still runs under Docker Compose, and its ports must be publishable to macOS loopback. |
| **Digest-pinned `agent` and `apple-init` images** | Apple Container maintains its own image store, independent of Docker's — see [Images](#images). |

### GitHub-hosted macOS runners do not work

GitHub-hosted macOS runners are themselves virtual machines and report
`kern.hv_support=0`. AWF's preflight fails with a `hypervisor` cause code and
**does not fall back** to another runtime — a silent downgrade would run the
workload under a different, unstated isolation model.

`actions/setup-awf` will install the `awf-darwin-arm64` binary on a macOS arm64
runner, but installing the CLI is not a claim that the runtime will start there.
On a hosted runner it will fail preflight.

## Setup

```bash
# One-time, on the self-hosted runner:
brew install --cask container   # or install from https://github.com/apple/container
container system start
container system status
```

The `container` service must be running as the same user the Actions runner runs
as; it is per-user, not system-wide. Keep it running across jobs
(`container system start` is idempotent) rather than starting and stopping it
per run.

For a self-hosted Actions runner, apply an `apple-container` label **only** to
hosts where `sysctl -n kern.hv_support` prints `1`. The live smoke workflow
re-checks this and fails if the label is on a virtualized host.

## Selecting the runtime

```bash
sudo awf \
  --container-runtime apple-container \
  --apple-container-preview \
  --image-tag "0.30.0,agent=sha256:...,apple-init=sha256:..." \
  --allow-domains api.github.com \
  --enable-api-proxy \
  -- 'npx @github/copilot --prompt "..."'
```

Or in `awf.config.yaml`:

```yaml
container:
  containerRuntime: apple-container
  images:
    agent: ghcr.io/github/gh-aw-firewall/agent:0.30.0@sha256:...
    appleInit: ghcr.io/github/gh-aw-firewall/apple-init:0.30.0@sha256:...
    squid: ghcr.io/github/gh-aw-firewall/squid:0.30.0@sha256:...
    apiProxy: ghcr.io/github/gh-aw-firewall/api-proxy:0.30.0@sha256:...
appleContainer:
  previewEnabled: true
  cpus: 4
  memory: 8G
```

### Options

| Flag | Config | Default | Notes |
| --- | --- | --- | --- |
| `--apple-container-preview` | `appleContainer.previewEnabled` | `false` | Required. Without it the backend refuses to resolve. |
| `--apple-container-cpus` | `appleContainer.cpus` | `4` | Guest vCPUs. |
| `--apple-container-memory` | `appleContainer.memory` | `8G` | Integer with an optional `K`/`M`/`G`/`T`/`P` suffix. |
| `--apple-container-init-image` | `appleContainer.initImage` | derived from registry/tag | Must be digest-pinned. |
| `--apple-container-cli` | `appleContainer.cliPath` | `container` on `PATH` | Absolute path when the CLI is not on `PATH`. |
| `--apple-container-mcp-gateway-upstream-port` | `appleContainer.mcpGatewayUpstreamPort` | unset | Host loopback port of an externally started ordinary MCP gateway. See [MCP gateway](#mcp-gateway). |

### MCP gateway

gh-aw runs its MCP gateway (`awmg-mcpg`) itself, with a plain `docker run`
outside AWF's Compose project, and publishes it on host loopback with its own
authentication. AWF cannot rewrite a publication it does not own, so gh-aw
passes only the port:

```yaml
appleContainer:
  previewEnabled: true
  mcpGatewayUpstreamPort: 9100
```

AWF then relays `127.0.0.1:<port>` through an AWF-owned Unix socket into the
guest, where the workload reaches it at `http://127.0.0.1:8080`
(`AWF_APPLE_TRANSPORT_MCP_GATEWAY_URL`). The guest still has no NIC.

- **Only a port is accepted**, an integer in `1..65535`. The upstream host is
  fixed to `127.0.0.1` and is not configurable, so this cannot point a guest
  capability at another machine. A port reserved for AWF infrastructure (Squid,
  any API proxy provider port, the CLI proxy) is rejected regardless of which
  of those sidecars this run enables.
- **Valid only on this runtime.** Setting it with any other
  `--container-runtime` is an error, not a silently ignored field; every other
  runtime reaches the gateway over its own Docker network.
- **AWF publishes nothing for it** and requires no Compose service, so the
  gateway's port already being in use is the normal case rather than a
  startup conflict.
- **Configuring it is not readiness.** AWF health-probes the upstream before
  any relay binds; if the gateway is not listening, the transport rolls back
  and the agent never starts.
- **This is ordinary MCP infrastructure, not enclave support.** Enclaves stay
  rejected on this runtime (see below).

## Supported and unsupported

| Feature | Status |
| --- | --- |
| Domain allowlisting via Squid | ✅ The guest's only egress path. |
| API proxy credential isolation (OpenAI, Anthropic, Copilot, Gemini) | ✅ Unauthenticated from the guest; the real key stays in the host sidecar. |
| CLI proxy / DIFC safe outputs | ✅ Bridged as a capability when `--difc-proxy-host` is set. |
| Workspace and `${RUNNER_TEMP}/gh-aw` writes | ✅ Mounted read-write at their own absolute host paths. |
| Agent timeout, signals, exit codes | ✅ Exit codes propagate verbatim; a timeout kills the VM and reports `124`. |
| Diagnostics and `--keep-containers` | ✅ See [Diagnostics](#diagnostics-and-preservation). |
| **Google Vertex AI** | ❌ The Vertex provider port is not in the transport allowlist. Rejected at validation rather than silently losing its endpoint. |
| Ordinary MCP gateway (gh-aw `awmg-mcpg`) | ✅ Bridged as a capability when `appleContainer.mcpGatewayUpstreamPort` is set. See [MCP gateway](#mcp-gateway). |
| **Enclaves** | ❌ The enclave subsystem is a set of Docker-network peers that have not been proven reachable from a NIC-less guest. Rejected regardless of `mcpGatewayUpstreamPort`. |
| **`--topology-attach`** | ❌ Externally owned peers are not published to macOS loopback, so they cannot be bridged. |
| **Docker-in-Docker / ARC split filesystems** | ❌ The guest never receives a Docker socket. |
| **`--enable-host-access`, `--allow-host-ports`** | ❌ Only allowlisted capability sockets cross the boundary. |
| **`--legacy-security`** | ❌ Host and container iptables rules govern nothing here. |
| **DNS-over-HTTPS** | ❌ The guest resolves no names at all. |
| **`filesystem.allowWrite`** | ❌ Not yet implemented for this runtime. |
| **`--volume`, `--ssl-bump`, `--tty`, `--build-local`** | ❌ See the error messages, each of which names the reason. |
| **`agentImage: act` / custom base images** | ❌ Not published as native arm64, and Rosetta translation is never used. |

Every unsupported combination is refused during option validation or preflight,
before any container, VM, or socket exists. Nothing degrades silently.

## Images

Apple Container keeps its **own image store**, independent of Docker's. Two
consequences:

1. A Docker pre-pull (including `actions/setup-awf` with `pull-images: true`)
   does not populate it. AWF pulls the agent and init images through
   `container image pull --platform linux/arm64`.
2. `--skip-pull` is honoured by *verification*, not by assumption: AWF confirms
   each image is present in Apple's store and fails with the exact
   `container image pull` command to run if it is not.

Both references must be digest-pinned. A floating tag would let the registry
decide what runs inside the VM between the operator's decision and the launch,
with no daemon-side content trust to fall back on.

The **`apple-init`** image is Apple's own `vminit` with `/sbin/vminitd` moved to
`/sbin/vminitd.apple` and the AWF capability relay installed in its place. It is
built by [`containers/apple-init/Dockerfile`](../containers/apple-init/Dockerfile)
via [`scripts/build-apple-init-image.sh`](../scripts/build-apple-init-image.sh),
and carries labels recording the Apple base image, the transport contract
version, and the supported `container` CLI range.

Publishing it requires an `APPLE_VMINIT_IMAGE` repository variable holding a
digest-pinned reference to Apple's `vminit`. When that variable is unset the
release job is skipped and no `apple-init` digest is published — which means the
runtime simply cannot be selected from that release, rather than falling back to
an unknown init.

## Filesystem

The guest runs the agent image's own root filesystem **read-only** and receives a
short, explicit list of writable host directories:

| Guest path | Host source | Mode |
| --- | --- | --- |
| *(workspace path, unchanged)* | `$GITHUB_WORKSPACE` | rw |
| *(gh-aw path, unchanged)* | `${RUNNER_TEMP}/gh-aw`, when it exists | rw |
| `/awf/home` | `<workDir>/apple-container/home` | rw |
| `/tmp` | `<workDir>/apple-container/tmp` | rw |
| `/awf/home/.copilot/logs` | the run's agent log directory | rw |
| `/awf/home/.copilot/session-state` | the run's session-state directory | rw |

The workspace and `gh-aw` directories are mounted at their *own* absolute paths
because gh-aw passes absolute runner paths through both its environment and its
command line.

The capability sockets themselves live in a run-scoped `0700` directory under
`/tmp` (`/tmp/awf-apple-<run-id>`), **not** under the work directory. macOS caps
a Unix socket path at 104 bytes, and a realistic runner work directory
(`${RUNNER_TEMP}/awf-<timestamp>/...`) exceeds that budget, which would make the
relay unbindable. `/tmp` resolving to the 13-byte `/private/tmp` leaves ample
room; its world-writable sticky permissions are not a weakness because the
directory is created with a non-recursive `mkdir` (a pre-existing path is a hard
failure, never a reuse), forced to `0700`, and verified for type, ownership,
mode, and self-resolution before any socket is bound — and binding never
unlinks, so a squatted path fails closed.

Nothing else is mounted. There is no `/host` chroot, no sysroot, no `/etc`
cherry-picking, and no Docker socket. Host credential stores — `~/.ssh`,
`~/.aws`, `~/.docker`, the login keychain — are absent because they were never
mounted, not because they were shadowed. This is deliberately unlike the Docker
path's credential-hiding overlays, which have to temporarily mask live host
files; there is nothing to mask when the mount was never made.

The workload runs as the host `uid:gid`, so files it writes into the workspace
are owned by the runner user, and `$HOME` points at a run-scoped directory that
same uid owns.

### Entrypoint

The agent image's own entrypoint is Docker-specific end to end: it waits on the
`awf-iptables-init` ready file, remaps `awfuser`, rewrites `/etc/resolv.conf`,
chroots into `/host`, and drops `SYS_CHROOT`/`SYS_ADMIN`. None of that exists —
or is needed — in a VM whose isolation *is* the VM. AWF overrides the entrypoint
to `/bin/bash -lc <command>` rather than adapting it, so no half-applicable
Docker assumption runs.

## Threat model

| Property | How it holds |
| --- | --- |
| No unfiltered egress | `--network none` on every launch. Layer 1 defaults to it, the transport merge re-asserts it, and the backend checks it once more immediately before `container create`. Omission is treated as a security bug, not a missing default. |
| Only AWF capabilities cross the boundary | A frozen allowlist with no extension point. A socket publication the plan did not authorise — including `/var/run/docker.sock` — is refused. |
| Relays cannot be repointed | Upstreams must be loopback or private **IP literals**. Hostnames are rejected, so no DNS answer can move a capability, and link-local (including the metadata address), multicast, and public addresses are refused. |
| Infrastructure is not exposed to the network | Every port is published to `127.0.0.1` only, replacing (not supplementing) the wildcard mapping the Docker topology uses. A collision on those ports is reported by name before Compose starts. |
| No dangerous capabilities | `NET_ADMIN`, `NET_RAW`, `SYS_ADMIN`, `SYS_MODULE`, `SYS_RAWIO` are dropped unconditionally; adding any of them, or `ALL`, is refused rather than overridden. |
| Native arm64 only | The architecture is fixed at `arm64` and asserted before launch. Rosetta translation is never requested. |
| Credentials stay host-side | API proxy capabilities are unauthenticated from the guest's point of view. The real key is injected by the host sidecar and never enters guest env, argv, files, or logs; the guest environment builder re-asserts this and refuses to launch otherwise. |
| No silent fallback | An ineligible host, an unsupported CLI, an occupied port, an unpinned image, or a failed transport aborts the run with an actionable error. |

## Diagnostics and preservation

Apple Container is a VM-per-container runtime, so a failed agent has log surfaces
a Docker mental model does not cover. AWF collects, into
`<auditDir>/apple-container` or `<workDir>/diagnostics/apple-container`:

- `container-boot.log` — kernel and init output, where a VM that never reached
  the entrypoint fails.
- `container-stdio.log` — the init process's stdio.
- `system.log` — the host service log, where the daemon records why a VM was
  refused.
- `container-inspect.json`, `containers.json`, `system-status.json`.
- `transport-stats.json` — per-capability counters (ids, guest ports, upstreams,
  byte and connection totals). The relay retains no payload, so this cannot
  carry credential material.

Every capture is bounded and `--follow` is never used, so collection always
terminates.

`--keep-containers` preserves the VM (inspect with `container inspect`, remove
with `container delete`) and the run directory, and writes a transport summary
to `/tmp/awf-apple-<run-id>/transport-summary.json` (whose path is logged,
because it lives outside the work directory) — but **every capability socket is
still unlinked first**. A preserved run never leaves a live path into AWF's
credential-injecting sidecar.

## Cleanup

Normal teardown quiesces the guest before removing the transport, so a running
workload never observes its capabilities disappearing mid-request:

1. `container stop` (10s grace), escalating to `container kill` if it does not
   exit.
2. `container delete --force`.
3. Transport shutdown: every relay closed, every socket unlinked, the socket
   directory under `/tmp` removed non-recursively.
4. Docker Compose infrastructure torn down by the existing cleanup path.

A `--agent-timeout` expiry kills the VM explicitly — killing the attached
`container start` client alone would leave the guest running — and reports exit
code `124`. `SIGINT`/`SIGTERM` route through the same teardown.

## Validation status

| Layer | Coverage |
| --- | --- |
| Runtime selection, compatibility matrix, Compose publication, mounts, environment, credential filtering, image semantics, lifecycle ordering, rollback, timeout, diagnostics | Unit tests, hosted CI (`.github/workflows/test-apple-container.yml`). |
| Guest relay and init shim | Go unit tests plus a deterministic Linux arm64 build, hosted CI. |
| Host/guest contract agreement | `transport-contract-sync.test.ts` parses `contract.go`; `init-image-contract.test.ts` parses the init Dockerfile. |
| Init image layout and labels | Built and inspected in CI when `APPLE_VMINIT_IMAGE` is configured. |
| **Live VM behaviour** | `.github/workflows/smoke-apple-container.yml`, self-hosted bare metal only, `workflow_dispatch` by reviewed SHA into the protected `apple-container-live-smoke` environment. It has no pull request trigger: a public repository must not execute unreviewed code on a persistent self-hosted host. **Not yet exercised in this repository's CI.** |

Treat anything in the last row as unvalidated on real hardware until that
workflow has run green on a bare-metal runner.

[apple-container]: https://github.com/apple/container
