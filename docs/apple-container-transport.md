# Apple Container capability transport

> **Design note.** This describes the transport itself — the mechanism by which
> a NIC-less guest reaches AWF's services. For the user-facing runtime
> (requirements, setup, options, supported and unsupported features, cleanup,
> diagnostics), see [apple-container-runtime.md](apple-container-runtime.md).

## Problem

The Apple Container agent VM is launched with `--network none`. That is not a
hardening flag that can be traded away — omitting `--network` attaches Apple's
default vmnet network, so the flag is the *only* thing standing between the
agent and unfiltered egress. Apple Container has no daemon-side forced-proxy
setting, so an advisory `HTTP_PROXY` would confine nothing on its own. The
confinement is structural: the guest has zero NICs, so direct IP egress, DNS,
DoH, IPv6, raw sockets, the `169.254.169.254` metadata address, and every host
network path simply do not exist inside the VM.

A NIC-less guest still has to reach a handful of AWF services that keep running
under Docker Compose, plus — when configured — one ordinary MCP gateway that a
caller such as gh-aw starts on host loopback outside the AWF Compose project.
The only transport Apple Container offers such a guest is
`--publish-socket host_path:container_path`, which exposes one host Unix socket
at one guest path and works with no NIC attached. Most tooling — curl, npm, pip,
the agent CLIs — speaks TCP to a proxy endpoint and cannot be pointed at a Unix
socket, so both ends need a relay.

## Shape

```
 host (macOS)                        │ VM boundary │            guest (Linux)
                                     │             │
 AWF sidecar (Docker)                │             │
   127.0.0.1:3128  ◀── host relay ───┤             │
                       squid.sock ───┼──publish────┼──▶ /run/awf/transport/v1/
                                     │   socket    │        squid.sock
                                     │             │            │
                                     │             │      guest relay
                                     │             │            │
                                     │             │      127.0.0.1:3128 ──▶ agent
```

Host half: `src/apple-container/transport-*.ts`.
Guest half: `guest/apple-container-init/` (a static Linux arm64 Go binary).

## Security boundary

| Property | How it is enforced |
| --- | --- |
| Only named AWF capabilities cross the boundary | `APPLE_CONTAINER_TRANSPORT_CAPABILITIES` is a closed, frozen list with no extension point. `getAppleContainerCapability` throws on anything else. |
| No generic host network or Docker socket | The plan is the sole source of `--publish-socket` pairs. A caller-supplied socket mount is accepted only when it is byte-identical to a planned one, so `/var/run/docker.sock` — a direct escape to host root that every other guarantee here would survive — cannot be published. A bind mount that would shadow the transport directory is refused too. |
| Relays cannot be repointed | Upstreams must be IP literals on loopback or a private range. Hostnames are rejected, so no DNS lookup happens and no DNS answer can move a capability. Link-local (including the metadata address), multicast, and public addresses are refused. |
| Sockets are private to the run | A fresh `0700` directory per run, created with a non-recursive `mkdir` so collisions fail, verified for real-directory/ownership/mode/self-resolution after creation. Sockets are `chmod 0600` immediately after bind. |
| No stale or planted socket is ever reused | Binding never unlinks. An occupied path is a hard failure. |
| No `sun_path` truncation | Paths are rejected above 103 bytes, so the published path is always the bound path. |
| Workload capabilities | `NET_ADMIN`, `NET_RAW`, `SYS_ADMIN`, `SYS_MODULE`, and `SYS_RAWIO` are dropped unconditionally; adding any of them, or `ALL`, is refused rather than silently overridden. |
| Networking cannot be weakened | `applyAppleContainerTransportToRunSpec` rejects any run spec carrying a network and always emits `{ kind: 'none' }`. |
| Credentials never enter the guest | API proxy capabilities are unauthenticated from the guest's point of view. The real key is injected by the host-side API proxy sidecar, exactly as in the Docker topology, and never appears in guest env, argv, files, or logs. The diagnostics summary contains only ids, ports, and counters. |
| No silent fallback | Every failure throws. If the transport cannot be started and verified, agent execution must not begin. |

## Relays

Both relays are deliberately dumb byte pumps. Neither parses HTTP, handles
`CONNECT`, or inspects headers — parsing workload-controlled bytes on either
side of the VM boundary would be the most dangerous thing this layer could do.
Both are bounded: a concurrent-connection cap, a dial timeout, an idle timeout,
and a hard cap on buffered bytes (host side) or a fixed 32 KiB copy buffer
(guest side). Half-close is preserved in both directions, which HTTP proxying
requires.

A capability whose socket was never published fails to dial, and the connection
is closed with no data — the same fail-closed outcome as a disabled capability.

## Externally owned upstreams

Most capabilities front an AWF Compose sidecar, so AWF both publishes the host
port (loopback-scoped) and relays it. One capability does not: the ordinary MCP
gateway. gh-aw starts `awmg-mcpg` itself with a plain `docker run`, outside the
AWF Compose project, and binds it to `127.0.0.1`. AWF has no Compose service to
rewrite and no port to publish, so it is told only the port number, through
`appleContainer.mcpGatewayUpstreamPort` (`--apple-container-mcp-gateway-upstream-port`).

Consequences of that split, all of them deliberate:

- **Capabilities are a superset of publications.** `planAppleContainerInfrastructure`
  emits the external capability with no publication and no entry in
  `plan.services`, so `applyAppleContainerLoopbackPublishing` never searches the
  Compose output for a service AWF does not generate, and the preflight port
  conflict probe never reports the gateway's own listener as a collision.
- **Only a port is configurable.** The upstream host is fixed to `127.0.0.1` in
  code, so this setting cannot widen the set of addresses a relay will dial. It
  is re-validated through the same loopback/private-address predicate every
  other upstream passes, and a port AWF itself publishes is refused — otherwise
  the guest's MCP gateway endpoint could silently front Squid or a
  credential-injecting API proxy port.
- **The guest shape is unchanged.** The guest still reaches the gateway at the
  compiled-in `http://127.0.0.1:8080` (`AWF_APPLE_TRANSPORT_MCP_GATEWAY_URL`),
  whatever the host port is. No contract version bump: the host port is a host
  dial target, not part of the host/guest agreement.
- **Configuration is not readiness.** Setting the port proves nothing. The
  transport's upstream health probe must connect to the gateway before any relay
  binds, and a gateway that is not up rolls the whole transport back and
  prevents agent execution.

This is ordinary MCP infrastructure, not enclave support. Enclaves remain
rejected outright by `assertAppleContainerPreSecurityCompatibility`, as does
`--topology-attach`.

## Contract versioning

The host half (`transport-capabilities.ts`) and the guest half (`contract.go`)
are both compiled in. Nothing is negotiated at boot, so no configuration crosses
the VM boundary and there is nothing for a workload to influence. The contract
version is embedded in the guest directory path (`/run/awf/transport/v1`), so a
mismatched host and init image cannot half-work — the guest simply finds no
sockets where it expects them.

`src/apple-container/transport-contract-sync.test.ts` parses `contract.go` and
fails the build if the two halves ever diverge.

The contract is also pinned to a `container` CLI range
(`assertAppleContainerTransportCliVersion`). `--publish-socket` and
`--init-image` are the load-bearing features, and a major release could move the
init image layout, which would break the guest handoff silently.

## Guest boot handoff

The AWF init image is built from the pinned Apple init image with Apple's
original binary relocated to `/sbin/vminitd.apple` and the AWF shim installed at
`/sbin/vminitd`.

1. containerization executes `/sbin/vminitd` (the shim).
2. The shim re-execs itself with `--awf-relay` as a child, handing it a pipe on
   fd 3.
3. The child binds every allowlisted `127.0.0.1` port and writes
   `awf-relay-ready` to fd 3. Binding is all-or-nothing.
4. The shim reads exactly that token, then `syscall.Exec`s
   `/sbin/vminitd.apple`.

The handoff is an exec, not a supervision tree, so Apple's real `vminitd` keeps
PID 1 and its reaping, signal, and lifecycle semantics are exactly what Apple
shipped. The relay child is inherited and reaped by it like any other process.

Every port is bound before the exec, and therefore before the workload starts,
which removes any race between relay startup and workload startup. Ports for
capabilities the host did not publish are bound too; their dials fail closed.

Every failure path exits non-zero without exec'ing the real init: a guest that
cannot serve its capabilities never reaches the workload, so there is no window
in which an agent runs with partial egress mediation.

## Startup and teardown

`startAppleContainerTransport` is ordered and fails closed at every step: plan →
upstream health probe → private directory → bind → end-to-end verification of
every capability through its own socket. Any failure rolls everything back —
relays stopped, sockets unlinked, directory removed — and the *original* error
propagates.

Each relay is registered for rollback *before* it is started, because `start()`
binds the listener and only then verifies its mode and ownership; registering
afterwards would strand a live, still-accepting relay if that tail failed.
Cleanup removes only the sockets that actually reached `listen()`, so a
`start()` that aborted on a pre-existing path never unlinks a file this run did
not create.

`stop()` is deterministic and idempotent, and concurrent calls share one
shutdown. Only sockets this run created are unlinked and the directory is
removed non-recursively. With `preserveDiagnostics` the directory and a small
JSON summary survive for triage, but every socket is still unlinked first:
diagnostics never leave an active access path.

## What layer 3 still owns

- Runtime registry, resolver, CLI flag, and config schema entry.
- Building and publishing the pinned init image, and choosing its reference.
- Deciding the capability set from `WrapperConfig` (which sidecars are enabled).
- Mapping `AWF_APPLE_TRANSPORT_*_URL` onto provider-specific variables.
- Workspace mounts, uid/gid, and the rest of agent launch policy.
