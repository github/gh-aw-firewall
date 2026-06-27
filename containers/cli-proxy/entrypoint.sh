#!/bin/bash
# CLI Proxy sidecar entrypoint
#
# Connects to an external DIFC proxy (mcpg) started by the gh-aw compiler
# on the host. Uses a TCP tunnel to forward localhost:${DIFC_PORT} to
# ${DIFC_HOST}:${DIFC_PORT}, so the gh CLI can connect via localhost
# (matching the DIFC proxy's TLS cert SAN for localhost/127.0.0.1).
set -e

echo "[cli-proxy] Starting CLI proxy sidecar..."

NODE_PID=""
TUNNEL_PID=""

# External DIFC proxy host and port, set by docker-manager.ts
DIFC_HOST="${AWF_DIFC_PROXY_HOST:-host.docker.internal}"
DIFC_PORT="${AWF_DIFC_PROXY_PORT:-18443}"

echo "[cli-proxy] External DIFC proxy at ${DIFC_HOST}:${DIFC_PORT}"

# Start the TCP tunnel: localhost:${DIFC_PORT} → ${DIFC_HOST}:${DIFC_PORT}
# This allows the gh CLI to connect via localhost, matching the cert's SAN.
echo "[cli-proxy] Starting TCP tunnel: localhost:${DIFC_PORT} → ${DIFC_HOST}:${DIFC_PORT}"
node /app/tcp-tunnel.js "${DIFC_PORT}" "${DIFC_HOST}" "${DIFC_PORT}" &
TUNNEL_PID=$!

# Verify CA cert is available (bind-mounted from host by docker-manager.ts).
# Unlike the old architecture where mcpg generated the cert at runtime, the
# external DIFC proxy has already created the cert before AWF starts, so the
# bind mount makes it immediately available — no polling needed.
if [ ! -f /tmp/proxy-tls/ca.crt ]; then
  echo "[cli-proxy] ERROR: DIFC proxy TLS certificate not found at /tmp/proxy-tls/ca.crt"
  echo "[cli-proxy] Ensure --difc-proxy-ca-cert points to a valid CA cert file on the host"
  exit 1
fi
echo "[cli-proxy] TLS certificate available"

# Build a combined CA bundle so the gh CLI (Go binary) trusts the DIFC proxy's
# self-signed cert.  NODE_EXTRA_CA_CERTS only helps Node.js; Go programs use
# the system store or SSL_CERT_FILE.
COMBINED_CA="/tmp/proxy-tls/combined-ca.crt"
cat /etc/ssl/certs/ca-certificates.crt /tmp/proxy-tls/ca.crt > "${COMBINED_CA}"
echo "[cli-proxy] Combined CA bundle created at ${COMBINED_CA}"

# Configure gh CLI to route through the DIFC proxy via the TCP tunnel
# Uses localhost because the tunnel makes the DIFC proxy appear on localhost,
# matching the self-signed cert's SAN.
export GH_HOST="localhost:${DIFC_PORT}"
export GH_REPO="${GH_REPO:-$GITHUB_REPOSITORY}"
# Node.js (server.js / tcp-tunnel.js) uses NODE_EXTRA_CA_CERTS;
# gh CLI (Go) uses SSL_CERT_FILE pointing to the combined bundle;
# git (called by `gh repo clone`) uses GIT_SSL_CAINFO for OpenSSL verification.
export NODE_EXTRA_CA_CERTS="/tmp/proxy-tls/ca.crt"
export SSL_CERT_FILE="${COMBINED_CA}"
export GIT_SSL_CAINFO="${COMBINED_CA}"

echo "[cli-proxy] gh CLI configured to route through DIFC proxy at ${GH_HOST}"

# Probe external DIFC proxy liveness before serving agent traffic.
# Retries with exponential backoff to handle transient startup delays.
# Distinct error messages help distinguish "not yet ready" from "unreachable".

# Classify a failed DIFC-proxy liveness probe into a diagnostic category.
# Args: $1=gh stderr, $2=gh stdout (response body), $3=gh/timeout exit code.
# Echoes the diagnosis string. Kept as a pure function so it can be unit-tested
# in isolation — see tests/cli-proxy-probe-classify.test.sh (#5615).
#   ECONNREFUSED ("connection refused" in gh output)  → not yet ready
#   Timeout (exit 124, or "deadline"/"timed out")      → unreachable / slow
#   EAI_AGAIN / ENOTFOUND / getaddrinfo                → DNS not yet resolved
#     (peer may not yet be joined to awf-net; keep retrying, do not fail fast)
#   HTTP NNN in gh output                              → proxy reachable, but the
#     forwarded API call returned an error (wrong host / auth / tenant) — this is
#     the common GHEC data-residency (*.ghe.com) case, NOT "unknown"
#   Other                                              → unknown
classify_probe_failure() {
  local probe_err="$1" probe_out="$2" probe_exit="$3" http_status
  http_status="$(printf '%s\n%s\n' "${probe_err}" "${probe_out}" | grep -oiE "HTTP[/ ][0-9.]* ?[0-9]{3}|HTTP [0-9]{3}" | grep -oE "[0-9]{3}" | head -1 || true)"
  if echo "${probe_err}" | grep -qiE "connection refused|ECONNREFUSED"; then
    echo "not-yet-ready (ECONNREFUSED)"
  elif [ "${probe_exit}" -eq 124 ] || echo "${probe_err}" | grep -qiE "timeout|deadline|timed out"; then
    echo "unreachable (timeout)"
  elif echo "${probe_err}" | grep -qiE "EAI_AGAIN|ENOTFOUND|getaddrinfo|no such host|name or service not known"; then
    echo "dns-not-yet-ready"
  elif [ -n "${http_status}" ]; then
    echo "reachable-but-api-error (HTTP ${http_status})"
  else
    echo "unknown"
  fi
}

MAX_LIVENESS_ATTEMPTS="${AWF_CLI_PROXY_LIVENESS_ATTEMPTS:-10}"
LIVENESS_SLEEP_SECONDS="${AWF_CLI_PROXY_LIVENESS_SLEEP_SECONDS:-1}"
LIVENESS_TIMEOUT_SECONDS="${AWF_CLI_PROXY_LIVENESS_TIMEOUT_SECONDS:-5}"
PROBE_OUT_FILE="$(mktemp)"
PROBE_ERR_FILE="$(mktemp)"
trap 'rm -f "${PROBE_OUT_FILE}" "${PROBE_ERR_FILE}"' EXIT
ATTEMPT=1
while [ "$ATTEMPT" -le "$MAX_LIVENESS_ATTEMPTS" ]; do
  # Capture stdout (the gh response body) and stderr separately so a
  # "reachable but the forwarded API call failed" result (e.g. wrong API host
  # on *.ghe.com data-residency tenants) can surface the actual HTTP status and
  # body instead of being reported as an opaque diagnosis=unknown. See #5615.
  if timeout "${LIVENESS_TIMEOUT_SECONDS}" gh api rate_limit \
       >"${PROBE_OUT_FILE}" 2>"${PROBE_ERR_FILE}"; then
    echo "[cli-proxy] DIFC proxy liveness probe succeeded on attempt ${ATTEMPT}/${MAX_LIVENESS_ATTEMPTS}"
    break
  fi
  PROBE_EXIT=$?
  PROBE_ERR="$(cat "${PROBE_ERR_FILE}")"
  PROBE_OUT="$(cat "${PROBE_OUT_FILE}")"
  DIAG_TYPE="$(classify_probe_failure "${PROBE_ERR}" "${PROBE_OUT}" "${PROBE_EXIT}")"
  if [ "$ATTEMPT" -ge "$MAX_LIVENESS_ATTEMPTS" ]; then
    echo "[cli-proxy] ERROR: DIFC proxy liveness probe failed for ${GH_HOST} (gh api exit=${PROBE_EXIT}, diagnosis=${DIAG_TYPE})"
    if [ -n "${PROBE_ERR}" ]; then
      echo "[cli-proxy] gh api stderr: ${PROBE_ERR}"
    fi
    if [ -n "${PROBE_OUT}" ]; then
      echo "[cli-proxy] gh api response body: $(printf '%s' "${PROBE_OUT}" | head -c 1000)"
    fi
    # When the forwarded call is reachable but errors on an enterprise tenant,
    # the most likely cause is that the external DIFC proxy is not targeting the
    # enterprise API host. Surface a targeted hint (companion issues:
    # github/gh-aw-mcpg#8202, github/gh-aw#41911).
    case "${GITHUB_SERVER_URL:-}" in
      *ghe.com* | *ghe.localhost*)
        case "${DIAG_TYPE}" in
          reachable-but-api-error* | unknown)
            echo "[cli-proxy] HINT: GITHUB_SERVER_URL=${GITHUB_SERVER_URL} looks like a GitHub Enterprise"
            echo "[cli-proxy]       data-residency tenant. The external DIFC proxy may be targeting the"
            echo "[cli-proxy]       wrong API host (github.com instead of the enterprise host), so the"
            echo "[cli-proxy]       forwarded 'gh api' call fails. See github/gh-aw-firewall#5615."
            ;;
        esac
        ;;
    esac
    echo "[cli-proxy] Failing fast to avoid repeated in-agent retries"
    exit 1
  fi
  # Surface the captured gh error on every failed attempt so transient and
  # persistent failures (e.g. a stable HTTP error) are both visible in logs.
  if [ -n "${PROBE_ERR}" ]; then
    echo "[cli-proxy] gh api stderr (attempt ${ATTEMPT}): $(printf '%s' "${PROBE_ERR}" | head -c 500)"
  fi
  # Exponential backoff: sleep 1, 2, 4, 8 … seconds (capped at 30s)
  SLEEP_SECS=$(( LIVENESS_SLEEP_SECONDS * (1 << (ATTEMPT - 1)) ))
  if [ "${SLEEP_SECS}" -gt 30 ]; then SLEEP_SECS=30; fi
  echo "[cli-proxy] DIFC proxy probe failed (attempt ${ATTEMPT}/${MAX_LIVENESS_ATTEMPTS}, diagnosis=${DIAG_TYPE}), retrying in ${SLEEP_SECS}s..."
  sleep "${SLEEP_SECS}"
  ATTEMPT=$((ATTEMPT + 1))
done
rm -f "${PROBE_OUT_FILE}" "${PROBE_ERR_FILE}"
trap - EXIT

# Cleanup handler: stop the Node HTTP server and TCP tunnel on signal
cleanup() {
  echo "[cli-proxy] Shutting down..."
  if [ -n "$NODE_PID" ]; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "$TUNNEL_PID" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
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
