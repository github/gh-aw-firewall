#!/bin/bash
set -euo pipefail

# The privileged outer daemon is restricted to this disposable hosted CI job.
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "$(uname -s)" = Linux
export AWF_LIVE_CHECKOUT="$PWD"
export AWF_LIVE_OUTPUT="$PWD/artifacts/harness-live/split-dind"
export AWF_LIVE_COMMIT
AWF_LIVE_COMMIT="$(git rev-parse HEAD)"
mkdir -p "$AWF_LIVE_OUTPUT"
project="awf-harness-$(cat /proc/sys/kernel/random/uuid)"
compose=(docker compose -p "$project" -f tests/fixtures/harness-observation/split-dind.compose.yml)
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  # Only this invocation's named project and its private volumes/network.
  if ! timeout 60s "${compose[@]}" down -v --timeout 5; then
    echo "Split-DinD cleanup failed" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Populate the runner view before the daemon mounts it read-only. In particular,
# the nested /runner/tmp mountpoint must already exist under that read-only root.
timeout 60s "${compose[@]}" run --rm --no-deps runner /bin/bash -euc \
  'test ! -e /staged/usr; cp -a /usr /bin /sbin /lib /lib64 /etc /staged/; mkdir -p /staged/tmp'
timeout 120s "${compose[@]}" up -d --wait daemon
docker image inspect --format '{{json .Id}}' awf-harness-runner:local >"$AWF_LIVE_OUTPUT/runner-image.json"
docker image inspect --format '{{json .Id}}' docker:28.5.1-dind >"$AWF_LIVE_OUTPUT/daemon-image.json"
# Load exactly the image built from this checkout, not a released AWF tag.
docker save awf-harness-agent:local | timeout 120s "${compose[@]}" exec -T daemon docker load
timeout --kill-after=20s 480s "${compose[@]}" run --rm runner
