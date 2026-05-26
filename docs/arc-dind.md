# ARC + DinD notes

When using ARC runners with a split runner/daemon filesystem (`DOCKER_HOST` sidecar) and `--docker-host-path-prefix`, AWF now stages required chroot files automatically:

- invoking CLI binary (for example `copilot`, `claude`, `codex`)
- `/etc/passwd`
- `/etc/group`
- chroot `/etc/hosts`

## Remaining requirement: Node.js in the DinD-visible host filesystem

Copilot CLI still requires `node` to be available inside the chrooted runtime PATH. Ensure your DinD image (or staged host toolcache) includes Node.js.

Recommended base image for ARC DinD sidecars:

- `node:20-bookworm`

This provides a glibc userspace compatible with AWF chroot mode plus a current Node.js runtime.
