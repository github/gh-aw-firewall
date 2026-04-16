FROM ubuntu/squid:latest

# Switch to Azure apt mirror for faster, more reliable package fetches in CI
# GitHub Actions runners are Azure-hosted; azure.archive.ubuntu.com is geographically closer
# Handles both traditional sources.list (jammy) and DEB822 format (noble+)
RUN if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|http://archive.ubuntu.com|http://azure.archive.ubuntu.com|g' /etc/apt/sources.list; \
      sed -i 's|http://security.ubuntu.com|http://azure.archive.ubuntu.com|g' /etc/apt/sources.list; \
    fi && \
    if [ -d /etc/apt/sources.list.d ]; then \
      find /etc/apt/sources.list.d -name '*.sources' -exec \
        sed -i 's|http://archive.ubuntu.com|http://azure.archive.ubuntu.com|g' {} + 2>/dev/null || true; \
      find /etc/apt/sources.list.d -name '*.sources' -exec \
        sed -i 's|http://security.ubuntu.com|http://azure.archive.ubuntu.com|g' {} + 2>/dev/null || true; \
    fi

# Install additional tools for debugging, healthcheck, and SSL Bump
# apt_update_retry: retries up to 3 times with backoff to survive prolonged mirror syncs
RUN set -eux; \
    apt_update_retry() { \
      local i; for i in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* && apt-get update && return 0; \
        echo "apt-get update attempt $i/3 failed, retrying in $((i*10))s..." >&2; sleep $((i*10)); \
      done; return 1; \
    }; \
    PKGS="curl dnsutils net-tools netcat-openbsd openssl squid-openssl"; \
    apt_update_retry && \
    apt-get install -y --only-upgrade gpgv && \
    ( apt-get install -y --no-install-recommends $PKGS || \
      (apt_update_retry && \
       apt-get install -y --no-install-recommends $PKGS) ) && \
    rm -rf /var/lib/apt/lists/*

# Create log directory and SSL database directory, ensure proxy user owns them
RUN mkdir -p /var/log/squid /var/spool/squid /var/run/squid && \
    chown -R proxy:proxy /var/log/squid /var/spool/squid /var/run/squid /etc/squid

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose Squid port (3128 for HTTP, 3129 for HTTPS with SSL Bump)
EXPOSE 3128
EXPOSE 3129

# Run as non-root proxy user for security hardening
# Permission setup is done at build time; mounted volumes must be pre-configured
# by the host (docker-manager.ts sets correct ownership before starting containers)
USER proxy

# Use entrypoint to start Squid (runs as proxy user)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
