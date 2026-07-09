#!/bin/bash
# Shell unit tests for is_valid_port_spec() and parse_port_specs() in
# containers/agent/setup-iptables.sh.
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
# Source is_valid_port_spec() and parse_port_specs() from setup-iptables.sh.
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
PARSE_SPECS_FUNC_DEF=$(extract_func "parse_port_specs")

if [ -z "${IS_VALID_FUNC_DEF}" ]; then
  echo "❌ is_valid_port_spec() not found in ${SETUP_IPTABLES}"
  exit 1
fi

if [ -z "${PARSE_SPECS_FUNC_DEF}" ]; then
  echo "❌ parse_port_specs() not found in ${SETUP_IPTABLES}"
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

# run_parse_port_specs <input> <label>
# Outputs the resulting array elements, one per line.
# Warnings (lines starting with "[iptables] WARNING:") go to stdout from the
# function but are filtered out here so callers get only valid specs.
run_parse_port_specs() {
  local input="$1"
  local label="${2:-port spec}"
  (
    eval "${IS_VALID_FUNC_DEF}"
    eval "${PARSE_SPECS_FUNC_DEF}"
    declare -a _result=()
    parse_port_specs _result "$input" "$label"
    for elem in "${_result[@]}"; do
      echo "$elem"
    done
  ) 2>/dev/null | grep -v '^\[iptables\] WARNING:' || true
}

# run_parse_port_specs_warnings <input> <label>
# Outputs only the WARNING lines emitted by parse_port_specs.
run_parse_port_specs_warnings() {
  local input="$1"
  local label="${2:-port spec}"
  (
    eval "${IS_VALID_FUNC_DEF}"
    eval "${PARSE_SPECS_FUNC_DEF}"
    declare -a _result=()
    parse_port_specs _result "$input" "$label"
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
# parse_port_specs — functional tests
# ---------------------------------------------------------------------------

# Empty input produces empty result
result=$(run_parse_port_specs "" "port spec")
if [ -z "$result" ]; then
  pass "parse_port_specs returns empty array for empty input"
else
  fail "parse_port_specs should return empty array for empty input, got: ${result}"
fi

# Single valid port
result=$(run_parse_port_specs "80" "port spec")
if [ "$result" = "80" ]; then
  pass "parse_port_specs returns single valid port"
else
  fail "parse_port_specs should return '80' for input '80', got: '${result}'"
fi

# Multiple valid ports
mapfile -t result_arr < <(run_parse_port_specs "80,443,3128" "port spec")
if [ "${#result_arr[@]}" -eq 3 ] && [ "${result_arr[0]}" = "80" ] && [ "${result_arr[1]}" = "443" ] && [ "${result_arr[2]}" = "3128" ]; then
  pass "parse_port_specs returns all valid ports from comma-separated input"
else
  fail "parse_port_specs should return [80,443,3128], got: ${result_arr[*]}"
fi

# Port with surrounding whitespace is trimmed
result=$(run_parse_port_specs " 80 " "port spec")
if [ "$result" = "80" ]; then
  pass "parse_port_specs trims leading/trailing whitespace from port spec"
else
  fail "parse_port_specs should trim ' 80 ' to '80', got: '${result}'"
fi

# Valid port range
result=$(run_parse_port_specs "3000-3010" "port spec")
if [ "$result" = "3000-3010" ]; then
  pass "parse_port_specs accepts a valid port range"
else
  fail "parse_port_specs should accept range '3000-3010', got: '${result}'"
fi

# Invalid specs are filtered out; valid ones are kept
mapfile -t result_arr < <(run_parse_port_specs "80,0,443,65536" "port spec")
if [ "${#result_arr[@]}" -eq 2 ] && [ "${result_arr[0]}" = "80" ] && [ "${result_arr[1]}" = "443" ]; then
  pass "parse_port_specs filters invalid specs and keeps valid ones"
else
  fail "parse_port_specs should keep [80,443] from '80,0,443,65536', got: ${result_arr[*]}"
fi

# Invalid spec produces a warning message
warning_output=$(run_parse_port_specs_warnings "0" "port spec")
if echo "$warning_output" | grep -q "WARNING"; then
  pass "parse_port_specs emits WARNING for invalid spec"
else
  fail "parse_port_specs should emit WARNING for invalid spec '0', got: '${warning_output}'"
fi

# All-invalid input returns empty array
result=$(run_parse_port_specs "0,65536,abc" "port spec")
if [ -z "$result" ]; then
  pass "parse_port_specs returns empty array when all specs are invalid"
else
  fail "parse_port_specs should return empty array for all-invalid input, got: '${result}'"
fi

# Mix of valid ports and ranges
mapfile -t result_arr < <(run_parse_port_specs "80,3000-3010,443" "port spec")
if [ "${#result_arr[@]}" -eq 3 ] && [ "${result_arr[0]}" = "80" ] && [ "${result_arr[1]}" = "3000-3010" ] && [ "${result_arr[2]}" = "443" ]; then
  pass "parse_port_specs handles mix of single ports and ranges"
else
  fail "parse_port_specs should return [80,3000-3010,443], got: ${result_arr[*]}"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
