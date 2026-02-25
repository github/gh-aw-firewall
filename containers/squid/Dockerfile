FROM ubuntu/squid:latest

# Install additional tools for debugging, healthcheck, SSL Bump, and Node.js (for auth proxy)
# Retry logic handles transient 404s when Ubuntu archive supersedes package versions mid-build
RUN set -eux; \
    PKGS="curl dnsutils net-tools netcat-openbsd openssl squid-openssl nodejs npm"; \
    apt-get update && \
    apt-get install -y --only-upgrade gpgv && \
    ( apt-get install -y --no-install-recommends $PKGS || \
      (rm -rf /var/lib/apt/lists/* && apt-get update && \
       apt-get install -y --no-install-recommends $PKGS) ) && \
    rm -rf /var/lib/apt/lists/*

# Create log directories
RUN mkdir -p /var/log/squid /var/log/api-proxy && \
    chown -R proxy:proxy /var/log/squid /var/log/api-proxy

# Copy API proxy files and install dependencies
WORKDIR /app/api-proxy
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./

# Reset workdir
WORKDIR /

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose Squid port (3128 for HTTP, 3129 for HTTPS with SSL Bump)
# and API proxy ports (10000-10002 for LLM provider proxies)
EXPOSE 3128 3129 10000 10001 10002

# Use entrypoint to fix permissions before starting Squid
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
