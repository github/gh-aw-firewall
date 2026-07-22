FROM alpine:3.24

# Install Squid and supporting tools needed by runtime health checks and diagnostics.
# Keep bash + shadow so the compose preflight can continue to drop privileges with:
#   su -s /bin/bash proxy -c ...
RUN set -eux; \
    apk add --no-cache \
      bash \
      bind-tools \
      curl \
      net-tools \
      netcat-openbsd \
      openssl \
      shadow \
      squid; \
    # Preserve AWF runtime contract: proxy user/group must be uid/gid 13.
    if getent group proxy >/dev/null 2>&1; then \
      groupmod -g 13 proxy; \
    else \
      addgroup -S -g 13 proxy; \
    fi; \
    if id -u proxy >/dev/null 2>&1; then \
      usermod -u 13 -g 13 proxy; \
    else \
      adduser -S -D -H -u 13 -G proxy proxy; \
    fi

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
