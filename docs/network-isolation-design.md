# Design: Network-Isolation (Topology) Egress + mcpg Reachability

> **Status**: Feasibility / design note for the `--network-isolation` work on PR #5237.
> **Goal**: Replace AWF's host-iptables egress enforcement (which needs `sudo`/`NET_ADMIN`)
> with **Docker network topology**, so AWF can run unprivileged — in particular inside an
> **ARC (Actions Runner Controller) Kubernetes runner**, where host-iptables is often
> unavailable.
> **Support policy**: ARC is supported **only when a Docker-in-Docker (DinD) sidecar is
> present**. ARC without a reachable Docker daemon (e.g. `containerMode: kubernetes`) is
> unsupported and AWF fails stop with a clear platform-unsupported message (see §7).

## 1. Summary

`--network-isolation` confines the agent using Docker networking instead of packet
filtering:

- The agent (and sidecars) live on `awf-net`, declared `internal: true` — an internal
  network has **no route to the host or the internet**.
- **Squid is dual-homed** (`awf-net` + an external `awf-ext` bridge) and is therefore the
  **sole** egress path; it still applies the same domain allowlist.
- No host iptables, no `NET_ADMIN`, no `sudo`.

This works today for the agent's own egress. What it does **not** yet handle is the
**MCP gateway (mcpg)** and the **gh CLI integrity proxy (DIFC)**, both of which gh-aw runs
as **host-network containers** reached via `--enable-host-access`. Topology mode
deliberately rejects `--enable-host-access`, and an `internal` network has no host route
anyway — so the standard Copilot/gh-aw harness cannot currently run under
`--network-isolation`.

This note records the analysis and the concrete path to close that gap.

## 2. Current architecture (what blocks topology mode)

gh-aw runs **two** mcpg host containers, with **different** reachability requirements:

| Instance | How it's launched | Port | Serves | Evidence (smoke-chroot.lock.yml) |
|---|---|---|---|---|
| **Gateway mode** | `docker run --network host --name awmg-mcpg … gh-aw-mcpg` | 8080 | the **agent** (MCP tools); spawns stdio child MCP servers | "Start MCP Gateway" (line 749) |
| **Proxy / DIFC mode** | `start_cli_proxy.sh`, `CLI_PROXY_IMAGE=gh-aw-mcpg` | 18443 | the agent's `gh` (via cli-proxy) **and the runner's own pre-agent `gh` steps** | "Start CLI Proxy" (line 848); `--difc-proxy-host host.docker.internal:18443` (line 906) |

Key properties:

1. **mcpg ⇄ local MCP servers is stdio**, not network. Children are `"type":"stdio"`
   (`smoke-copilot.lock.yml:767,783`) launched via `docker run -i` over the Docker socket;
   mcpg talks to them over pipes. So children need the network only for **their own**
   egress (e.g. `github-mcp-server` → `api.github.com`).
2. **mcpg can also connect to remote MCP servers over HTTP** (not just local stdio
   children). That is mcpg's own outbound traffic.
3. **The agent reaches the gateway** at `host.docker.internal:8080` only because the harness
   passes `--enable-host-access --allow-host-ports 80,443,8080`.
4. **The agent's `gh` reaches the DIFC proxy** through the cli-proxy sidecar, which opens a
   **raw TCP tunnel** to `host.docker.internal:18443`
   (`containers/cli-proxy/tcp-tunnel.js:48` — `net.connect(remotePort, remoteHost)`;
   `entrypoint.sh:16-24,48`). `gh` uses `GH_HOST=localhost:18443` so the tunnel matches the
   DIFC proxy's `localhost` cert SAN.
5. **The DIFC proxy is launched early** so the runner's **uncontainerized pre-agent steps**
   that call `gh` are integrity-filtered too — not just the agent.

`--network-isolation` rejects `--enable-host-access`
(`src/commands/validators/config-assembly.ts:127-139`) and uses an `internal` network
(`src/compose-generator.ts:234`), so #3/#4 have no host route. The tunnel in #4 is **not**
proxy-aware, so it cannot be transparently rerouted through Squid.

## 3. Spike findings

- **gh path is provably not proxy-aware.** `tcp-tunnel.js` is a 75-line raw TCP forwarder
  with zero proxy/`CONNECT` logic. On an internal network its `net.connect` to the host
  gateway simply has no route and fails; it will not fall back to Squid.
- **MCP tools are "mounted as CLIs."** gh-aw generates PATH wrapper CLIs (`mcp-cli/bin`,
  "Mount MCP servers as CLIs" step) that hit the gateway; their proxy-awareness is a gh-aw
  internal detail, but it's moot given the gh blocker.
- **Squid *can* be configured to reach host services** (per-port `Safe_ports`, `CONNECT`
  to non-443 Safe_ports, `localnet src 172.16.0.0/12` accepts any `awf-net` client —
  `src/squid/config-sections.ts:90-120`, `src/squid/config-generator.ts:115,135`), **but
  squid routing ≠ clients using it**: the raw-TCP gh tunnel never consults a proxy, and
  squid-to-host routing reintroduces a `host-gateway` dependency that is itself unreliable
  under ARC/DinD.

Conclusion: a Squid-allowlist-only approach ("Path A") cannot work as-built.

## 4. Trust simplification

**mcpg and its MCP servers are trusted.** Therefore we do **not** need to force their egress
through Squid. The threat model concerns the **agent** exfiltrating data; trusted
infrastructure may egress directly. This eliminates the hardest blockers:

- ✗ mcpg/remote-MCP/`HTTPS_PROXY` proxy-awareness — moot.
- ✗ Forcing child servers through Squid + injecting `HTTPS_PROXY` — not needed.
- ✗ Propagating remote MCP domains into the allowlist — not needed.
- ✗ Long-lived SSE/streaming tuning through Squid — not needed.
- ✗ Rewriting `tcp-tunnel.js` to `CONNECT` through Squid — not needed.

The problem reduces to **reachability**: let the isolated agent reach the two trusted
endpoints, while those endpoints egress freely on their own.

## 5. Proposed design

### 5.1 Gateway mode (8080) — dual-home onto `awf-net`

The gateway serves **only the containerized agent**, so it can be attached to `awf-net`:

- Launch gateway as a **bridge** container (drop `--network host`) with a **static IP** on
  `awf-net` (a "known address" the agent config points at).
- It keeps the Docker socket (network-independent) to spawn stdio children; children stay on
  daemon networking (trusted).
- It gets a second interface (or routes via the external bridge) for its own outbound to
  remote MCP servers (trusted, direct).

> Docker does not allow combining `--network host` with user-defined bridges, so the switch
> off `--network host` is the enabling change.

### 5.2 DIFC / proxy mode (18443) — bridge + published port + late attach

The DIFC proxy must serve **two planes**: the runner's **host** pre-steps (before AWF
exists) **and** the agent's cli-proxy sidecar (on `awf-net`). Plan:

1. Launch DIFC **early** as a **bridge** container with a **published host port**
   (`-p 127.0.0.1:18443:18443`). Pre-steps keep reaching `localhost:18443`; the `localhost`
   cert SAN still matches. ✅ Pre-agent integrity filtering preserved.
2. After AWF creates `awf-net`, **`docker network connect awf-net <difc-container>`** —
   attach a second interface. The cli-proxy sidecar then reaches DIFC at an **internal IP**.
3. The cli-proxy tunnel target becomes that internal IP. Its raw `net.connect` now has a
   real route — **no Squid `CONNECT` rewrite, no `host-gateway` dependency**. The
   `tcp-tunnel.js` blocker disappears for free.

### 5.3 Resulting topology

```
                 ┌──────────────── awf-net (internal: true) ────────────────┐
                 │                                                           │
   agent ────────┤  squid (dual-homed) ── awf-ext (bridge) ── internet      │
   (isolated)    │                                                          │
                 │  mcpg gateway (static IP) ── ext NIC ── remote MCP / GH   │
                 │        │ socket → stdio child MCP servers (daemon net)    │
                 │                                                          │
                 │  DIFC proxy (attached late) ←── cli-proxy sidecar tunnel  │
                 └──────────────────────────────────────────────────────────┘
   runner host ── pre-agent `gh` steps ──→ 127.0.0.1:18443 (DIFC published port)
```

## 6. Lifecycle handshake (the main new cost)

Topology introduces an ordering dependency that does not exist today:

1. gh-aw starts DIFC **early** (bridge + published port).
2. AWF starts later and **creates `awf-net`**.
3. **Someone must `docker network connect awf-net <difc-container>`** after the network
   exists, and tell the cli-proxy sidecar the DIFC internal address.

This is a new coordination point between gh-aw and AWF (either AWF performs the connect given
the container name, or gh-aw performs it post-AWF-start and passes the internal address).

## 7. ARC compatibility

**Support policy: ARC is supported only when a DinD sidecar is present.** A reachable Docker
daemon is a hard prerequisite for topology mode — `awf-net`, the late `network connect`, the
dual-homed gateway/DIFC, and mcpg's child-container launch all require one. ARC deployments
without a DinD sidecar (e.g. `containerMode: kubernetes`) are **not supported**, and AWF
**fails stop with a clear platform-unsupported message** rather than degrading (see §7.1).

- **ARC with a DinD sidecar** (what AWF targets via `--docker-host` / `--docker-host-path-prefix`):
  **supported.** All components are sibling containers on the dind daemon; `awf-net`, the late
  `network connect`, and the published DIFC port all live on that daemon. **No host-iptables,
  no `NET_ADMIN`, no `--network host`.** This is the design's payoff. Caveat: the DIFC
  **host published port** lands on the **dind** daemon, while the runner's pre-steps run in
  the **runner** container — so pre-step `GH_HOST` must point at the dind-reachable address,
  not plain `localhost`. (Pre-existing wrinkle, sharpened — not introduced here.)
- **ARC `containerMode: kubernetes`** (no Docker daemon): **not supported.** mcpg's
  socket-based child launch has nowhere to run, `awf-net`/`network connect` cannot be created,
  and there is no daemon to dual-home onto — all independent of this networking change. AWF
  detects this case and fails stop (§7.1). A future non-socket MCP-server launch model in
  gh-aw would be required to support it, tracked in §8.3.

### 7.1 Fail-stop for unsupported platforms

Topology mode adds an early preflight that runs **before** any container is created. It
fails stop with a clear, actionable message when there is no usable Docker daemon — which is
precisely the ARC-without-DinD case.

Detection (cheapest-first, no false-positives on normal local/DinD runs):

1. **Authoritative check — daemon reachability.** Resolve the effective `DOCKER_HOST` (honoring
   `--docker-host`, mirroring `src/docker-host.ts` / `src/option-parsers.ts`) and probe the
   daemon (e.g. `docker version --format '{{.Server.Version}}'`). If the daemon is unreachable,
   topology mode cannot proceed — **fail stop.** This single check covers every "no daemon"
   platform, ARC or not.
2. **Specific ARC k8s-native fingerprint — for a better message.** When the daemon probe fails
   *and* the runner looks like ARC `containerMode: kubernetes` — canonical signals are
   `ACTIONS_RUNNER_CONTAINER_HOOKS` being set (the K8s container-hook script path) and/or
   `ACTIONS_RUNNER_POD_NAME` present with no reachable socket — emit a **targeted** message
   naming the platform and the fix, instead of a generic "docker not found".

Reuse the existing DinD signal detection (`isLikelyDindEnvironment`, `dind-bootstrap.ts:21`)
and the `DOCKER_HOST` classification in `option-parsers.ts` rather than inventing new
heuristics. Example message:

```
error: --network-isolation requires a reachable Docker daemon, but none was found.
       This looks like an ARC runner without a DinD sidecar (containerMode: kubernetes).
       AWF network-isolation is only supported on ARC when a Docker-in-Docker sidecar
       is present. Add a DinD sidecar to the runner scale set, or run AWF with host
       iptables enforcement on a privileged runner.
```

## 8. Concrete changes

### 8.1 AWF (this repo)

> **Implementation status (PR #5237):** items marked ✅ are implemented on
> `fix/gvisor-workflow-healthchecks`. Item ⏳ (cli-proxy DIFC retargeting) is deferred
> because it is entangled with the gh-aw §8.2 handshake decisions.

- ✅ **`src/commands/validators/config-assembly.ts`** — `--network-isolation` still rejects
  `--dns-over-https` and `--enable-host-access` (genuine host-iptables features), but
  `--enable-api-proxy` and `--difc-proxy-host` are accepted (never rejected). Added a guard
  so `--topology-attach` requires `--network-isolation`.
- ✅ **`src/cli-workflow.ts`** — added the **late network-attach** step: after
  `startContainers` succeeds, when `config.topologyAttach` is non-empty it calls
  `connectTopologyContainers('awf-net', names)` (`docker network connect awf-net <container>`,
  idempotent). Also calls the fail-stop preflight at the start of the topology branch.
- ⏳ **`src/services/cli-proxy-service.ts`** (`AWF_DIFC_PROXY_HOST`/`AWF_DIFC_PROXY_PORT`,
  lines 67-69) — under topology, set the tunnel target to the DIFC container's **`awf-net`
  address** (internal IP or container name) instead of `host.docker.internal`. **Deferred** —
  depends on the gh-aw §8.2 handshake (which carries the internal DIFC address).
- ✅ **`src/compose-generator.ts`** — topology block builds the internal + external networks
  and now pins the internal network to a deterministic name (`name: 'awf-net'`, via
  `TOPOLOGY_NETWORK_NAME`) so the late `docker network connect` target is stable.
- ✅ **New CLI surface** — `--topology-attach <name>` (repeatable, collected into a string[])
  passes the gateway/DIFC container names so AWF can `network connect` them.
- ✅ **Tests** — `src/topology.test.ts` (preflight + connect, incl. idempotent + failure cases),
  `src/cli-workflow.test.ts` (preflight ordering + attach gating), `src/compose-generator.test.ts`
  (`name: 'awf-net'`), and `config-assembly-flags.test.ts` (topology-attach validation).
- ✅ **Fail-stop preflight (§7.1)** — `src/topology.ts` `assertTopologySupported()` probes the
  effective `DOCKER_HOST` via `docker info` and aborts (exit 1) with a clear platform-unsupported
  message when no daemon is reachable, specializing for the ARC k8s-native fingerprint
  (`ACTIONS_RUNNER_CONTAINER_HOOKS` / `ACTIONS_RUNNER_POD_NAME`). Wired in `cli-workflow.ts` and
  injected from `main-action.ts`.

### 8.2 gh-aw (compiler / harness — separate repo)

- Launch **gateway mode** as a **bridge** container with a static `awf-net`-compatible IP
  (not `--network host`); drop the `--add-host host.docker.internal:127.0.0.1` loopback trick.
- Launch **DIFC mode** as a **bridge** container with `-p 127.0.0.1:18443:18443` (published
  for host pre-steps) instead of `--network host`.
- Emit the **network-attach handshake**: pass the gateway/DIFC container names to AWF (or run
  `docker network connect` after AWF start), and set the agent's MCP gateway address +
  cli-proxy DIFC target to the **internal** addresses.
- Stop passing `--enable-host-access --allow-host-ports …` / `--difc-proxy-host host.docker.internal:…`
  when `--network-isolation` is set; pass the internal equivalents instead.
- Under ARC/DinD, point pre-step `GH_HOST` at the **dind-reachable** DIFC address rather than
  `localhost`.

### 8.3 Out of scope (tracked separately)

- ARC `containerMode: kubernetes` (no Docker daemon) — **unsupported by policy** (§7); AWF
  fails stop. Supporting it later would need a non-socket MCP-server launch model in gh-aw and
  a K8s-native dual-home (Services/NetworkPolicies instead of Docker bridges).
- Forcing **child MCP server** egress through Squid — explicitly deprioritized (trusted), but
  could later be added by launching children on an internal egress network with `HTTPS_PROXY`.

## 9. Security notes

- The dual-homed gateway/DIFC are **controlled pivots**: they bridge the isolated network to
  trusted services, but only via their **defined, guard-policied** surfaces (read-only github
  MCP, write-sink safeoutputs, DIFC integrity policy) — the same trust surface as today. No new
  network-exfil class beyond the existing tool/guard model.
- **DIFC integrity filtering is preserved**: moving the proxy to a dual-homed bridge does not
  change its policy enforcement; pre-step filtering continues via the published host port.
- Child MCP servers keep daemon-network egress (unchanged, trusted).
