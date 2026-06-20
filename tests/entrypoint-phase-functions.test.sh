#!/bin/bash
set -e

ENTRYPOINT="$(dirname "$0")/../containers/agent/entrypoint.sh"

if [ ! -f "${ENTRYPOINT}" ]; then
  echo "❌ Cannot find entrypoint.sh at ${ENTRYPOINT}"
  exit 1
fi

PASS=0
FAIL=0

pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

required_functions=(
  print_banner
  setup_user_identity
  configure_dns
  configure_ssl_certs
  wait_for_iptables
  check_service_health
  configure_claude_api_key
  configure_jvm_proxy
  log_environment_details
  determine_capabilities_to_drop
  log_execution_context
  run_chroot_command
  run_non_chroot_command
  main
)

for fn in "${required_functions[@]}"; do
  if grep -Eq "^${fn}\(\) \{" "${ENTRYPOINT}"; then
    pass "${fn}() is defined"
  else
    fail "${fn}() is not defined"
  fi
done

if bash -n "${ENTRYPOINT}"; then
  pass "entrypoint.sh passes bash syntax check"
else
  fail "entrypoint.sh failed bash syntax check"
fi

MAIN_BLOCK="$(awk '
  /^main\(\) \{/ { in_main=1; next }
  in_main && /^}/ { in_main=0; exit }
  in_main { print }
' "${ENTRYPOINT}")"

required_calls=(
  'print_banner'
  'setup_user_identity'
  'configure_dns'
  'configure_ssl_certs'
  'wait_for_iptables'
  'check_service_health'
  'configure_claude_api_key'
  'configure_jvm_proxy'
  'log_environment_details'
  'determine_capabilities_to_drop'
  'log_execution_context "$@"'
)

last_line=0
for call in "${required_calls[@]}"; do
  line_number="$(printf '%s\n' "${MAIN_BLOCK}" | grep -n -F "${call}" | cut -d: -f1 | head -1)"
  if [ -z "${line_number}" ]; then
    fail "main() does not call ${call}"
    continue
  fi
  if [ "${line_number}" -le "${last_line}" ]; then
    fail "main() calls ${call} out of order"
    continue
  fi
  last_line="${line_number}"
  pass "main() calls ${call} in order"
done

if printf '%s\n' "${MAIN_BLOCK}" | grep -Fq 'run_chroot_command "$@"' && \
   printf '%s\n' "${MAIN_BLOCK}" | grep -Fq 'run_non_chroot_command "$@"'; then
  pass "main() dispatches to chroot and non-chroot execution helpers"
else
  fail "main() is missing chroot/non-chroot dispatch"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

[ "${FAIL}" -eq 0 ]
