#!/bin/bash
# Unit test for chroot fallback PATH ordering (containers/agent/entrypoint.sh)
#
# Validates that when AWF_HOST_PATH is unset (fallback branch):
#   1. $GITHUB_PATH entries are prepended with highest priority.
#   2. hostedtoolcache bins are appended (not prepended), so they never
#      override an explicit setup-* version selection.
#   3. CRLF line endings in the GITHUB_PATH file are handled correctly.

set -e

PASS=0
FAIL=0

pass() { echo "✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "❌ FAIL: $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Extract the heredoc PATH-building logic from entrypoint.sh and run it in a
# temporary sub-shell with a synthetic hostedtoolcache and GITHUB_PATH file.
# ---------------------------------------------------------------------------

# Locate the lines of the heredoc content (between the AWFEOF markers in the
# else branch).  We pull only the lines between "Constructing default PATH"
# comment and the closing AWFEOF.
ENTRYPOINT="$(dirname "$0")/../containers/agent/entrypoint.sh"

if [ ! -f "${ENTRYPOINT}" ]; then
  echo "❌ Cannot find entrypoint.sh at ${ENTRYPOINT}"
  exit 1
fi

# Create a temporary directory for the test fixtures
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

# Build a fake hostedtoolcache with two Ruby versions
TOOLCACHE="${TMPDIR_TEST}/opt/hostedtoolcache"
mkdir -p "${TOOLCACHE}/Ruby/3.1.0/x64/bin"
mkdir -p "${TOOLCACHE}/Ruby/3.3.0/x64/bin"
# Create stub "ruby" binaries that print their version
printf '#!/bin/sh\necho "ruby 3.1.0"\n' > "${TOOLCACHE}/Ruby/3.1.0/x64/bin/ruby"
printf '#!/bin/sh\necho "ruby 3.3.0"\n' > "${TOOLCACHE}/Ruby/3.3.0/x64/bin/ruby"
chmod +x "${TOOLCACHE}/Ruby/3.1.0/x64/bin/ruby"
chmod +x "${TOOLCACHE}/Ruby/3.3.0/x64/bin/ruby"

# Build a fake self-hosted runner toolcache with a Node.js version
RUNNER_TOOLCACHE="${TMPDIR_TEST}/home/runner/work/_tool"
mkdir -p "${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin"
printf '#!/bin/sh\necho "node 20.19.0"\n' > "${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin/node"
chmod +x "${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin/node"

# ---------------------------------------------------------------------------
# Helper: run the extracted PATH logic in a clean environment, then evaluate
# the resulting PATH with a provided test expression.
# ---------------------------------------------------------------------------
run_path_test() {
  local github_path_file="$1"   # path to the GITHUB_PATH file (or "" to skip)
  local base_path="$2"           # starting PATH value
  local check_expr="$3"          # bash expression to evaluate after PATH is set

  # Build the inline script from the relevant heredoc section of entrypoint.sh.
  # We replace the toolcache roots with fake test fixtures so the test is
  # self-contained and doesn't depend on the host runner layout.
  local script
  script="$(
    sed -n '/^# Prepend entries from \$GITHUB_PATH/,/^AWFEOF$/{ /^AWFEOF$/d; p; }' \
      "${ENTRYPOINT}" |
    sed \
      -e "s|/opt/hostedtoolcache|${TOOLCACHE}|g" \
      -e "s|\${HOME}/work/_tool|${RUNNER_TOOLCACHE}|g"
  )"

  # Run the script in a sub-shell with a clean environment
  (
    export PATH="${base_path}"
    [ -n "${github_path_file}" ] && export GITHUB_PATH="${github_path_file}"
    eval "${script}"
    eval "${check_expr}"
  )
}

# ---------------------------------------------------------------------------
# Test 1: GITHUB_PATH entry for Ruby 3.3 must precede the toolcache scan
# ---------------------------------------------------------------------------
GP_FILE="${TMPDIR_TEST}/github_path_test1"
printf '%s\n' "${TOOLCACHE}/Ruby/3.3.0/x64/bin" > "${GP_FILE}"

BASE_PATH="/usr/local/bin:/usr/bin:/bin"

if run_path_test "${GP_FILE}" "${BASE_PATH}" \
  "case \"\${PATH}\" in *\"${TOOLCACHE}/Ruby/3.3.0/x64/bin:\"*) exit 0;; *) exit 1;; esac"; then
  pass "GITHUB_PATH entry is prepended to PATH"
else
  fail "GITHUB_PATH entry is not prepended to PATH"
fi

# Test that 3.3.0 appears before 3.1.0 in PATH
if run_path_test "${GP_FILE}" "${BASE_PATH}" "
  pos33=\$(echo \"\${PATH}\" | tr ':' '\n' | grep -n '3.3.0' | cut -d: -f1 | head -1)
  pos31=\$(echo \"\${PATH}\" | tr ':' '\n' | grep -n '3.1.0' | cut -d: -f1 | head -1)
  [ -n \"\${pos33}\" ] && [ -n \"\${pos31}\" ] && [ \"\${pos33}\" -lt \"\${pos31}\" ]
"; then
  pass "setup-* version (3.3.0) precedes older toolcache version (3.1.0) in PATH"
else
  fail "setup-* version (3.3.0) does not precede older toolcache version (3.1.0) in PATH"
fi

# Test that the correct ruby is found first
if run_path_test "${GP_FILE}" "${BASE_PATH}" \
  '[ "$(ruby 2>/dev/null)" = "ruby 3.3.0" ]'; then
  pass "ruby resolves to setup-* selected version (3.3.0)"
else
  fail "ruby does not resolve to setup-* selected version (3.3.0)"
fi

# ---------------------------------------------------------------------------
# Test 2: Without GITHUB_PATH, toolcache bins are still appended (not prepend)
# ---------------------------------------------------------------------------
if run_path_test "" "${BASE_PATH}" "
  case \"\${PATH}\" in
    \"${TOOLCACHE}/Ruby\"*) exit 1;;   # toolcache prepended — wrong
    *) exit 0;;                         # toolcache appended or absent — ok
  esac
"; then
  pass "without GITHUB_PATH, toolcache bins are not prepended to PATH"
else
  fail "without GITHUB_PATH, toolcache bins were incorrectly prepended to PATH"
fi

# ---------------------------------------------------------------------------
# Test 3: CRLF entries in GITHUB_PATH file are stripped
# ---------------------------------------------------------------------------
GP_FILE_CRLF="${TMPDIR_TEST}/github_path_crlf"
printf '%s\r\n' "${TOOLCACHE}/Ruby/3.3.0/x64/bin" > "${GP_FILE_CRLF}"

if run_path_test "${GP_FILE_CRLF}" "${BASE_PATH}" "
  case \"\${PATH}\" in
    *$'\r'*) exit 1;;   # CR leaked into PATH — wrong
    *) exit 0;;
  esac
"; then
  pass "CRLF line endings in GITHUB_PATH are stripped correctly"
else
  fail "CRLF line endings in GITHUB_PATH leaked into PATH"
fi

# ---------------------------------------------------------------------------
# Test 4: Duplicate entries in GITHUB_PATH are not added twice by toolcache scan
# ---------------------------------------------------------------------------
GP_FILE_DUP="${TMPDIR_TEST}/github_path_dup"
printf '%s\n' "${TOOLCACHE}/Ruby/3.3.0/x64/bin" > "${GP_FILE_DUP}"

if run_path_test "${GP_FILE_DUP}" "${BASE_PATH}" "
  count=\$(echo \"\${PATH}\" | tr ':' '\n' | grep -c '3.3.0' || true)
  [ \"\${count}\" -eq 1 ]
"; then
  pass "toolcache scan does not duplicate a directory already in PATH from GITHUB_PATH"
else
  fail "toolcache scan duplicated a directory already in PATH from GITHUB_PATH"
fi

# ---------------------------------------------------------------------------
# Test 5: Self-hosted runner toolcache is scanned for fallback binaries
# ---------------------------------------------------------------------------
FALLBACK_BASE_PATH="/tmp/awf-empty-path"

if run_path_test "" "${FALLBACK_BASE_PATH}" "
  case \"\${PATH}\" in
    *\"${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin\"*) exit 0;;
    *) exit 1;;
  esac
"; then
  pass "self-hosted runner toolcache bins are appended to PATH"
else
  fail "self-hosted runner toolcache bins were not added to PATH"
fi

if run_path_test "" "${FALLBACK_BASE_PATH}" \
  '[ "$(command -v node 2>/dev/null)" = "${RUNNER_TOOLCACHE}/node/20.19.0/x64/bin/node" ]'; then
  pass "node resolves from self-hosted runner toolcache fallback"
else
  fail "node does not resolve from self-hosted runner toolcache fallback"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

[ "${FAIL}" -eq 0 ]
