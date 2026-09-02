# Agent Image Tools

Reference guide for the development tools, utilities, and runtime versions pre-installed in the agent container images used by the firewall.

> 📘 **Note:** This document is also available in the [online documentation](https://github.github.io/gh-aw-firewall/reference/agent-images/).

## Overview

The firewall uses two main container image presets for running user commands:

- **`default`**: Lightweight Ubuntu 22.04-based image with essential dev tools (~200MB)
- **`act`**: GitHub Actions runner-compatible image based on Ubuntu 24.04 (~2GB)

### Image Selection

Use the `--agent-image` flag to choose which preset to use:

```bash
# Default agent image (lightweight)
sudo awf --allow-domains github.com -- node --version

# Explicit default preset
sudo awf --agent-image default --allow-domains github.com -- node --version

# GitHub Actions-compatible image
sudo awf --agent-image act --allow-domains github.com -- node --version
```

### Base Images

| Preset | Actual Image | Base | Purpose |
|--------|--------------|------|---------|
| `default` | `ghcr.io/github/gh-aw-firewall/agent` | `ubuntu:22.04` | Minimal development environment with Node.js, Python, git |
| `act` | `ghcr.io/github/gh-aw-firewall/agent-act` | `catthehacker/ubuntu:act-24.04` | GitHub Actions runner subset with multiple runtime versions |

**Note:** The `act` preset image inherits from [catthehacker/docker_images](https://github.com/catthehacker/docker_images), which provides medium-sized subsets of GitHub Actions runner images. For full GitHub Actions runner parity, you need the full-sized images (60GB+). See the catthehacker repository for details on runner compatibility.

## Verifying Tools Locally

Check installed tools and versions by running bash in the container:

```bash
# Verify tools in default preset image
sudo awf --allow-domains '' -- bash -c 'node --version && python3 --version && git --version'

# Verify tools in act preset image
sudo awf --agent-image act --allow-domains '' -- bash -c 'which -a node && node --version'

# Interactive exploration (default preset)
sudo awf --tty --allow-domains '' -- bash
```

## Default Preset (`default`) - Tools

The `default` preset image (based on Ubuntu 22.04) includes the following pre-installed tools:

| Tool | Version | Package | Notes |
|------|---------|---------|-------|
| Node.js | v22.22.0 | — | Includes npm, npx |
| npm | 10.9.4 | — | — |
| npx | 10.9.4 | — | — |
| Python | 3.10.12 | — | No pip installed by default |
| git | 2.34.1 | `git` | Standard git client |
| GitHub CLI | 2.4.0+dfsg1 | `gh-cli` | `gh` command for GitHub API |
| curl | 7.81.0 | `curl` | HTTP client |
| dig | 9.18.39 | `dnsutils` | DNS lookup utility |
| ifconfig | 2.10-alpha | `net-tools` | Network interface config |
| netcat | 1.218 | `netcat-openbsd` | TCP/UDP connections |
| iptables | 1.8.7 | `iptables` | Firewall rules (host-level control) |
| gosu | 1.14 | `gosu` | Run commands as other users |
| capsh | — | `libcap2-bin` | Capability management |
| gnupg | 2.2.27 | `gnupg` | GPG encryption |
| ca-certificates | — | `ca-certificates` | Trusted root certificates |
| Chromium runtime libraries | — | see below | Shared libraries required by Playwright-managed browsers |

**Chromium/Playwright runtime libraries:** Because the agent uses selective bind mounts instead of a full host filesystem mount, browsers downloaded by Playwright cannot rely on host libraries. The image therefore preinstalls `libasound2`, `libatk-bridge2.0-0`, `libatk1.0-0`, `libatspi2.0-0`, `libcairo2`, `libcups2`, `libdbus-1-3`, `libdrm2`, `libexpat1`, `libgbm1`, `libglib2.0-0`, `libnspr4`, `libnss3`, `libpango-1.0-0`, `libpangocairo-1.0-0`, `libx11-6`, `libxcb1`, `libxcomposite1`, `libxdamage1`, `libxext6`, `libxfixes3`, `libxkbcommon0`, `libxrandr2`, `libxrender1`, `libxshmfence1`, and `fonts-liberation` (plus their transitive dependencies). On Ubuntu 24.04 base images the `t64` variants of these packages are installed automatically. In chroot mode (the default), these image-installed libraries would otherwise be shadowed by the host's own `/usr`, `/lib`, etc.; `entrypoint.sh` stages copies of the files under `/run/awf-lib/browser-libs` (on the container's own writable rootfs, unaffected by the chroot bind mounts) and sets `LD_LIBRARY_PATH` so Chromium resolves them there.

**⚠️ Docker CLI Stub:** The `docker` command is present but is a stub—there is no Docker daemon running inside the container. Docker-in-Docker is not supported. Use `--mount` to access Docker sockets from the host if needed.

## Act Preset (`act`) - Tools

The `act` preset image (based on Ubuntu 24.04) includes the following pre-installed tools:

| Tool | Version | Package | Notes |
|------|---------|---------|-------|
| Node.js | v18.20.8 | — | Default in PATH (from `/opt/hostedtoolcache`) |
| npm | 10.8.2 | — | Bundled with Node.js 18 |
| npx | 10.8.2 | — | Bundled with Node.js 18 |
| corepack | 0.32.0 | — | Yarn/pnpm manager |
| Node.js (system) | v22.22.0 | — | Alternative system installation at `/usr/bin/node` |
| Python | 3.12.3 | — | Includes pip 24.0 |
| pip | 24.0 | — | Python package manager |
| git | 2.52.0 | `git` | Standard git client |
| GitHub CLI | 2.45.0 | `gh-cli` | `gh` command for GitHub API |
| git-lfs | 3.7.1 | `git-lfs` | Git Large File Storage |
| gcc | 13.3.0 | `build-essential` | C compiler |
| g++ | 13.3.0 | `build-essential` | C++ compiler |
| make | 4.3 | `build-essential` | Build automation |
| build-essential | — | `build-essential` | Metapackage with common build tools |
| curl | 8.5.0 | `curl` | HTTP client |
| dig | 9.18.39 | `dnsutils` | DNS lookup utility |
| ifconfig | 2.10 | `net-tools` | Network interface config |
| netcat | 1.226 | `netcat-openbsd` | TCP/UDP connections |
| iptables | 1.8.10 | `iptables` | Firewall rules (host-level control) |
| gosu | 1.17 | `gosu` | Run commands as other users |
| capsh | — | `libcap2-bin` | Capability management |
| jq | 1.6 | `jq` | JSON processor |
| gnupg | — | `gnupg` | GPG encryption |
| ca-certificates | — | `ca-certificates` | Trusted root certificates |

**⚠️ Docker CLI Stub:** The `docker` command is present but is a stub—there is no Docker daemon running inside the container. Docker-in-Docker is not supported. Use `--mount` to access Docker sockets from the host if needed.

## Custom Base Images

You can use custom base images with `--agent-image`:

```bash
# Use a specific version of the act image
sudo awf \
  --agent-image catthehacker/ubuntu:act-24.04 \
  --build-local \
  --allow-domains github.com \
  -- npm test

# Use your own custom image
sudo awf \
  --agent-image myorg/my-base:latest \
  --build-local \
  --allow-domains github.com \
  -- ./my-script.sh
```

**⚠️ Security Risk:** Custom base images introduce supply chain risks. Only use images from trusted publishers. The firewall cannot protect against malicious code in the base image itself.

## See Also

- [Usage Guide](usage.md) - Examples of using different agent images
- [catthehacker/docker_images](https://github.com/catthehacker/docker_images) - Source repository for GitHub Actions runner images
