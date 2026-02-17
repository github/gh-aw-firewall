# BASE_IMAGE allows customization of the base Ubuntu image for closer parity
# with GitHub Actions runner environments. Options:
#   - ubuntu:22.04 (default): Minimal image, smallest size (~200MB)
#   - ghcr.io/catthehacker/ubuntu:runner-22.04: Closer to GitHub Actions runner (~2-5GB)
#   - ghcr.io/catthehacker/ubuntu:full-22.04: Near-identical to GitHub Actions runner (~20GB compressed)
# Use --build-arg BASE_IMAGE=<image> to customize
# NOTE: ARG declared before first FROM is global and available in all FROM statements
ARG BASE_IMAGE=ubuntu:22.04

FROM ${BASE_IMAGE}

# Install required packages and Node.js 22
# Note: Some packages may already exist in runner-like base images, apt handles this gracefully
# Retry logic handles transient 404s when Ubuntu archive supersedes package versions mid-build
RUN set -eux; \
    PKGS="iptables curl ca-certificates git gh gnupg dnsutils net-tools netcat-openbsd gosu libcap2-bin"; \
    apt-get update && \
    ( apt-get install -y --no-install-recommends $PKGS || \
      (echo "apt-get install failed, retrying with fresh package index..." && \
       rm -rf /var/lib/apt/lists/* && \
       apt-get update && \
       apt-get install -y --no-install-recommends $PKGS) ) && \
    # Prefer system binaries over runner toolcache (e.g., act images) for Node checks.
    export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH" && \
    # Install Node.js 22 from NodeSource
    # Check if Node.js 22 is already installed (common in runner images)
    if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE '^v22\.'; then \
        # Remove any existing nodejs packages first to avoid conflicts
        apt-get remove -y nodejs npm || true && \
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
        apt-get install -y nodejs && \
        # Verify Node.js 22 was installed correctly
        node --version | grep -q "^v22\." || (echo "ERROR: Node.js 22 not installed correctly" && exit 1) && \
        npx --version || (echo "ERROR: npx not found" && exit 1); \
    fi && \
    rm -rf /var/lib/apt/lists/*

# Upgrade all packages to pick up security patches
# Addresses CVE-2023-44487 (HTTP/2 Rapid Reset) and other known vulnerabilities
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

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

# Copy iptables setup script, PID logger, API proxy health check, and Claude key helper
COPY setup-iptables.sh /usr/local/bin/setup-iptables.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY pid-logger.sh /usr/local/bin/pid-logger.sh
COPY api-proxy-health-check.sh /usr/local/bin/api-proxy-health-check.sh
COPY get-claude-key.sh /usr/local/bin/get-claude-key.sh
RUN chmod +x /usr/local/bin/setup-iptables.sh /usr/local/bin/entrypoint.sh /usr/local/bin/pid-logger.sh /usr/local/bin/api-proxy-health-check.sh /usr/local/bin/get-claude-key.sh

# Copy pre-built one-shot-token library from rust-builder stage
# This prevents tokens from being read multiple times (e.g., by malicious code)
# Build flags: -fvisibility=hidden hides internal symbols, -s strips at link time
COPY one-shot-token/one-shot-token.c /tmp/one-shot-token.c
RUN set -eux; \
    BUILD_PKGS="gcc libc6-dev binutils"; \
    apt-get update && \
    ( apt-get install -y --no-install-recommends $BUILD_PKGS || \
      (rm -rf /var/lib/apt/lists/* && apt-get update && \
       apt-get install -y --no-install-recommends $BUILD_PKGS) ) && \
    gcc -shared -fPIC -fvisibility=hidden -O2 -Wall -s \
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
