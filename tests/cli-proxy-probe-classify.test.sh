#!/bin/bash
# Shell unit tests for the liveness probe and classify_probe_failure() in
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

# Timeout via exit code 143 (BusyBox timeout) → unreachable
expect "timeout exit 143" "unreachable (timeout)" "" "" 143

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

# Exercise the actual startup gate, not just its diagnostic classifier.
PROBE_DEF=$(awk '
  /^MAX_LIVENESS_ATTEMPTS=/ { capture=1 }
  capture { print }
  capture && /^trap - EXIT$/ { exit }
' "${ENTRYPOINT}")

if [ -z "${PROBE_DEF}" ]; then
  echo "❌ Liveness probe not found in ${ENTRYPOINT}"
  exit 1
fi

run_probe() {
  export TEST_PROBE_ERR="$1" TEST_PROBE_OUT="$2" TEST_PROBE_EXIT="$3"
  export AWF_CLI_PROXY_LIVENESS_ATTEMPTS=2 AWF_CLI_PROXY_LIVENESS_SLEEP_SECONDS=0
  export AWF_CLI_PROXY_MODE=primary GH_HOST=localhost:18443
  export GITHUB_SERVER_URL=https://github.example.com
  bash -c "${FUNC_DEF}
timeout() {
  printf '%s' \"\$TEST_PROBE_ERR\" >&2
  printf '%s' \"\$TEST_PROBE_OUT\"
  return \"\$TEST_PROBE_EXIT\"
}
set -e
${PROBE_DEF}
echo PROBE_READY"
}

# expect_probe <description> <exit> <log fragment> <stderr> <stdout> <probe exit>
expect_probe() {
  local desc="$1" expected_exit="$2" expected_log="$3" got status
  if got="$(run_probe "$4" "$5" "$6")"; then
    status=0
  else
    status=$?
  fi
  if [ "${status}" -ne "${expected_exit}" ] ||
     ! grep -qF "${expected_log}" <<< "${got}"; then
    fail "${desc}: exit=${status}, output=${got}"
  elif [ "${expected_exit}" -eq 0 ] &&
       { ! grep -qF "PROBE_READY" <<< "${got}" || grep -qF "retrying" <<< "${got}"; }; then
    fail "${desc}: did not become ready immediately: ${got}"
  elif [ "${expected_exit}" -ne 0 ] &&
       { grep -qF "PROBE_READY" <<< "${got}" || ! grep -qF "attempt 1/2" <<< "${got}"; }; then
    fail "${desc}: did not retry and fail closed: ${got}"
  else
    pass "${desc}"
  fi
}

expect_probe "successful API response starts immediately" 0 \
  "liveness probe succeeded on attempt 1/2" "" '{"resources":{}}' 0
expect_probe "GHES rate limiting disabled in stderr starts immediately" 0 \
  "WARNING: GHES rate limiting is disabled" \
  "gh: Rate limiting is not enabled. (HTTP 404)" "" 1
expect_probe "GHES rate limiting disabled in body starts immediately" 0 \
  "WARNING: GHES rate limiting is disabled" \
  "gh: Not Found (HTTP 404)" '{"message":"Rate limiting is not enabled."}' 1
expect_probe "generic 404 remains fatal" 1 \
  "gh api exit=1, diagnosis=reachable-but-api-error (HTTP 404)" \
  "gh: Not Found (HTTP 404)" "" 1
expect_probe "authentication error remains fatal" 1 \
  "diagnosis=reachable-but-api-error (HTTP 401)" \
  "gh: Bad credentials (HTTP 401)" "" 1
expect_probe "rate limiting message without HTTP status remains fatal" 1 \
  "diagnosis=unknown" "Rate limiting is not enabled." "" 1
expect_probe "rate limiting message with another status remains fatal" 1 \
  "diagnosis=reachable-but-api-error (HTTP 500)" \
  "gh: Rate limiting is not enabled. (HTTP 500)" "" 1
expect_probe "connection refused remains fatal" 1 \
  "diagnosis=not-yet-ready (ECONNREFUSED)" "connect: connection refused" "" 1
expect_probe "DNS error remains fatal" 1 \
  "diagnosis=dns-not-yet-ready" "getaddrinfo EAI_AGAIN" "" 1
expect_probe "silent timeout retains exit code and remains fatal" 1 \
  "gh api exit=124, diagnosis=unreachable (timeout)" "" "" 124
expect_probe "BusyBox timeout exit 143 remains fatal" 1 \
  "gh api exit=143, diagnosis=unreachable (timeout)" "" "" 143
expect_probe "partial HTTP response does not override timeout" 1 \
  "gh api exit=124, diagnosis=unreachable (timeout)" \
  "gh: Rate limiting is not enabled. (HTTP 404)" "" 124
expect_probe "TLS error remains fatal" 1 \
  "diagnosis=unknown" "x509: certificate signed by unknown authority" "" 1

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
