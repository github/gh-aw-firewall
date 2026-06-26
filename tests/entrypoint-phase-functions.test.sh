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
  mount_host_procfs
  copy_preload_libs
  copy_agent_helper_scripts
  copy_dind_runner_binary
  copy_awf_ca_cert
  check_chroot_prereqs
  setup_chroot_etc
  build_path_script
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

# Verify run_chroot_command delegates to all required helper sub-functions in order
CHROOT_BLOCK="$(awk '
  /^[[:space:]]*run_chroot_command\(\)[[:space:]]*\{[[:space:]]*$/ { in_fn=1; next }
  in_fn && /^[[:space:]]*}[[:space:]]*$/ { in_fn=0; exit }
  in_fn { print }
' "${ENTRYPOINT}")"

chroot_helpers=(
  'mount_host_procfs'
  'check_chroot_prereqs'
  'copy_preload_libs'
  'copy_agent_helper_scripts'
  'copy_dind_runner_binary'
  'copy_awf_ca_cert'
  'setup_chroot_etc'
  'build_path_script'
)

last_helper_line=0
for helper in "${chroot_helpers[@]}"; do
  helper_line="$(printf '%s\n' "${CHROOT_BLOCK}" | grep -n -F "${helper}" | cut -d: -f1 | head -1)"
  if [ -z "${helper_line}" ]; then
    fail "run_chroot_command() does not call ${helper}"
    continue
  fi
  if [ "${helper_line}" -le "${last_helper_line}" ]; then
    fail "run_chroot_command() calls ${helper} out of order"
    continue
  fi
  last_helper_line="${helper_line}"
  pass "run_chroot_command() calls ${helper} in order"
done

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

[ "${FAIL}" -eq 0 ]
