#!/bin/bash
# Unit test for the /usr/local/bin shim helpers in containers/agent/entrypoint.sh
#
# Harnesses such as gh-aw's Copilot engine spawn their CLI through the hardcoded
# path /usr/local/bin/copilot. When the Copilot CLI tool-cache is warm, the
# upstream installer only exports the cache directory to PATH/GITHUB_PATH and
# never installs that wrapper, so the spawn fails with ENOENT.
#
# These tests exercise resolve_chroot_binary_path() and ensure_usr_local_bin_shims()
# against a writable fixture root (the read-only /usr overlay fallback requires
# mount privileges and is not covered here).

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

# Build a sourceable copy of entrypoint.sh where every /host prefix points at a
# writable fixture root (same technique as tests/entrypoint-phase-functions.test.sh).
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

HOST_ROOT="${TMPDIR_TEST}/host-root"
FIXTURE_ENTRYPOINT="${TMPDIR_TEST}/entrypoint-fixture.sh"
awk '/^if \[\[ "\$\{BASH_SOURCE\[0\]\}"/ { exit } { print }' "${ENTRYPOINT}" > "${FIXTURE_ENTRYPOINT}"
sed -i "s#/host#${HOST_ROOT}#g" "${FIXTURE_ENTRYPOINT}"

# Fixture layout: copilot lives only in a tool-cache directory exported through
# GITHUB_PATH, exactly like a warm Copilot CLI cache hit.
CACHE_BIN="/opt/hostedtoolcache/copilot/1.2.3/x64/bin"
mkdir -p "${HOST_ROOT}${CACHE_BIN}" "${HOST_ROOT}/usr/local/bin" "${HOST_ROOT}/tmp"
printf '#!/bin/sh\necho copilot\n' > "${HOST_ROOT}${CACHE_BIN}/copilot"
chmod +x "${HOST_ROOT}${CACHE_BIN}/copilot"

GITHUB_PATH_FILE="/tmp/github-path"
printf '%s\n' "${CACHE_BIN}" > "${HOST_ROOT}${GITHUB_PATH_FILE}"

run_case() {
  (
    set -e
    # shellcheck disable=SC1090
    . "${FIXTURE_ENTRYPOINT}"
    GITHUB_PATH="${GITHUB_PATH_FILE}"
    AWF_HOST_PATH=""
    "$@"
  )
}

# 1. resolve_chroot_binary_path() finds binaries listed in $GITHUB_PATH
if resolved="$(run_case resolve_chroot_binary_path copilot)" && \
   [ "${resolved}" = "${CACHE_BIN}/copilot" ]; then
  pass "resolve_chroot_binary_path() resolves a binary via GITHUB_PATH entries"
else
  fail "resolve_chroot_binary_path() did not resolve copilot via GITHUB_PATH (got '${resolved:-}')"
fi

# 2. Unknown binaries are reported as not found
if run_case resolve_chroot_binary_path definitely-not-installed >/dev/null 2>&1; then
  fail "resolve_chroot_binary_path() should fail for a missing binary"
else
  pass "resolve_chroot_binary_path() fails for a missing binary"
fi

# 3. ensure_usr_local_bin_shims() creates the hardcoded path when it is missing
rm -f "${HOST_ROOT}/usr/local/bin/copilot"
(
  set -e
  # shellcheck disable=SC1090
  . "${FIXTURE_ENTRYPOINT}"
  GITHUB_PATH="${GITHUB_PATH_FILE}"
  AWF_HOST_PATH=""
  AWF_ENSURE_USR_LOCAL_BIN="copilot"
  ensure_usr_local_bin_shims
) > /dev/null
if [ -L "${HOST_ROOT}/usr/local/bin/copilot" ] && \
   [ "$(readlink "${HOST_ROOT}/usr/local/bin/copilot")" = "${CACHE_BIN}/copilot" ]; then
  pass "ensure_usr_local_bin_shims() creates /usr/local/bin/copilot pointing at the resolved binary"
else
  fail "ensure_usr_local_bin_shims() did not create the expected /usr/local/bin/copilot symlink"
fi

# 4. An existing /usr/local/bin entry is left untouched
rm -f "${HOST_ROOT}/usr/local/bin/copilot"
printf '#!/bin/sh\necho real\n' > "${HOST_ROOT}/usr/local/bin/copilot"
chmod +x "${HOST_ROOT}/usr/local/bin/copilot"
(
  set -e
  # shellcheck disable=SC1090
  . "${FIXTURE_ENTRYPOINT}"
  GITHUB_PATH="${GITHUB_PATH_FILE}"
  AWF_HOST_PATH=""
  AWF_ENSURE_USR_LOCAL_BIN="copilot"
  ensure_usr_local_bin_shims
) > /dev/null
if [ ! -L "${HOST_ROOT}/usr/local/bin/copilot" ] && \
   grep -q "echo real" "${HOST_ROOT}/usr/local/bin/copilot"; then
  pass "ensure_usr_local_bin_shims() leaves an existing /usr/local/bin entry untouched"
else
  fail "ensure_usr_local_bin_shims() overwrote an existing /usr/local/bin entry"
fi

# 5. Unsafe names are rejected without creating anything
rm -f "${HOST_ROOT}/usr/local/bin/copilot"
UNSAFE_OUTPUT="$(
  # shellcheck disable=SC1090
  . "${FIXTURE_ENTRYPOINT}"
  GITHUB_PATH="${GITHUB_PATH_FILE}"
  AWF_HOST_PATH=""
  AWF_ENSURE_USR_LOCAL_BIN="../evil"
  ensure_usr_local_bin_shims
)"
if printf '%s' "${UNSAFE_OUTPUT}" | grep -q "Ignoring invalid AWF_ENSURE_USR_LOCAL_BIN entry" && \
   [ ! -e "${HOST_ROOT}/usr/local/evil" ]; then
  pass "ensure_usr_local_bin_shims() rejects unsafe binary names"
else
  fail "ensure_usr_local_bin_shims() did not reject an unsafe binary name"
fi

# 6. No-op when AWF_ENSURE_USR_LOCAL_BIN is unset
(
  set -e
  # shellcheck disable=SC1090
  . "${FIXTURE_ENTRYPOINT}"
  GITHUB_PATH="${GITHUB_PATH_FILE}"
  AWF_HOST_PATH=""
  unset AWF_ENSURE_USR_LOCAL_BIN
  ensure_usr_local_bin_shims
) > /dev/null
if [ ! -e "${HOST_ROOT}/usr/local/bin/copilot" ]; then
  pass "ensure_usr_local_bin_shims() is a no-op when AWF_ENSURE_USR_LOCAL_BIN is unset"
else
  fail "ensure_usr_local_bin_shims() created a shim without AWF_ENSURE_USR_LOCAL_BIN"
fi

# 7. The overlay farm mirrors hidden entries as well (a plain * glob would drop
#    them, silently removing them from /usr/local/bin once the overlay mounts)
rm -f "${HOST_ROOT}/usr/local/bin/copilot"
printf '#!/bin/sh\necho plain\n' > "${HOST_ROOT}/usr/local/bin/plain-tool"
printf '#!/bin/sh\necho hidden\n' > "${HOST_ROOT}/usr/local/bin/.hidden-tool"
FARM_DIR="/tmp/awf-usr-local-bin-farm"
ORIG_DIR="/tmp/awf-usr-local-bin-orig"
mkdir -p "${HOST_ROOT}${FARM_DIR}" "${HOST_ROOT}${ORIG_DIR}"
(
  set -e
  # shellcheck disable=SC1090
  . "${FIXTURE_ENTRYPOINT}"
  USR_LOCAL_BIN_OVERLAY_DIR="${FARM_DIR}"
  USR_LOCAL_BIN_ORIG_DIR="${ORIG_DIR}"
  populate_usr_local_bin_farm
) > /dev/null
if [ "$(readlink "${HOST_ROOT}${FARM_DIR}/plain-tool")" = "${ORIG_DIR}/plain-tool" ] && \
   [ "$(readlink "${HOST_ROOT}${FARM_DIR}/.hidden-tool")" = "${ORIG_DIR}/.hidden-tool" ]; then
  pass "populate_usr_local_bin_farm() mirrors hidden and regular /usr/local/bin entries"
else
  fail "populate_usr_local_bin_farm() dropped a hidden /usr/local/bin entry"
fi

# 8. The overlay teardown removes the staged symlinks and both staging dirs
(
  # shellcheck disable=SC1090
  . "${FIXTURE_ENTRYPOINT}"
  USR_LOCAL_BIN_OVERLAY_DIR="${FARM_DIR}"
  USR_LOCAL_BIN_ORIG_DIR="${ORIG_DIR}"
  USR_LOCAL_BIN_OVERLAY_READY=1
  USR_LOCAL_BIN_OVERLAY_MOUNTED=0
  cleanup_usr_local_bin_overlay
) > /dev/null 2>&1
if [ ! -e "${HOST_ROOT}${FARM_DIR}" ] && [ ! -e "${HOST_ROOT}${ORIG_DIR}" ]; then
  pass "cleanup_usr_local_bin_overlay() removes the staged symlinks and staging directories"
else
  fail "cleanup_usr_local_bin_overlay() left staging directories behind"
fi

# 9. The teardown is a no-op when no overlay was staged
mkdir -p "${HOST_ROOT}${FARM_DIR}"
(
  # shellcheck disable=SC1090
  . "${FIXTURE_ENTRYPOINT}"
  USR_LOCAL_BIN_OVERLAY_DIR="${FARM_DIR}"
  USR_LOCAL_BIN_ORIG_DIR="${ORIG_DIR}"
  USR_LOCAL_BIN_OVERLAY_READY=0
  cleanup_usr_local_bin_overlay
) > /dev/null 2>&1
if [ -d "${HOST_ROOT}${FARM_DIR}" ]; then
  pass "cleanup_usr_local_bin_overlay() is a no-op when no overlay was staged"
else
  fail "cleanup_usr_local_bin_overlay() ran without a staged overlay"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
