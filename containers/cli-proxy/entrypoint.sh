#!/bin/bash
# CLI Proxy sidecar entrypoint
# Starts the mcpg DIFC proxy (if GH_TOKEN is set), then starts the Node.js HTTP server.
set -e

echo "[cli-proxy] Starting CLI proxy sidecar..."

MCPG_PID=""

# Start mcpg proxy if GH_TOKEN is available
if [ -n "$GH_TOKEN" ]; then
  echo "[cli-proxy] GH_TOKEN present - starting mcpg DIFC proxy..."

  mkdir -p /tmp/proxy-tls /var/log/cli-proxy/mcpg

  # Build the guard policy JSON if not explicitly provided
  if [ -z "$AWF_GH_GUARD_POLICY" ]; then
    if [ -n "$GITHUB_REPOSITORY" ]; then
      AWF_GH_GUARD_POLICY="{\"repos\":[\"${GITHUB_REPOSITORY}\"],\"min-integrity\":\"public\"}"
    else
      AWF_GH_GUARD_POLICY="{\"min-integrity\":\"public\"}"
    fi
    echo "[cli-proxy] Using default guard policy: ${AWF_GH_GUARD_POLICY}"
  else
    echo "[cli-proxy] Using provided guard policy"
  fi

  # Start mcpg proxy in background
  # mcpg proxy holds GH_TOKEN and applies DIFC guard policies before forwarding
  mcpg proxy \
    --policy "${AWF_GH_GUARD_POLICY}" \
    --listen 127.0.0.1:18443 \
    --tls \
    --tls-dir /tmp/proxy-tls \
    --guards-mode filter \
    --log-dir /var/log/cli-proxy/mcpg &
  MCPG_PID=$!
  echo "[cli-proxy] mcpg proxy started (PID: ${MCPG_PID})"

  # Wait for TLS cert to be generated (max 30s)
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
    echo "[cli-proxy] ERROR: mcpg TLS certificate not generated within 30s"
    kill "$MCPG_PID" 2>/dev/null || true
    exit 1
  fi

  # Configure gh CLI to route through the mcpg proxy (TLS, self-signed CA)
  export GH_HOST="localhost:18443"
  export NODE_EXTRA_CA_CERTS="/tmp/proxy-tls/ca.crt"
  export GH_REPO="${GH_REPO:-$GITHUB_REPOSITORY}"

  echo "[cli-proxy] gh CLI configured to route through mcpg proxy at ${GH_HOST}"
else
  echo "[cli-proxy] WARNING: GH_TOKEN not set - mcpg proxy disabled, gh CLI will not authenticate"
fi

# Cleanup handler: kill mcpg when the server exits or receives a signal
cleanup() {
  echo "[cli-proxy] Shutting down..."
  if [ -n "$MCPG_PID" ]; then
    kill "$MCPG_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup INT TERM

# Start the Node.js HTTP server (foreground)
echo "[cli-proxy] Starting HTTP server on port 11000..."
exec node /app/server.js
