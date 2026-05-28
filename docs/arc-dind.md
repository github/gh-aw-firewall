# ARC + DinD notes

When using ARC runners with a split runner/daemon filesystem (`DOCKER_HOST` sidecar) and `--docker-host-path-prefix`, AWF now stages required chroot files automatically:

- invoking CLI binary (for example `copilot`, `claude`, `codex`)
- `/etc/passwd`
- `/etc/group`
- chroot `/etc/hosts`

AWF validates the staged runner binary name before using it in chroot bootstrap paths. Per-run staged chroot-host directories remain unique and AWF prunes stale ones automatically from the shared staging root.

## Auto-detection of split filesystem setups

AWF detects likely ARC/DinD environments at startup and warns when `--docker-host-path-prefix` is missing:

- **Non-standard `DOCKER_HOST` unix socket**: any `unix://` socket outside `/var/run/docker.sock` and `/run/docker.sock` is treated as a sibling-daemon pod indicator.
- **`AWF_DIND=1`**: operators can set this environment variable to explicitly declare a DinD setup.

When either signal is present and no explicit prefix is supplied, AWF emits a warning suggesting `--docker-host-path-prefix` (for example, `--docker-host-path-prefix /tmp/gh-aw` for typical ARC layouts). The DinD probe also considers `/tmp/gh-aw` as a candidate prefix when discovering the split-filesystem layout.

## Remaining requirement: Node.js in the DinD-visible host filesystem

Copilot CLI still requires `node` to be available inside the chrooted runtime PATH. Ensure your DinD image (or staged host toolcache) includes Node.js.

Recommended base image for ARC DinD sidecars:

- `node:20-bookworm`

This provides a glibc userspace compatible with AWF chroot mode plus a current Node.js runtime.
