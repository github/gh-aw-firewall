#!/bin/bash
set -e

# This entrypoint runs as the non-root 'proxy' user (set by USER in Dockerfile).
# All directory permissions are set at build time or by the host before container start.

# Verify SSL certificate database permissions if SSL Bump is enabled
if [ -d "/var/spool/squid_ssl_db" ]; then
  echo "[squid-entrypoint] SSL Bump mode detected - SSL database ready"
fi

# Start Squid directly (already running as proxy user via Dockerfile USER directive)
exec squid -N -d 1
