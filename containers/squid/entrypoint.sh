#!/bin/bash
set -e

# Fix permissions on mounted log directory
# The directory is mounted from the host and may have wrong ownership
chown -R proxy:proxy /var/log/squid
chmod -R 755 /var/log/squid

# Fix permissions on SSL certificate database if SSL Bump is enabled
# The database is initialized on the host side by awf, but the permissions
# need to be fixed for the proxy user inside the container.
if [ -d "/var/spool/squid_ssl_db" ]; then
  echo "[squid-entrypoint] SSL Bump mode detected - fixing SSL database permissions..."

  # Fix ownership for Squid (runs as proxy user)
  chown -R proxy:proxy /var/spool/squid_ssl_db
  chmod -R 700 /var/spool/squid_ssl_db

  echo "[squid-entrypoint] SSL certificate database ready"
fi

# Ensure Squid config directory and run directory are writable by proxy
chown -R proxy:proxy /etc/squid /var/run/squid /var/spool/squid 2>/dev/null || true

# Drop to proxy user and start Squid
exec gosu proxy squid -N -d 1
