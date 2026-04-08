#!/bin/bash
# CLI Proxy sidecar entrypoint
#
# The mcpg DIFC proxy runs as a separate docker-compose service
# (awf-cli-proxy-mcpg). This entrypoint waits for the mcpg TLS cert
# (written to a shared volume at /tmp/proxy-tls), configures gh CLI to
# route through the mcpg container, then starts the Node.js HTTP server.
set -e

echo "[cli-proxy] Starting CLI proxy sidecar..."

NODE_PID=""

# AWF_MCPG_HOST is set by docker-manager.ts to the mcpg container's IP.
# Fall back to localhost for backward-compatible local testing.
MCPG_HOST="${AWF_MCPG_HOST:-localhost}"
MCPG_PORT="${AWF_MCPG_PORT:-18443}"

echo "[cli-proxy] mcpg proxy at ${MCPG_HOST}:${MCPG_PORT}"

# Wait for TLS cert to appear in the shared volume (max 30s)
echo "[cli-proxy] Waiting for mcpg TLS certificate..."
i=0
while [ $i -lt 30 ]; do
  if [ -f /tmp/proxy-tls/ca.crt ]; then
    echo "[cli-proxy] TLS certificate available"
    break
  fi
  sleep 1
  i=$((i + 1))
done

if [ ! -f /tmp/proxy-tls/ca.crt ]; then
  echo "[cli-proxy] ERROR: mcpg TLS certificate not found within 30s"
  exit 1
fi

# Configure gh CLI to route through the mcpg proxy (TLS, self-signed CA)
export GH_HOST="${MCPG_HOST}:${MCPG_PORT}"
export NODE_EXTRA_CA_CERTS="/tmp/proxy-tls/ca.crt"
export GH_REPO="${GH_REPO:-$GITHUB_REPOSITORY}"

echo "[cli-proxy] gh CLI configured to route through mcpg proxy at ${GH_HOST}"

# Cleanup handler: stop the Node HTTP server on signal
cleanup() {
  echo "[cli-proxy] Shutting down..."
  if [ -n "$NODE_PID" ]; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
}
trap 'cleanup; exit 0' INT TERM

# Start the Node.js HTTP server in the background so the shell keeps running
# and traps remain active for graceful shutdown.
echo "[cli-proxy] Starting HTTP server on port 11000..."
node /app/server.js &
NODE_PID=$!

# Wait for Node to exit and propagate its exit code
if wait "$NODE_PID"; then
  NODE_EXIT=0
else
  NODE_EXIT=$?
fi

cleanup
exit "$NODE_EXIT"
