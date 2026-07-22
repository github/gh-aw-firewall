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
    PKGS="iptables curl ca-certificates git gnupg dnsutils net-tools netcat-openbsd gosu libcap2-bin"; \
    apt_update_retry && \
    apt_install_retry $PKGS && \
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
    # Install Node.js 22.23.1 from NodeSource
    # Note: node --version segfaults under QEMU arm64 emulation, so detect QEMU
    # and skip the pre-check — just always install from NodeSource on QEMU.
    UNDER_QEMU=false && \
    if [ -f /dev/.buildkit_qemu_emulator ] || [ -n "${QEMU_CPU:-}" ]; then UNDER_QEMU=true; fi && \
    # Remove any existing nodejs packages first to avoid conflicts
    apt-get remove -y nodejs npm || true && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs=22.23.1-1nodesource1 && \
    # Hold gh and nodejs so the later apt-get upgrade does not silently replace the exact versions
    apt-mark hold gh nodejs && \
    # Verify Node.js 22.23.1 was installed correctly (skip under QEMU — node segfaults)
    if [ "$UNDER_QEMU" = "true" ]; then \
        echo "Skipping node --version check (QEMU emulation detected)" && \
        dpkg -l nodejs | grep -q "22\.23\.1" || (echo "ERROR: nodejs 22.23.1 package not installed" && exit 1); \
    else \
        node --version | grep -qE '^v22\.23\.1' || (echo "ERROR: Node.js 22.23.1 not installed correctly" && exit 1) && \
        npx --version || (echo "ERROR: npx not found" && exit 1); \
    fi && \
    # Replace NodeSource's bundled npm 10.x with npm 11.18.0
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
    PARITY_PKGS="libgdiplus libev-dev libssl-dev php-intl php-gd"; \
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
