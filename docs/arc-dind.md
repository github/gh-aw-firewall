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
- `chroot.binariesSourcePath`: mounts a runner-side binaries directory over `/usr/local/bin` inside chroot mode so runner-installed CLIs are visible even when `/usr` comes from the DinD daemon filesystem.
- `dind.preStageDirs`: runs a short-lived staging container in DinD mode to create required workdir tree with open permissions.
- `dind.stageEngineBinary`: copies an engine binary from the runner path into daemon-visible filesystem before compose startup.
- `dind.stagingImage`: image used for short-lived staging containers.
- `dind.workDir`: target root for DinD pre-staged directory tree (`/tmp/gh-aw` default).
- `runner.topology: "arc-dind"`: enables sysroot staging (`sysroot-stage` init service + `sysroot` volume mounted on agent at `/host:rw`).
- `runner.sysrootImage`: optional override for the sysroot image used by `runner.topology=arc-dind`.

## Build-tools sysroot image

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
- `AWF_DIND=1`

## Recommended DinD base image

For ARC DinD chroot workloads, prefer the glibc companion image:

- `ghcr.io/github/gh-aw-firewall/dind-ubuntu:latest`

It includes `docker-ce`, `libcap2-bin` (`capsh`), and Node.js preinstalled.

## Runtime prerequisite

Copilot CLI still requires `node` to be available inside the chrooted runtime PATH.
