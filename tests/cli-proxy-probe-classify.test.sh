#!/bin/bash
# Shell unit tests for classify_probe_failure() in
# containers/cli-proxy/entrypoint.sh.
#
# Verifies the DIFC-proxy liveness probe failure classifier, in particular the
# "reachable-but-api-error (HTTP NNN)" bucket added in #5615 so that GHEC
# data-residency (*.ghe.com) failures are no longer reported as diagnosis=unknown.
#
# Usage:
#   bash tests/cli-proxy-probe-classify.test.sh
#
# Requires: bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTRYPOINT="${SCRIPT_DIR}/../containers/cli-proxy/entrypoint.sh"

if [ ! -f "${ENTRYPOINT}" ]; then
  echo "❌ Cannot find entrypoint.sh at ${ENTRYPOINT}"
  exit 1
fi

# Extract only the classify_probe_failure() definition so we can source it in
# isolation without running the rest of the entrypoint (which starts servers).
FUNC_DEF=$(awk '
  $0 ~ /^[[:space:]]*classify_probe_failure\(\)[[:space:]]*\{/ { capture=1 }
  capture { print }
  capture && $0 ~ /^[[:space:]]*}[[:space:]]*$/ { exit }
' "${ENTRYPOINT}")

if [ -z "${FUNC_DEF}" ]; then
  echo "❌ classify_probe_failure() not found in ${ENTRYPOINT}"
  exit 1
fi

run_classify() {
  # Run in a subshell so the eval'd definition doesn't leak.
  (
    eval "${FUNC_DEF}"
    classify_probe_failure "$1" "$2" "$3"
  )
}

PASS=0
FAIL=0
pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

# expect <description> <expected> <stderr> <stdout> <exit>
expect() {
  local desc="$1" expected="$2" got
  got="$(run_classify "$3" "$4" "$5")"
  if [ "${got}" = "${expected}" ]; then
    pass "${desc} → '${got}'"
  else
    fail "${desc}: expected '${expected}' but got '${got}'"
  fi
}

# Connection refused → not yet ready
expect "ECONNREFUSED" "not-yet-ready (ECONNREFUSED)" \
  "dial tcp 127.0.0.1:18443: connect: connection refused" "" 1

# Timeout via exit code 124 (GNU timeout) → unreachable
expect "timeout exit 124" "unreachable (timeout)" "" "" 124

# Timeout via message → unreachable
expect "context deadline" "unreachable (timeout)" \
  "Get \"https://localhost:18443\": context deadline exceeded" "" 1

# DNS not yet resolved → keep retrying
expect "EAI_AGAIN" "dns-not-yet-ready" \
  "lookup awf-topology-peer: getaddrinfo EAI_AGAIN" "" 1

# HTTP error in stderr → reachable-but-api-error (the *.ghe.com case)
expect "HTTP 404 in stderr" "reachable-but-api-error (HTTP 404)" \
  "gh: Not Found (HTTP 404)" "" 1

# HTTP 401 auth error
expect "HTTP 401 in stderr" "reachable-but-api-error (HTTP 401)" \
  "gh: Bad credentials (HTTP 401)" '{"message":"Bad credentials"}' 1

# HTTP status only present in the response body
expect "HTTP status in body" "reachable-but-api-error (HTTP 400)" \
  "" "HTTP/2 400 bad request" 1

# Unclassifiable → unknown (and must not crash under set -e when no HTTP match)
expect "unknown fallback" "unknown" \
  "some completely unexpected failure" "" 1

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
