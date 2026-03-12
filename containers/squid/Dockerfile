FROM ubuntu/squid:latest

# Install additional tools for debugging, healthcheck, and SSL Bump
# Retry logic handles transient 404s when Ubuntu archive supersedes package versions mid-build
RUN set -eux; \
    PKGS="curl dnsutils net-tools netcat-openbsd openssl squid-openssl"; \
    apt-get update && \
    apt-get install -y --only-upgrade gpgv && \
    ( apt-get install -y --no-install-recommends $PKGS || \
      (rm -rf /var/lib/apt/lists/* && apt-get update && \
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
