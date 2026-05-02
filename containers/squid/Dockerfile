FROM ubuntu/squid:latest

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

# Install additional tools for debugging, healthcheck, and SSL Bump
# apt_update_retry: retries up to 3 times with backoff; if all fail, reverts to archive.ubuntu.com
RUN set -eux; \
    apt_update_retry() { \
      local i; for i in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* && apt-get update 2>&1 | tee /tmp/apt-update.log && \
        if ! grep -q "Failed to fetch" /tmp/apt-update.log; then return 0; fi; \
        echo "apt-get update attempt $i/3 had fetch failures, retrying in $((i*10))s..." >&2; sleep $((i*10)); \
      done; \
      echo "All apt-get update retries failed, falling back to archive.ubuntu.com..." >&2; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' /etc/apt/sources.list; \
      fi; \
      if [ -d /etc/apt/sources.list.d ]; then \
        find /etc/apt/sources.list.d -name '*.sources' -exec \
          sed -i 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' {} + 2>/dev/null || true; \
      fi; \
      rm -rf /var/lib/apt/lists/* && apt-get update; \
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
