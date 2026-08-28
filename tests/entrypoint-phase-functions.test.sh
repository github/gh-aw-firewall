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
  warn_codex_auto_model
  log_environment_details
  determine_capabilities_to_drop
  log_execution_context
  mount_host_procfs
  mount_host_cgroupfs
  copy_preload_libs
  copy_agent_helper_scripts
  copy_dind_runner_binary
  resolve_chroot_binary_path
  prepare_usr_local_bin_overlay
  populate_usr_local_bin_farm
  cleanup_usr_local_bin_overlay
  ensure_usr_local_bin_shims
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
  'warn_codex_auto_model'
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
  'mount_host_cgroupfs'
  'check_chroot_prereqs'
  'copy_preload_libs'
  'copy_agent_helper_scripts'
  'copy_dind_runner_binary'
  'ensure_usr_local_bin_shims'
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

if grep -Fq 'umount /host/sys/fs/cgroup' "${ENTRYPOINT}" && \
   grep -Fq 'Could not remove writable cgroup mount; refusing to start sandbox command' "${ENTRYPOINT}"; then
  pass "mount_host_cgroupfs() removes a mount that cannot be made read-only"
else
  fail "mount_host_cgroupfs() may leave a writable cgroup mount behind"
fi

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

if printf '%s\n' "${COPY_SYSTEM_CA_BUNDLE_BLOCK}" | grep -Fq '/etc/pki/ca-trust/extracted/*|/etc/pki/tls/certs/*)'; then
  pass "copy_system_ca_bundle() treats mounted RHEL/Amazon Linux CA paths as chroot-accessible"
else
  fail "copy_system_ca_bundle() does not recognize mounted RHEL/Amazon Linux CA paths as chroot-accessible"
fi

run_copy_system_ca_bundle_fixture() {
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  local host_root="${tmp_dir}/host-root"
  local fixture_entrypoint="${tmp_dir}/entrypoint-fixture.sh"
  mkdir -p "${host_root}/etc/pki/tls/certs" "${host_root}/etc/ssl/certs"
  printf '%s\n' "fixture-ca-cert" > "${host_root}/etc/pki/tls/certs/ca-bundle.crt"

  awk '$0 != "main \"$@\""' "${ENTRYPOINT}" > "${fixture_entrypoint}"
  sed -i "s#/host#\${AWF_TEST_HOST_ROOT}#g" "${fixture_entrypoint}"

  (
    set -e
    # shellcheck disable=SC1090
    . "${fixture_entrypoint}"

    AWF_SSL_BUMP_ENABLED="false"
    AWF_CA_CHROOT=""
    AWF_TEST_HOST_ROOT="${host_root}"

    unset SSL_CERT_FILE NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO SYSTEM_CA_CHROOT
    copy_system_ca_bundle
    [ "${SSL_CERT_FILE}" = "/etc/pki/tls/certs/ca-bundle.crt" ]
    [ -r "${AWF_TEST_HOST_ROOT}${SSL_CERT_FILE}" ]
    [ "${NODE_EXTRA_CA_CERTS}" = "${SSL_CERT_FILE}" ]

    ln -sf ../../pki/tls/certs/ca-bundle.crt "${host_root}/etc/ssl/certs/ca-certificates.crt"
    unset SSL_CERT_FILE NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO SYSTEM_CA_CHROOT
    copy_system_ca_bundle
    [ "${SSL_CERT_FILE}" = "/etc/ssl/certs/ca-certificates.crt" ]
    [ -r "${AWF_TEST_HOST_ROOT}${SSL_CERT_FILE}" ]
    [ "${NODE_EXTRA_CA_CERTS}" = "${SSL_CERT_FILE}" ]
  )
  local result=$?
  rm -rf "${tmp_dir}"
  return "${result}"
}

if run_copy_system_ca_bundle_fixture; then
  pass "copy_system_ca_bundle() exports chroot-readable CA paths for direct RHEL bundles and /etc/ssl symlink targets"
else
  fail "copy_system_ca_bundle() does not export chroot-readable CA paths for RHEL bundle fixtures"
fi

if grep -Eq '\[ -n "\$\{SYSTEM_CA_CHROOT\}" \]' "${ENTRYPOINT}"; then
  pass "run_chroot_command() cleans up copied system CA bundles"
else
  fail "run_chroot_command() does not clean up copied system CA bundles"
fi

# configure_jvm_proxy must not abort the entrypoint (set -e) when $HOME is
# read-only, including when .m2/.gradle already exist but cannot be written.
run_configure_jvm_proxy_readonly_home_fixture() {
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  local fake_home="${tmp_dir}/home"
  mkdir -p "${fake_home}/.m2" "${fake_home}/.gradle"
  chmod 555 "${fake_home}/.m2" "${fake_home}/.gradle" "${fake_home}"

  # Run in a separate bash process: `set -e` is ignored inside a subshell that
  # is part of an `if` condition, which would mask the abort this test guards.
  env -u JAVA_TOOL_OPTIONS \
    HOME="${fake_home}" \
    AWF_CHROOT_ENABLED="false" \
    HTTP_PROXY="http://172.30.0.10:3128" \
    SQUID_PROXY_HOST="172.30.0.10" \
    SQUID_PROXY_PORT="3128" \
    bash -c '
      set -e
      # The BASH_SOURCE guard keeps main() from running when sourced.
      . "$1"
      configure_jvm_proxy > /dev/null
      [ ! -f "${HOME}/.m2/settings.xml" ]
      [ ! -f "${HOME}/.gradle/gradle.properties" ]
      case "${JAVA_TOOL_OPTIONS}" in
        *-Dhttps.proxyHost=172.30.0.10*) ;;
        *) exit 1 ;;
      esac
    ' _ "${ENTRYPOINT}" 2>/dev/null
  local result=$?
  chmod -R u+w "${fake_home}" 2>/dev/null || true
  rm -rf "${tmp_dir}"
  return "${result}"
}

if [ "$(id -u)" -eq 0 ]; then
  pass "configure_jvm_proxy() read-only home check skipped (running as root)"
elif run_configure_jvm_proxy_readonly_home_fixture; then
  pass "configure_jvm_proxy() survives an existing but read-only .m2/.gradle"
else
  fail "configure_jvm_proxy() aborts when .m2/.gradle exist on a read-only home"
fi

run_warn_codex_auto_model_fixture() {
  local output
  output="$(
    env \
      AWF_API_PROXY_IP="172.30.0.30" \
      OPENAI_BASE_URL="http://172.30.0.30:10000" \
      GH_AW_AWF_ENGINE_NAME="codex" \
      GH_AW_MODEL_AGENT_CODEX="auto" \
      bash -c '
        . "$1"
        warn_codex_auto_model
      ' _ "${ENTRYPOINT}" 2>&1
  )"
  case "${output}" in
    *"Codex model 'auto' is not supported with AWF api-proxy/API-key routing."*\
*"Set an explicit Codex model in workflow frontmatter"*)
      ;;
    *)
      return 1
      ;;
  esac

  output="$(
    env \
      AWF_API_PROXY_IP="172.30.0.30" \
      GH_AW_AWF_ENGINE_NAME="codex" \
      GH_AW_MODEL_AGENT_CODEX="gpt-5-codex" \
      bash -c '
        . "$1"
        warn_codex_auto_model
      ' _ "${ENTRYPOINT}" 2>&1
  )"
  [ -z "${output}" ]

  output="$(
    env \
      AWF_API_PROXY_IP="172.30.0.30" \
      GH_AW_AWF_ENGINE_NAME="codex" \
      GH_AW_MODEL_AGENT_CODEX="auto" \
      bash -c '
        . "$1"
        warn_codex_auto_model
      ' _ "${ENTRYPOINT}" 2>&1
  )"
  [ -z "${output}" ]
}

if run_warn_codex_auto_model_fixture; then
  pass "warn_codex_auto_model() warns only for codex model auto under api-proxy"
else
  fail "warn_codex_auto_model() did not warn correctly for codex model auto under api-proxy"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

[ "${FAIL}" -eq 0 ]
