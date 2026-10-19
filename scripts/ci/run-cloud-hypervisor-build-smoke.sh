#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd) || exit 1
RESULT_DIR=${1:-/tmp/gh-aw/agent}
mkdir -p "$RESULT_DIR" || exit 1
RESULT_DIR=$(cd "$RESULT_DIR" && pwd) || exit 1
RESULT_FILE="$RESULT_DIR/build-test-results.json"
JEST_RESULT_FILE="$RESULT_DIR/build-test-jest-results.json"
HTTP_CODE=000
NODE_BUILD_STATUS=FAIL
NODE_TEST_STATUS=FAIL
GO_BUILD_STATUS=FAIL
GO_TEST_STATUS=FAIL
NETWORK_ISOLATION_STATUS=FAIL

write_results() {
  local status=$1
  trap - EXIT
  if ! node - "$RESULT_FILE" "$HTTP_CODE" "$NODE_BUILD_STATUS" "$NODE_TEST_STATUS" \
    "$GO_BUILD_STATUS" "$GO_TEST_STATUS" "$NETWORK_ISOLATION_STATUS" <<'NODE'
const fs = require('node:fs');
const [file, http_code, node_build, node_test, go_build, go_test, network_isolation] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
  http_code, node_build, node_test, go_build, go_test, network_isolation,
}, null, 2) + '\n');
NODE
  then
    echo "Could not write Cloud Hypervisor build-test results" >&2
    exit 1
  fi
  cat "$RESULT_FILE"
  exit "$status"
}
trap 'write_results "$?"' EXIT

rm -f "$RESULT_FILE" "$JEST_RESULT_FILE" || exit 1

run_logged() {
  local name=$1
  shift
  "$@" >"$RESULT_DIR/build-test-$name.log" 2>&1
  local status=$?
  echo "===== $name (exit $status) ====="
  tail -n 20 "$RESULT_DIR/build-test-$name.log"
  return "$status"
}

cd "$REPO_ROOT" || exit 1
echo "Node: $(node --version 2>&1)"
echo "npm: $(npm --version 2>&1)"
echo "Go: $(go version 2>&1)"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com || true)
HTTP_CODE=${HTTP_CODE:-000}

run_logged npm-ci timeout 5m npm ci
NPM_CI_EXIT=$?
run_logged npm-build npm run build
NPM_BUILD_EXIT=$?
if [ "$NPM_CI_EXIT" -eq 0 ] && [ "$NPM_BUILD_EXIT" -eq 0 ]; then
  NODE_BUILD_STATUS=PASS
fi

if run_logged jest npx --no-install jest --ci --forceExit --maxWorkers=2 \
  --testPathPatterns='squid-config|docker-manager|logger' \
  --json "--outputFile=$JEST_RESULT_FILE"; then
  NODE_TEST_STATUS=PASS
fi

GO_TEST_DIR=$(mktemp -d "$RESULT_DIR/go-fixture.XXXXXX") || exit 1
if git init -q "$GO_TEST_DIR" &&
  git -C "$GO_TEST_DIR" remote add origin https://github.com/Mossaka/gh-aw-firewall-test-go.git &&
  run_logged go-fetch git -C "$GO_TEST_DIR" fetch --depth 1 origin c3e84fc697814119dba3b0ad82566dc2b2bbb880 &&
  run_logged go-checkout git -C "$GO_TEST_DIR" checkout --detach FETCH_HEAD; then
  GO_BUILD_STATUS=PASS
  GO_TEST_STATUS=PASS
  for module in color uuid; do
    if ! (
      cd "$GO_TEST_DIR/$module" &&
      run_logged "go-$module-download" go mod download &&
      run_logged "go-$module-build" go build ./...
    ); then
      GO_BUILD_STATUS=FAIL
    fi
    if ! (cd "$GO_TEST_DIR/$module" && run_logged "go-$module-test" go test ./...); then
      GO_TEST_STATUS=FAIL
    fi
  done
else
  GO_BUILD_STATUS=CLONE_FAILED
  GO_TEST_STATUS=SKIPPED
fi

BLOCKED_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://example.com 2>/dev/null || true)
BLOCKED_CODE=${BLOCKED_CODE:-000}
if [ "$BLOCKED_CODE" = 000 ] || [ "$BLOCKED_CODE" = 403 ]; then
  NETWORK_ISOLATION_STATUS=PASS
fi

if [ "$HTTP_CODE" = 200 ] &&
  [ "$NODE_BUILD_STATUS" = PASS ] && [ "$NODE_TEST_STATUS" = PASS ] &&
  [ "$GO_BUILD_STATUS" = PASS ] && [ "$GO_TEST_STATUS" = PASS ] &&
  [ "$NETWORK_ISOLATION_STATUS" = PASS ]; then
  write_results 0
fi
echo "Cloud Hypervisor build-test workload failed; see $RESULT_DIR/build-test-*.log" >&2
write_results 1
