# BASE_IMAGE allows customization of the base Ubuntu image for closer parity
# with GitHub Actions runner environments. Options:
#   - ubuntu:22.04 (default): Minimal image, smallest size (~200MB)
#   - ghcr.io/catthehacker/ubuntu:runner-22.04: Closer to GitHub Actions runner (~2-5GB)
#   - ghcr.io/catthehacker/ubuntu:full-22.04: Near-identical to GitHub Actions runner (~20GB compressed)
# Use --build-arg BASE_IMAGE=<image> to customize
# NOTE: ARG declared before first FROM is global and available in all FROM statements
ARG BASE_IMAGE=ubuntu:22.04

FROM ${BASE_IMAGE}

# Optionally switch to Azure apt mirror for faster package fetches in CI
# Only rewrite if azure.archive.ubuntu.com is resolvable (BuildKit DNS can fail)
# Falls back to default archive.ubuntu.com which is universally reachable
RUN if getent hosts azure.archive.ubuntu.com >/dev/null 2>&1; then \
      echo "Using Azure apt mirror (DNS resolved successfully)"; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i 's|http://archive.ubuntu.com|http://azure.archive.ubuntu.com|g' /etc/apt/sources.list; \
        sed -i 's|http://security.ubuntu.com|http://azure.archive.ubuntu.com|g' /etc/apt/sources.list; \
      fi; \
      if [ -d /etc/apt/sources.list.d ]; then \
        find /etc/apt/sources.list.d -name '*.sources' -exec \
          sed -i 's|http://archive.ubuntu.com|http://azure.archive.ubuntu.com|g' {} + 2>/dev/null || true; \
        find /etc/apt/sources.list.d -name '*.sources' -exec \
          sed -i 's|http://security.ubuntu.com|http://azure.archive.ubuntu.com|g' {} + 2>/dev/null || true; \
      fi; \
    else \
      echo "Azure apt mirror not reachable, using default archive.ubuntu.com"; \
    fi

# Install required packages, GitHub CLI 2.96.0, Node.js 22.23.1, and npm 11.18.0
# Note: Some packages may already exist in runner-like base images, apt handles this gracefully
# apt_update_retry: retries up to 3 times with backoff; if all fail, reverts to archive.ubuntu.com
RUN set -eux; \
    force_archive_mirror() { \
      echo "Falling back to archive.ubuntu.com mirror..." >&2; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' /etc/apt/sources.list; \
        sed -i 's|http://security.ubuntu.com|http://archive.ubuntu.com|g' /etc/apt/sources.list 2>/dev/null || true; \
      fi; \
      if [ -d /etc/apt/sources.list.d ]; then \
        find /etc/apt/sources.list.d -name '*.sources' -exec \
          sed -i -e 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' \
                 -e 's|http://security.ubuntu.com|http://archive.ubuntu.com|g' {} + 2>/dev/null || true; \
      fi; \
      rm -rf /var/lib/apt/lists/* && apt-get update; \
    }; \
    apt_update_retry() { \
      local i; for i in 1 2 3; do \
        rm -rf /var/lib/apt/lists/*; \
        if apt-get update > /tmp/apt-update.log 2>&1; then \
          cat /tmp/apt-update.log; \
          if ! grep -q "Failed to fetch" /tmp/apt-update.log; then return 0; fi; \
        else \
          cat /tmp/apt-update.log; \
        fi; \
        echo "apt-get update attempt $i/3 failed or had fetch failures, retrying in $((i*10))s..." >&2; sleep $((i*10)); \
      done; \
      echo "All apt-get update retries failed, falling back to archive.ubuntu.com..." >&2; \
      force_archive_mirror; \
    }; \
    apt_install_retry() { \
      apt-get install -y --no-install-recommends "$@" && return 0; \
      echo "apt-get install failed (likely mirror fetch timeout), forcing archive.ubuntu.com and retrying..." >&2; \
      force_archive_mirror; \
      apt-get install -y --no-install-recommends "$@"; \
    }; \
    PKGS="iptables curl ca-certificates git gnupg dnsutils net-tools netcat-openbsd libcap2-bin"; \
    apt_update_retry && \
    apt_install_retry $PKGS && \
    # Install gosu 1.19 from GitHub releases (compiled with Go 1.24.6 — avoids Ubuntu's
    # apt gosu which is compiled with Go 1.18 and carries 44 stdlib CVEs including Critical ones).
    # Checksums sourced from https://github.com/tianon/gosu/releases/tag/1.19
    GOSU_VERSION="1.19" && \
    GOSU_ARCH="$(dpkg --print-architecture)" && \
    case "$GOSU_ARCH" in \
      amd64)   GOSU_SHA256="52c8749d0142edd234e9d6bd5237dff2d81e71f43537e2f4f66f75dd4b243dd0" ;; \
      arm64)   GOSU_SHA256="3a8ef022d82c0bc4a98bcb144e77da714c25fcfa64dccc57f6aba7ae47ff1a44" ;; \
      armhf)   GOSU_SHA256="8457a0bfd28e016c2c7d8ea6e5f7eed1376033ffbd36491bb455094c8b1dc9fd" ;; \
      armel)   GOSU_SHA256="6b6a27eb5b5f1efe74978f51aceb773cf004db34e9019f869c056ac8ebc232d9" ;; \
      ppc64el) GOSU_SHA256="52102a5903b79dcf6287cf1fbc3a3157393989195a8c95e4788556cd35650ae3" ;; \
      s390x)   GOSU_SHA256="6717b460d0b1a8fabbdca1fa3cbe7ea0e1c0d64f3ed252e1e1e101ed4e16d9e2" ;; \
      i386)    GOSU_SHA256="4b38085eecdf33a79b6a2f1df8d36e2a93c93346679106127fcbd605aebf01c9" ;; \
      riscv64) GOSU_SHA256="17ece9173569485c29875058d0edd4cd4a70c00f4cfa6a11b04050e25fda2297" ;; \
      *) echo "Unsupported architecture: $GOSU_ARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/tianon/gosu/releases/download/${GOSU_VERSION}/gosu-${GOSU_ARCH}" \
        -o /usr/local/bin/gosu && \
    echo "${GOSU_SHA256}  /usr/local/bin/gosu" | sha256sum -c - && \
    chmod +x /usr/local/bin/gosu && \
    gosu --version && \
    # Prefer system binaries over runner toolcache (e.g., act images) for Node checks.
    export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH" && \
    # Install GitHub CLI 2.96.0 from the official GitHub CLI apt repository
    # (Ubuntu's bundled gh package is 2.4.0 compiled with Go 1.18 — vulnerable)
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt_install_retry gh=2.96.0 && \
    # Install Node.js 22.23.1 from the official Node.js binary distribution
    # (nodejs.org), NOT the NodeSource apt repo. The NodeSource .deb is tracked by
    # a Debian/NodeSource security feed that yields false-positive CVE matches
    # (e.g. CVE-2023-44487 and CVE-2026-45447) against a binary that is already
    # patched (22.23.1 bundles OpenSSL 3.5.7). The official tarball carries no .deb
    # metadata, so grype matches it via NVD CPE data instead, which correctly
    # excludes 22.23.1 for both CVEs.
    # Checksums sourced from https://nodejs.org/dist/v22.23.1/SHASUMS256.txt
    # Note: node --version segfaults under QEMU arm64 emulation, so detect QEMU
    # and skip the runtime version check there.
    UNDER_QEMU=false && \
    if [ -f /dev/.buildkit_qemu_emulator ] || [ -n "${QEMU_CPU:-}" ]; then UNDER_QEMU=true; fi && \
    # Remove any existing nodejs packages first to avoid conflicting detections
    apt-get remove -y nodejs npm || true && \
    NODE_VERSION="v22.23.1" && \
    NODE_DPKG_ARCH="$(dpkg --print-architecture)" && \
    case "$NODE_DPKG_ARCH" in \
      amd64) NODE_ARCH="x64";    NODE_SHA256="7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129" ;; \
      arm64) NODE_ARCH="arm64";  NODE_SHA256="543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d" ;; \
      armhf) NODE_ARCH="armv7l"; NODE_SHA256="03c56ac0bd3ef3cce967c2f7b2f7ac2259a4ae7ceeaa661291aadf65729a8b53" ;; \
      *) echo "Unsupported architecture for Node.js: $NODE_DPKG_ARCH" >&2; exit 1 ;; \
    esac && \
    NODE_TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" && \
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}" -o "/tmp/${NODE_TARBALL}" && \
    echo "${NODE_SHA256}  /tmp/${NODE_TARBALL}" | sha256sum -c - && \
    # Extract bin/, lib/, include/, share/ into /usr/local (strip the top-level dir)
    tar -xzf "/tmp/${NODE_TARBALL}" -C /usr/local --strip-components=1 --no-same-owner && \
    rm -f "/tmp/${NODE_TARBALL}" && \
    # Hold gh so the later apt-get upgrade does not silently replace the pinned version
    apt-mark hold gh && \
    # Verify Node.js 22.23.1 was installed correctly (skip node exec under QEMU — segfaults)
    if [ "$UNDER_QEMU" = "true" ]; then \
        echo "Skipping node --version check (QEMU emulation detected)" && \
        test -x /usr/local/bin/node || (echo "ERROR: /usr/local/bin/node missing" && exit 1); \
    else \
        node --version | grep -qE '^v22\.23\.1' || (echo "ERROR: Node.js 22.23.1 not installed correctly" && exit 1) && \
        npx --version || (echo "ERROR: npx not found" && exit 1); \
    fi && \
    # Replace Node's bundled npm 10.x with npm 11.18.0
    # Download the tarball and verify its SHA-256 before installing
    NPM_TGZ_URL="https://registry.npmjs.org/npm/-/npm-11.18.0.tgz" && \
    NPM_TGZ_SHA256="73f6155215ebabf4ed96dca1f567c2372cc713c33af2e5b9b62fde4e92373e2e" && \
    curl -fsSL "$NPM_TGZ_URL" -o /tmp/npm-11.18.0.tgz && \
    echo "${NPM_TGZ_SHA256}  /tmp/npm-11.18.0.tgz" | sha256sum -c - && \
    # Remove stale npm 10.x trees so scanners do not retain them
    rm -rf /usr/lib/node_modules/npm /usr/local/lib/node_modules/npm && \
    rm -f /usr/bin/npm /usr/bin/npx /usr/local/bin/npm /usr/local/bin/npx && \
    # Extract npm 11.18.0 manually — avoids executing node under QEMU (node segfaults there)
    mkdir -p /usr/local/lib/node_modules/npm && \
    tar -xzf /tmp/npm-11.18.0.tgz -C /usr/local/lib/node_modules/npm --strip-components=1 && \
    chmod +x /usr/local/lib/node_modules/npm/bin/npm-cli.js \
             /usr/local/lib/node_modules/npm/bin/npx-cli.js && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    # Verify version on non-QEMU builds (node segfaults under QEMU)
    if [ "$UNDER_QEMU" = "false" ]; then \
        npm --version | grep -qE '^11\.18\.0' || (echo "ERROR: npm 11.18.0 not installed correctly" && exit 1); \
    fi && \
    rm -f /tmp/npm-11.18.0.tgz && \
    rm -rf /var/lib/apt/lists/*

# Install additional system packages for GitHub Actions runner parity
# These packages are commonly needed by workflows and avoid agents spending time installing them manually
# See: https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2204-Readme.md
RUN set -eux; \
    force_archive_mirror() { \
      echo "Falling back to archive.ubuntu.com mirror..." >&2; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' /etc/apt/sources.list; \
        sed -i 's|http://security.ubuntu.com|http://archive.ubuntu.com|g' /etc/apt/sources.list 2>/dev/null || true; \
      fi; \
      if [ -d /etc/apt/sources.list.d ]; then \
        find /etc/apt/sources.list.d -name '*.sources' -exec \
          sed -i -e 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' \
                 -e 's|http://security.ubuntu.com|http://archive.ubuntu.com|g' {} + 2>/dev/null || true; \
      fi; \
      rm -rf /var/lib/apt/lists/* && apt-get update; \
    }; \
    apt_update_retry() { \
      local i; for i in 1 2 3; do \
        rm -rf /var/lib/apt/lists/*; \
        if apt-get update > /tmp/apt-update.log 2>&1; then \
          cat /tmp/apt-update.log; \
          if ! grep -q "Failed to fetch" /tmp/apt-update.log; then return 0; fi; \
        else \
          cat /tmp/apt-update.log; \
        fi; \
        echo "apt-get update attempt $i/3 failed or had fetch failures, retrying in $((i*10))s..." >&2; sleep $((i*10)); \
      done; \
      echo "All apt-get update retries failed, falling back to archive.ubuntu.com..." >&2; \
      force_archive_mirror; \
    }; \
    apt_install_retry() { \
      apt-get install -y --no-install-recommends "$@" && return 0; \
      echo "apt-get install failed (likely mirror fetch timeout), forcing archive.ubuntu.com and retrying..." >&2; \
      force_archive_mirror; \
      apt-get install -y --no-install-recommends "$@"; \
    }; \
    # python3 is commonly needed by workflows and is also required by the
    # release-time seccomp regression check (scripts/ci/check-agent-seccomp-syscalls.sh),
    # which uses python3+ctypes to fire name_to_handle_at/open_by_handle_at.
    PARITY_PKGS="libgdiplus libev-dev libssl-dev php-intl php-gd python3"; \
    apt_update_retry && \
    apt_install_retry $PARITY_PKGS && \
    rm -rf /var/lib/apt/lists/*

# Upgrade all packages to pick up security patches
# Addresses CVE-2023-44487 (HTTP/2 Rapid Reset) and other known vulnerabilities
# Retry logic handles transient mirror sync failures during apt-get update
RUN force_archive_mirror() { \
      echo "Falling back to archive.ubuntu.com mirror..." >&2; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' /etc/apt/sources.list; \
        sed -i 's|http://security.ubuntu.com|http://archive.ubuntu.com|g' /etc/apt/sources.list 2>/dev/null || true; \
      fi; \
      if [ -d /etc/apt/sources.list.d ]; then \
        find /etc/apt/sources.list.d -name '*.sources' -exec \
          sed -i -e 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' \
                 -e 's|http://security.ubuntu.com|http://archive.ubuntu.com|g' {} + 2>/dev/null || true; \
      fi; \
      rm -rf /var/lib/apt/lists/* && apt-get update; \
    }; \
    apt_update_retry() { \
      local i; for i in 1 2 3; do \
        rm -rf /var/lib/apt/lists/*; \
        if apt-get update > /tmp/apt-update.log 2>&1; then \
          cat /tmp/apt-update.log; \
          if ! grep -q "Failed to fetch" /tmp/apt-update.log; then return 0; fi; \
        else \
          cat /tmp/apt-update.log; \
        fi; \
        echo "apt-get update attempt $i/3 failed or had fetch failures, retrying in $((i*10))s..." >&2; sleep $((i*10)); \
      done; \
      echo "All apt-get update retries failed, falling back to archive.ubuntu.com..." >&2; \
      force_archive_mirror; \
    }; \
    apt_upgrade_retry() { \
      apt-get upgrade -y && return 0; \
      echo "apt-get upgrade failed (likely mirror fetch timeout), forcing archive.ubuntu.com and retrying..." >&2; \
      force_archive_mirror && apt-get upgrade -y; \
    }; \
    apt_update_retry && \
    apt_upgrade_retry && rm -rf /var/lib/apt/lists/*

# Create non-root user with UID/GID matching host user
# This allows the user command to run with appropriate permissions
# and prevents file ownership issues with mounted volumes
ARG USER_UID=1000
ARG USER_GID=1000
RUN if ! getent group awfuser >/dev/null 2>&1; then \
      if ! getent group ${USER_GID} >/dev/null 2>&1; then \
        groupadd -g ${USER_GID} awfuser; \
      else \
        groupadd awfuser; \
      fi; \
    fi && \
    if ! id -u awfuser >/dev/null 2>&1; then \
      if ! getent passwd ${USER_UID} >/dev/null 2>&1; then \
        useradd -u ${USER_UID} -g awfuser -m -s /bin/bash awfuser; \
      else \
        useradd -g awfuser -m -s /bin/bash awfuser; \
      fi; \
    fi && \
    # Create directories for awfuser
    mkdir -p /home/awfuser/.copilot/logs && \
    chown -R awfuser:awfuser /home/awfuser

# Copy iptables setup script, PID logger, API proxy health check, Claude key helper,
# and gh CLI proxy wrapper (used when --enable-cli-proxy is active)
COPY setup-iptables.sh /usr/local/bin/setup-iptables.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY pid-logger.sh /usr/local/bin/pid-logger.sh
COPY api-proxy-health-check.sh /usr/local/bin/api-proxy-health-check.sh
COPY get-claude-key.sh /usr/local/bin/get-claude-key.sh
COPY gh-cli-proxy-wrapper.sh /usr/local/bin/gh-cli-proxy-wrapper.sh
RUN chmod +x /usr/local/bin/setup-iptables.sh /usr/local/bin/entrypoint.sh /usr/local/bin/pid-logger.sh /usr/local/bin/api-proxy-health-check.sh /usr/local/bin/get-claude-key.sh /usr/local/bin/gh-cli-proxy-wrapper.sh

# Copy pre-built one-shot-token library from rust-builder stage
# This prevents tokens from being read multiple times (e.g., by malicious code)
# Build flags: -fvisibility=hidden hides internal symbols, -s strips at link time
# -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 disables glibc fortification macros (e.g.
# __fprintf_chk) so the resulting .so loads on musl-based hosts (Alpine/ARC runners)
COPY one-shot-token/one-shot-token.c /tmp/one-shot-token.c
RUN set -eux; \
    force_archive_mirror() { \
      echo "Falling back to archive.ubuntu.com mirror..." >&2; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' /etc/apt/sources.list; \
        sed -i 's|http://security.ubuntu.com|http://archive.ubuntu.com|g' /etc/apt/sources.list 2>/dev/null || true; \
      fi; \
      if [ -d /etc/apt/sources.list.d ]; then \
        find /etc/apt/sources.list.d -name '*.sources' -exec \
          sed -i -e 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' \
                 -e 's|http://security.ubuntu.com|http://archive.ubuntu.com|g' {} + 2>/dev/null || true; \
      fi; \
      rm -rf /var/lib/apt/lists/* && apt-get update; \
    }; \
    apt_install_retry() { \
      apt-get install -y --no-install-recommends "$@" && return 0; \
      echo "apt-get install failed (likely mirror fetch timeout), forcing archive.ubuntu.com and retrying..." >&2; \
      force_archive_mirror; \
      apt-get install -y --no-install-recommends "$@"; \
    }; \
    BUILD_PKGS="gcc libc6-dev binutils"; \
    apt-get update && \
    apt_install_retry $BUILD_PKGS && \
    gcc -shared -fPIC -fvisibility=hidden -O2 -Wall -s \
        -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 \
        -o /usr/local/lib/one-shot-token.so /tmp/one-shot-token.c -ldl -lpthread && \
    strip --strip-unneeded /usr/local/lib/one-shot-token.so && \
    rm /tmp/one-shot-token.c && \
    apt-get remove -y $BUILD_PKGS && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Install Docker stub script that shows helpful error message
# Docker-in-Docker support was removed in v0.9.1
COPY docker-stub.sh /usr/bin/docker
RUN chmod +x /usr/bin/docker

# Set working directory
WORKDIR /workspace

# Use entrypoint to setup iptables and run command
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
