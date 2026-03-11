FROM ubuntu/squid:latest

# Install additional tools for debugging, healthcheck, and SSL Bump
# gosu is used to drop from root to proxy user after permission setup
# Retry logic handles transient 404s when Ubuntu archive supersedes package versions mid-build
RUN set -eux; \
    PKGS="curl dnsutils gosu net-tools netcat-openbsd openssl squid-openssl"; \
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

# Use entrypoint to fix permissions before starting Squid
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
