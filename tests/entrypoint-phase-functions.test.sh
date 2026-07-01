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
  copy_system_ca_bundle
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

COPY_SYSTEM_CA_BUNDLE_BLOCK="$(awk '
  /^[[:space:]]*copy_system_ca_bundle\(\)[[:space:]]*\{[[:space:]]*$/ { in_fn=1; next }
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
  'copy_system_ca_bundle'
  'setup_chroot_etc'
  'build_path_script'
)

last_helper_line=0
for helper in "${chroot_helpers[@]}"; do
  helper_line="$(printf '%s\n' "${CHROOT_BLOCK}" | grep -n -E "^[[:space:]]*${helper}([[:space:]]|$)" | cut -d: -f1 | head -1)"
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

if printf '%s\n' "${COPY_SYSTEM_CA_BUNDLE_BLOCK}" | grep -Fq 'if [ "${AWF_SSL_BUMP_ENABLED}" = "true" ]'; then
  pass "copy_system_ca_bundle() keys SSL Bump handling off AWF_SSL_BUMP_ENABLED"
else
  fail "copy_system_ca_bundle() does not key SSL Bump handling off AWF_SSL_BUMP_ENABLED"
fi

if printf '%s\n' "${COPY_SYSTEM_CA_BUNDLE_BLOCK}" | grep -Fq "printf '\\n'" && \
   printf '%s\n' "${COPY_SYSTEM_CA_BUNDLE_BLOCK}" | grep -Fq '"/host${AWF_CA_CHROOT}"'; then
  pass "copy_system_ca_bundle() appends system roots to the staged AWF CA bundle safely"
else
  fail "copy_system_ca_bundle() does not safely append system roots to the staged AWF CA bundle"
fi

if grep -Eq '\[ -n "\$\{SYSTEM_CA_CHROOT\}" \]' "${ENTRYPOINT}"; then
  pass "run_chroot_command() cleans up copied system CA bundles"
else
  fail "run_chroot_command() does not clean up copied system CA bundles"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

[ "${FAIL}" -eq 0 ]
