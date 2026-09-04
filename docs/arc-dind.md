# ARC + DinD Configuration

AWF supports ARC runners where the runner filesystem and Docker daemon filesystem are split (DinD sidecar patterns).

## Runner topology selector

The simplest way to configure AWF for ARC/DinD is through the `runner.topology` config key:

```json
{
  "runner": {
    "topology": "arc-dind"
  }
}
```

When `runner.topology` is set to `"arc-dind"`, AWF enables ARC/DinD-specific sysroot staging behavior:

| Behavior | Default | Override |
|----------|---------|----------|
| Sysroot image for `/host` base | `build-tools:<tag>` | `runner.sysrootImage` |
| Tool cache warning if under `/opt` | Emitted | Set `RUNNER_TOOL_CACHE` to shared path |

Other ARC/DinD settings (for example `network.isolation` and `dind.preStageDirs`) are configured explicitly through their own fields.

## Build-tools sysroot image

On ARC/DinD, the standard system mounts (`/usr:/host/usr:ro`, etc.) resolve to the runner container's filesystem, which is invisible to the Docker daemon's split filesystem. The `build-tools` sysroot image solves this by providing a pre-built Ubuntu 22.04 image containing system-level build infrastructure:

- **Compilers & linkers**: gcc, g++, make, cmake, autoconf, binutils
- **Dev libraries**: libssl-dev, libc6-dev, libicu-dev, zlib1g-dev
- **System utilities**: bash, coreutils, git, curl, wget, jq
- **Agent dependencies**: libcap2-bin (capsh), gosu, gnupg, gh

### How it works

1. AWF emits a `sysroot-stage` init service in the compose file
2. The init container copies the build-tools image FS into a named `sysroot` volume
3. The agent mounts the `sysroot` volume read-only at `/host`
4. `entrypoint.sh` finds `/host/bin/sh` and `capsh`, chroots successfully

```yaml
# Generated docker-compose.yml (simplified)
services:
  sysroot-stage:
    image: ghcr.io/github/gh-aw-firewall/build-tools:0.28.0
    volumes: ["sysroot:/sysroot"]
    entrypoint: ["/bin/sh", "-c"]
    command: ["cp -a /usr /lib /bin /sbin /etc /sysroot/ ..."]

  agent:
    depends_on:
      sysroot-stage: { condition: service_completed_successfully }
    volumes:
      - sysroot:/host:rw
      - /tmp/gh-aw/tool-cache:/host/tmp/gh-aw/tool-cache:ro

volumes:
  sysroot: {}
```

### Custom sysroot image

Override the default build-tools image:

```json
{
  "runner": {
    "topology": "arc-dind",
    "sysrootImage": "ghcr.io/my-org/custom-sysroot:latest"
  }
}
```

## Tool cache for language SDKs

Language SDKs (Go, Node, Java, .NET) are NOT baked into the sysroot image. They are installed on-demand by `setup-*` actions into a shared tool cache volume.

**Important**: On ARC, `RUNNER_TOOL_CACHE` must point to a shared path visible to both the runner container and the DinD daemon (e.g., `/tmp/gh-aw/tool-cache`). The default `/opt/hostedtoolcache` is invisible to the DinD daemon.

```yaml
# Early in workflow, before setup-* actions:
- run: echo "RUNNER_TOOL_CACHE=/tmp/gh-aw/tool-cache" >> "$GITHUB_ENV"
```

## Writable home under sysroot staging

Sysroot staging drops agent bind mounts whose sources the DinD daemon cannot
resolve, including AWF's own `${workDir}-chroot-home` volume for `/host$HOME`.
An explicitly supplied mount is exempt from that filter: if the caller passes
`--mount <daemon-visible-home>:$HOME:rw` (the gh-aw compiler does this for
`${RUNNER_TEMP}/gh-aw/home`), the resulting `/host$HOME` mount is kept, because
the caller vouches for the source being visible to the daemon. The exemption
matches on both source and target, so AWF's own mounts to the same target stay
subject to the filter.

A writable `/host$HOME` matters for two reasons:

- the `/dev/null` credential-hiding overlays are mounted under `/host$HOME`, and
  runc cannot create those mountpoints under a read-only parent;
- `entrypoint.sh` pre-seeds JVM build tool proxy config (`~/.m2`, `~/.gradle`)
  under the chroot home.

If no writable `/host$HOME` survives the filter, AWF logs a warning and skips
the `/host$HOME` credential overlays instead of failing container creation — the
overlays at the un-prefixed `$HOME` path (on the agent's own rootfs) are still
applied, but credential files under the chroot home are not masked for that run.
The entrypoint likewise warns and skips JVM proxy pre-seeding rather than
aborting.

## What AWF handles automatically

- Split-filesystem probing for `--docker-host-path-prefix`
- Chroot staging for:
  - invoking CLI binary (`copilot`, `claude`, `codex`, etc.)
  - `/etc/passwd`
  - `/etc/group`
  - generated chroot `/etc/hosts`
- DinD `DOCKER_HOST` propagation into agent/MCP environments when DinD is detected

## Explicit ARC/DinD config surface

For fine-grained control (or when not using `runner.topology`):

```json
{
  "container": {
    "enableDind": true,
    "dockerHostPathPrefix": "/tmp/gh-aw"
  },
  "chroot": {
    "binariesSourcePath": "/tmp/gh-aw/runner-bin",
    "identity": {
      "home": "/tmp/gh-aw/home",
      "user": "runner",
      "uid": 1001,
      "gid": 1001
    }
  },
  "dind": {
    "preStageDirs": true,
    "workDir": "/tmp/gh-aw",
    "stagingImage": "ghcr.io/github/gh-aw-firewall/agent:latest",
    "stageEngineBinary": {
      "path": "/usr/local/bin/copilot",
      "targetPath": "/usr/local/bin/copilot"
    }
  },
  "runner": {
    "topology": "arc-dind",
    "sysrootImage": "ghcr.io/github/gh-aw-firewall/build-tools:latest"
  }
}
```

## Field behavior

- `chroot.identity.*`: applied inside entrypoint **after** `chroot /host` to override HOME/USER/LOGNAME and identity mapping hints.
- `chroot.binariesSourcePath`: mounts a runner-side binaries directory at `/host/tmp/awf-runner-bin` (inside chroot: `/tmp/awf-runner-bin`) and prepends it to `PATH`, so runner-installed CLIs are visible even when `/usr` comes from the DinD daemon filesystem.
- `dind.preStageDirs`: runs a short-lived staging container in DinD mode to create required workdir tree with open permissions.
- `dind.stageEngineBinary`: copies an engine binary from the runner path into daemon-visible filesystem before compose startup.
- `dind.stagingImage`: image used for short-lived staging containers.
- `dind.workDir`: target root for DinD pre-staged directory tree (`/tmp/gh-aw` default).
- `runner.topology: "arc-dind"`: enables sysroot staging (`sysroot-stage` init service + `sysroot` volume mounted on agent at `/host:rw`).
- `runner.sysrootImage`: optional override for the sysroot image used by `runner.topology=arc-dind`.

## Sysroot staging lifecycle

When `runner.topology` is `arc-dind`, AWF starts a one-shot `sysroot-stage` service that copies
the filesystem from a build-tools image derived from the same `--image-registry` and `--image-tag`
settings as the other AWF containers (unless `runner.sysrootImage` overrides it) into a named
`sysroot` volume. The agent mounts that volume at `/host:rw`.

This image pre-installs root-required system build dependencies (for example gcc/make/cmake,
libssl-dev/libc6-dev/libicu-dev, capsh/gosu/gh) so ARC workflow steps can stay non-root.

## Tool cache path guidance for ARC

If `RUNNER_TOOL_CACHE` points under `/opt` (for example `/opt/hostedtoolcache`) AWF logs a warning
in `runner.topology=arc-dind` mode because `/opt` is commonly not visible from the DinD daemon
filesystem. Prefer a shared runner/daemon path under `/tmp/gh-aw` when possible.

## Auto-detection of split filesystem setups

AWF detects likely ARC/DinD environments at startup and warns when `--docker-host-path-prefix` is missing:

- non-default unix `DOCKER_HOST` socket paths (outside `/var/run/docker.sock` and `/run/docker.sock`)
- loopback TCP `DOCKER_HOST` endpoints (`tcp://localhost:*` or `tcp://127.0.0.1:*`) — the standard ARC RunnerScaleSet DinD sidecar configuration
- `AWF_DIND=1`

## Recommended DinD base image

For ARC DinD chroot workloads, prefer the glibc companion image:

- `ghcr.io/github/gh-aw-firewall/dind-ubuntu:latest`

It includes `docker-ce`, `libcap2-bin` (`capsh`), and Node.js preinstalled.

## Runtime prerequisite

Copilot CLI still requires `node` to be available inside the chrooted runtime PATH.

## Joining `services:` containers to `awf-net` for direct protocol access

On `runner.topology: arc-dind`, GitHub Actions `services:` containers are started
by the runner on the runner's own bridge network (`github_network_<hash>`), while
the AWF agent runs on AWF's isolated `awf-net`. These two bridges are not routed
to each other, so workloads inside the sandbox that need to speak a service's
native wire protocol (database drivers, migration tools, client libraries under
test, etc.) cannot reach `services:` containers — only HTTP(S) egress through
Squid is available from inside the agent.

The existing host-iptables-based service-port routing (`hostServicePorts`) does
not help here: on ARC/DinD, `network.isolation: docker-network` never programs
host iptables NAT rules, since network isolation is enforced entirely at the
Docker network level, not at the host firewall level.

### Verified pattern: join the *service* to `awf-net`

The supported workaround is to join the **service container** — never the
agent — onto `awf-net` after AWF creates it, using a pre-step "waiter" that
polls for the network's existence and then attaches the service container to it
with an alias the agent can resolve by name:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: postgres

steps:
  - name: Attach postgres service to awf-net
    run: |
      # Wait for AWF to create its network before attempting to join it.
      for i in $(seq 1 60); do
        if docker network inspect awf-net >/dev/null 2>&1; then
          break
        fi
        sleep 1
      done
      docker network inspect awf-net >/dev/null 2>&1 || { echo "awf-net not found"; exit 1; }

      # Resolve the running service container's ID/name (varies by runner setup).
      service_container=$(docker ps --filter "label=com.github.actions.local-repo" \
        --filter "ancestor=postgres:16" --format '{{.ID}}' | head -n1)

      # Join only the service container onto awf-net, with an alias the agent
      # can resolve (e.g. `postgres:5432` from inside the sandbox).
      docker network connect --alias postgres awf-net "$service_container"
```

Once joined, code running inside the AWF sandbox can connect directly to
`postgres:5432` (or whatever alias/port the service exposes) using the
service's native protocol, bypassing the Squid HTTP(S)-only egress path
entirely for that one container-to-container link.

This pattern has been end-to-end validated with 669/669 dotnet/Npgsql
integration tests passing against a Postgres `services:` container joined to
`awf-net` this way.

### Security note

**Only the service container may join `awf-net` — never the agent.** The whole
point of AWF is to restrict what the agent (the untrusted/AI-driven process)
can reach on the network. Joining the *agent* to the runner's own bridge
network (or otherwise bypassing Squid) would defeat the egress firewall
entirely, since traffic on that bridge is not subject to domain allowlisting.
Joining a *service* container the other direction is safe: it only adds one
more reachable peer to the agent's already-isolated network, it does not grant
the agent any new egress path out of `awf-net`, and the service is presumably
already trusted (it's declared in the workflow's own `services:` block).

### Future direction

A longer-term improvement under consideration is compiler sugar such as
`services.<name>.attach: true`, which would emit the waiter/join steps shown
above automatically instead of requiring hand-written shell in workflow
frontmatter. No such field exists yet — the manual pattern above is the only
currently supported mechanism.

## See also

- [docs/awf-config-spec.md](awf-config-spec.md) — Normative field reference and CLI mapping for all ARC/DinD config fields (`container.dockerHostPathPrefix`, `container.enableDind`, `container.dockerHost`, `chroot.*`, `dind.*`, `runner.*`)
- [docs/awf-config.schema.json](awf-config.schema.json) — Machine-readable JSON Schema for IDE validation
- [docs/environment.md](environment.md) — `DOCKER_HOST` handling, `AWF_DIND`, and split-filesystem guidance
- [docs/network-isolation-design.md](network-isolation-design.md) — `--network-isolation` design and ARC/DinD constraints
