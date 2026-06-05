# ARC + DinD Configuration

AWF supports ARC runners where the runner filesystem and Docker daemon filesystem are split (DinD sidecar patterns).

## What AWF now handles automatically

- Split-filesystem probing for `--docker-host-path-prefix`
- Chroot staging for:
  - invoking CLI binary (`copilot`, `claude`, `codex`, etc.)
  - `/etc/passwd`
  - `/etc/group`
  - generated chroot `/etc/hosts`
- DinD `DOCKER_HOST` propagation into agent/MCP environments when DinD is detected

## ARC/DinD stdin config surface

```json
{
  "container": {
    "enableDind": true,
    "dockerHostPathPrefix": "/tmp/gh-aw"
  },
  "chroot": {
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
  }
}
```

## Field behavior

- `chroot.identity.*`: applied inside entrypoint **after** `chroot /host` to override HOME/USER/LOGNAME and identity mapping hints.
- `dind.preStageDirs`: runs a short-lived staging container in DinD mode to create required workdir tree with open permissions.
- `dind.stageEngineBinary`: copies an engine binary from the runner path into daemon-visible filesystem before compose startup.
- `dind.stagingImage`: image used for short-lived staging containers.
- `dind.workDir`: target root for DinD pre-staged directory tree (`/tmp/gh-aw` default).

## Auto-detection of split filesystem setups

AWF detects likely ARC/DinD environments at startup and warns when `--docker-host-path-prefix` is missing:

- non-default unix `DOCKER_HOST` socket paths (outside `/var/run/docker.sock` and `/run/docker.sock`)
- `AWF_DIND=1`

## Runtime prerequisite

Copilot CLI still requires `node` to be available inside the chrooted runtime PATH.
