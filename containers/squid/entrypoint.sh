#!/bin/bash
set -e

# This entrypoint runs as the non-root 'proxy' user (set by USER in Dockerfile).
# All directory permissions are set at build time or by the host before container start.

# Verify SSL certificate database permissions if SSL Bump is enabled
if [ -d "/var/spool/squid_ssl_db" ]; then
  echo "[squid-entrypoint] SSL Bump mode detected - SSL database ready"
fi

# Check if IPv6 is available in this container namespace.
# On Docker daemons with `ipv6: false` (the default on most Linux distros), the kernel
# sets net.ipv6.conf.all.disable_ipv6=1 inside every container network namespace.
# Squid treats `http_port [::]:3128` as a FATAL error when IPv6 is unavailable, aborting
# before opening log files and causing the container to exit(1) immediately.
# If IPv6 is disabled we strip the dual-stack listener lines so Squid can start normally.
# The defense-in-depth intent is preserved on runners that do have IPv6 enabled.
IPV6_DISABLED="$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)"
if [ "$IPV6_DISABLED" = "1" ]; then
  echo "[squid-entrypoint] IPv6 is disabled in this namespace - removing http_port [::]: listeners to prevent fatal startup error"
  sed -i '/^http_port \[::\]:/d' /etc/squid/squid.conf
fi

# Start Squid directly (already running as proxy user via Dockerfile USER directive)
exec squid -N -d 1
