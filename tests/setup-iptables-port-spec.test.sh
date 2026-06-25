#!/bin/bash
# Shell unit tests for is_valid_port_spec() in containers/agent/setup-iptables.sh.
#
# Runs every case from tests/port-spec-fixtures.json against the shell
# implementation to ensure it stays aligned with the TypeScript isValidPortSpec()
# in src/host-iptables-validation.ts.
#
# Usage:
#   bash tests/setup-iptables-port-spec.test.sh
#
# Requires: bash, python3 (for JSON parsing)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP_IPTABLES="${SCRIPT_DIR}/../containers/agent/setup-iptables.sh"
FIXTURES_FILE="${SCRIPT_DIR}/port-spec-fixtures.json"

if [ ! -f "${SETUP_IPTABLES}" ]; then
  echo "❌ Cannot find setup-iptables.sh at ${SETUP_IPTABLES}"
  exit 1
fi

if [ ! -f "${FIXTURES_FILE}" ]; then
  echo "❌ Cannot find port-spec-fixtures.json at ${FIXTURES_FILE}"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "❌ python3 is required to parse port-spec-fixtures.json"
  exit 1
fi

PASS=0
FAIL=0

pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Source only the is_valid_port_spec() function from setup-iptables.sh.
# We use a subshell per test to avoid the outer `set -e` aborting on failures
# returned by is_valid_port_spec().
# ---------------------------------------------------------------------------

# Extract function definition (everything up to the first blank line after the
# closing brace of is_valid_port_spec) so we can source it in isolation without
# side-effects from the rest of the script.
FUNC_DEF=$(awk '
  /^is_valid_port_spec\(\)/ { capture=1 }
  capture { print }
  capture && /^}/ { capture=0; exit }
' "${SETUP_IPTABLES}")

if [ -z "${FUNC_DEF}" ]; then
  echo "❌ is_valid_port_spec() not found in ${SETUP_IPTABLES}"
  exit 1
fi

run_is_valid_port_spec() {
  local spec="$1"
  # Run in a subshell so a non-zero return doesn't kill the test runner
  (
    eval "${FUNC_DEF}"
    is_valid_port_spec "$spec"
  )
}

# ---------------------------------------------------------------------------
# Load test vectors from the shared fixture file
# ---------------------------------------------------------------------------

mapfile -t VALID_SPECS < <(python3 -c "
import json, sys
with open('${FIXTURES_FILE}') as f:
    data = json.load(f)
for s in data['valid']:
    print(s)
")

mapfile -t INVALID_SPECS < <(python3 -c "
import json, sys
with open('${FIXTURES_FILE}') as f:
    data = json.load(f)
for s in data['invalid']:
    print(s)
")

# ---------------------------------------------------------------------------
# Test valid specs — is_valid_port_spec() should return 0 (success)
# ---------------------------------------------------------------------------

for spec in "${VALID_SPECS[@]}"; do
  if run_is_valid_port_spec "${spec}" &>/dev/null; then
    pass "accepts valid spec '${spec}'"
  else
    fail "should accept '${spec}' but rejected it"
  fi
done

# ---------------------------------------------------------------------------
# Test invalid specs — is_valid_port_spec() should return non-zero (failure)
# ---------------------------------------------------------------------------

for spec in "${INVALID_SPECS[@]}"; do
  if run_is_valid_port_spec "${spec}" &>/dev/null; then
    fail "should reject '${spec}' but accepted it"
  else
    pass "rejects invalid spec '${spec}'"
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
