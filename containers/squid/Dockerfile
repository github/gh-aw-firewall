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
    # Alpine base assigns GID 13 to the 'news' group (and UID 9 to the 'news' user).
    # AWF requires proxy user/group at UID/GID 13 for log-dir ownership compatibility.
    # Remove the 'news' account first so those IDs are free to assign to 'proxy'.
    userdel news 2>/dev/null || true; \
    groupdel news 2>/dev/null || true; \
    groupadd -r -g 13 proxy; \
    useradd -r -u 13 -g proxy -M -s /sbin/nologin proxy

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
