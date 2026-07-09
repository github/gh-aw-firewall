#!/bin/bash
# Shell unit tests for is_valid_port_spec() and split_valid_port_specs() in
# containers/agent/setup-iptables.sh.
#
# Runs every case from tests/port-spec-fixtures.json against the shell
# implementation to ensure it stays aligned with the TypeScript isValidPortSpec()
# in src/host-iptables-validation.ts.
#
# split_valid_port_specs() is the replacement for the former parse_port_specs();
# it consumes pre-validated specs produced by TypeScript parseValidPortSpecs()
# and applies is_valid_port_spec() as a fail-closed assertion rather than a
# full second parser.
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
# Source is_valid_port_spec() and split_valid_port_specs() from setup-iptables.sh.
# ---------------------------------------------------------------------------

# Extract both function definitions so we can source them in isolation without
# side-effects from the rest of the script.
extract_func() {
  local func_name="$1"
  awk -v fn="${func_name}" '
    $0 ~ "^"fn"\\(\\)" { capture=1 }
    capture { print }
    capture && /^}/ { capture=0; exit }
  ' "${SETUP_IPTABLES}"
}

IS_VALID_FUNC_DEF=$(extract_func "is_valid_port_spec")
SPLIT_SPECS_FUNC_DEF=$(extract_func "split_valid_port_specs")

if [ -z "${IS_VALID_FUNC_DEF}" ]; then
  echo "❌ is_valid_port_spec() not found in ${SETUP_IPTABLES}"
  exit 1
fi

if [ -z "${SPLIT_SPECS_FUNC_DEF}" ]; then
  echo "❌ split_valid_port_specs() not found in ${SETUP_IPTABLES}"
  exit 1
fi

run_is_valid_port_spec() {
  local spec="$1"
  # Run in a subshell to isolate the eval so the function definition
  # doesn't leak into the outer shell's namespace.
  (
    eval "${IS_VALID_FUNC_DEF}"
    is_valid_port_spec "$spec"
  )
}

# run_split_valid_port_specs <input> <label>
# Outputs the resulting array elements, one per line.
# Warnings (lines starting with "[iptables] WARNING:") go to stdout from the
# function but are filtered out here so callers get only valid specs.
run_split_valid_port_specs() {
  local input="$1"
  local label="${2:-port spec}"
  (
    eval "${IS_VALID_FUNC_DEF}"
    eval "${SPLIT_SPECS_FUNC_DEF}"
    declare -a _result=()
    split_valid_port_specs _result "$input" "$label"
    for elem in "${_result[@]}"; do
      echo "$elem"
    done
  ) 2>/dev/null | grep -v '^\[iptables\] WARNING:' || true
}

# run_split_valid_port_specs_warnings <input> <label>
# Outputs only the WARNING lines emitted by split_valid_port_specs.
run_split_valid_port_specs_warnings() {
  local input="$1"
  local label="${2:-port spec}"
  (
    eval "${IS_VALID_FUNC_DEF}"
    eval "${SPLIT_SPECS_FUNC_DEF}"
    declare -a _result=()
    split_valid_port_specs _result "$input" "$label"
  ) 2>/dev/null | grep '^\[iptables\] WARNING:' || true
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
# is_valid_port_spec — valid specs
# ---------------------------------------------------------------------------

for spec in "${VALID_SPECS[@]}"; do
  if run_is_valid_port_spec "${spec}" &>/dev/null; then
    pass "is_valid_port_spec accepts valid spec '${spec}'"
  else
    fail "is_valid_port_spec should accept '${spec}' but rejected it"
  fi
done

# ---------------------------------------------------------------------------
# is_valid_port_spec — invalid specs
# ---------------------------------------------------------------------------

for spec in "${INVALID_SPECS[@]}"; do
  if run_is_valid_port_spec "${spec}" &>/dev/null; then
    fail "is_valid_port_spec should reject '${spec}' but accepted it"
  else
    pass "is_valid_port_spec rejects invalid spec '${spec}'"
  fi
done

# ---------------------------------------------------------------------------
# split_valid_port_specs — functional tests (fail-closed assertion behaviour)
# ---------------------------------------------------------------------------

# Empty input produces empty result
result=$(run_split_valid_port_specs "" "port spec")
if [ -z "$result" ]; then
  pass "split_valid_port_specs returns empty array for empty input"
else
  fail "split_valid_port_specs should return empty array for empty input, got: ${result}"
fi

# Single valid port
result=$(run_split_valid_port_specs "80" "port spec")
if [ "$result" = "80" ]; then
  pass "split_valid_port_specs returns single valid port"
else
  fail "split_valid_port_specs should return '80' for input '80', got: '${result}'"
fi

# Multiple valid ports
mapfile -t result_arr < <(run_split_valid_port_specs "80,443,3128" "port spec")
if [ "${#result_arr[@]}" -eq 3 ] && [ "${result_arr[0]}" = "80" ] && [ "${result_arr[1]}" = "443" ] && [ "${result_arr[2]}" = "3128" ]; then
  pass "split_valid_port_specs returns all valid ports from comma-separated input"
else
  fail "split_valid_port_specs should return [80,443,3128], got: ${result_arr[*]}"
fi

# Multiple valid ports with whitespace around entries
mapfile -t result_arr < <(run_split_valid_port_specs "80, 443 ,3128" "port spec")
if [ "${#result_arr[@]}" -eq 3 ] && [ "${result_arr[0]}" = "80" ] && [ "${result_arr[1]}" = "443" ] && [ "${result_arr[2]}" = "3128" ]; then
  pass "split_valid_port_specs trims surrounding whitespace on entries"
else
  fail "split_valid_port_specs should trim and return [80,443,3128], got: ${result_arr[*]}"
fi

# Valid port range
result=$(run_split_valid_port_specs "3000-3010" "port spec")
if [ "$result" = "3000-3010" ]; then
  pass "split_valid_port_specs accepts a valid port range"
else
  fail "split_valid_port_specs should accept range '3000-3010', got: '${result}'"
fi

# Fail-closed: an unexpectedly invalid entry is skipped with a warning
mapfile -t result_arr < <(run_split_valid_port_specs "80,0,443" "port spec")
if [ "${#result_arr[@]}" -eq 2 ] && [ "${result_arr[0]}" = "80" ] && [ "${result_arr[1]}" = "443" ]; then
  pass "split_valid_port_specs (fail-closed) skips unexpected invalid entry"
else
  fail "split_valid_port_specs should keep [80,443] from '80,0,443', got: ${result_arr[*]}"
fi

# Fail-closed warning message
warning_output=$(run_split_valid_port_specs_warnings "0" "port spec")
if echo "$warning_output" | grep -q "WARNING"; then
  pass "split_valid_port_specs emits WARNING for unexpected invalid spec"
else
  fail "split_valid_port_specs should emit WARNING for invalid spec '0', got: '${warning_output}'"
fi

# All-invalid input returns empty array
result=$(run_split_valid_port_specs "0,65536,abc" "port spec")
if [ -z "$result" ]; then
  pass "split_valid_port_specs returns empty array when all specs are invalid"
else
  fail "split_valid_port_specs should return empty array for all-invalid input, got: '${result}'"
fi

# Mix of valid ports and ranges
mapfile -t result_arr < <(run_split_valid_port_specs "80,3000-3010,443" "port spec")
if [ "${#result_arr[@]}" -eq 3 ] && [ "${result_arr[0]}" = "80" ] && [ "${result_arr[1]}" = "3000-3010" ] && [ "${result_arr[2]}" = "443" ]; then
  pass "split_valid_port_specs handles mix of single ports and ranges"
else
  fail "split_valid_port_specs should return [80,3000-3010,443], got: ${result_arr[*]}"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
