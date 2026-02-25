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

# Start Node.js auth proxy if API keys are configured
# Security mitigation 3a: Run Node.js as non-root 'proxy' user
if [ -n "$OPENAI_API_KEY" ] || [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$COPILOT_GITHUB_TOKEN" ]; then
  echo "[squid-entrypoint] Starting API auth proxy..."

  # Fix permissions on api-proxy log directory
  chown -R proxy:proxy /var/log/api-proxy
  chmod -R 755 /var/log/api-proxy

  # Route through localhost Squid (not external IP)
  export HTTP_PROXY="http://localhost:3128"
  export HTTPS_PROXY="http://localhost:3128"

  # Security mitigation 3a: Drop to non-root 'proxy' user before starting Node.js
  su -s /bin/sh proxy -c "HTTP_PROXY='$HTTP_PROXY' HTTPS_PROXY='$HTTPS_PROXY' \
    OPENAI_API_KEY='${OPENAI_API_KEY:-}' \
    ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY:-}' \
    COPILOT_GITHUB_TOKEN='${COPILOT_GITHUB_TOKEN:-}' \
    node /app/api-proxy/server.js" &
  API_PROXY_PID=$!
  echo "[squid-entrypoint] API auth proxy started as non-root (PID: $API_PROXY_PID)"
fi

# Security mitigation 3c: Don't use 'exec squid' - manage both processes properly
# Start Squid in background (not foreground with exec)
squid -N -d 1 &
SQUID_PID=$!
echo "[squid-entrypoint] Squid started (PID: $SQUID_PID)"

# Graceful shutdown handler for both processes
cleanup() {
  echo "[squid-entrypoint] Shutting down..."
  kill $SQUID_PID 2>/dev/null || true
  if [ -n "$API_PROXY_PID" ]; then
    kill $API_PROXY_PID 2>/dev/null || true
  fi
  wait
}
trap cleanup TERM INT

# Wait for either process to exit
wait -n
EXIT_CODE=$?
echo "[squid-entrypoint] A process exited with code $EXIT_CODE, shutting down..."

# Clean up remaining processes
cleanup
exit $EXIT_CODE
