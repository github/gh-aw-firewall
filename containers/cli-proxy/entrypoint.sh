#!/bin/bash
# CLI Proxy sidecar entrypoint
# Starts the mcpg DIFC proxy (GH_TOKEN required), then starts the Node.js HTTP server
# under a supervisor loop so signals are properly handled and mcpg is cleaned up.
set -e

echo "[cli-proxy] Starting CLI proxy sidecar..."

MCPG_PID=""
NODE_PID=""

# GH_TOKEN is required: without it, mcpg cannot authenticate and DIFC guard policies
# cannot be enforced.  Fail closed rather than starting an unenforced server.
if [ -z "$GH_TOKEN" ]; then
  echo "[cli-proxy] ERROR: GH_TOKEN not set - refusing to start without mcpg DIFC enforcement"
  exit 1
fi

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
  --trusted-bots "github-actions[bot],github-actions,dependabot[bot],copilot" \
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

# Cleanup handler: stop both the Node HTTP server and mcpg when we receive a signal
# or when the server exits.  This runs correctly because we do NOT exec Node — we
# start it in the background and wait, so the shell (and its traps) remain active.
cleanup() {
  echo "[cli-proxy] Shutting down..."
  if [ -n "$NODE_PID" ]; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "$MCPG_PID" ]; then
    kill "$MCPG_PID" 2>/dev/null || true
    wait "$MCPG_PID" 2>/dev/null || true
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
