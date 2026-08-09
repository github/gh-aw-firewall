#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${1:?usage: firecracker-live-smoke.sh ARTIFACT_DIR}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
RUN_ROOT=${RUNNER_TEMP:-/tmp}/awf-firecracker-live
SECRET_SENTINEL=awf-firecracker-real-secret-do-not-expose

ARTIFACT_DIR=$(cd "$ARTIFACT_DIR" && pwd)
rm -rf "$RUN_ROOT"
mkdir -p "$RUN_ROOT"

digest() {
  awk -v file="$1" '$2 == file { print $1; exit }' "$ARTIFACT_DIR/SHA256SUMS"
}

COMMON=(
  --container-runtime firecracker
  --firecracker-preview
  --firecracker-binary "$ARTIFACT_DIR/firecracker"
  --firecracker-jailer-binary "$ARTIFACT_DIR/jailer"
  --firecracker-kernel "$ARTIFACT_DIR/vmlinux.bin"
  --firecracker-rootfs "$ARTIFACT_DIR/rootfs.ext4"
  --firecracker-supervisor "$ARTIFACT_DIR/awf-firecracker-supervisor"
  --firecracker-binary-sha256 "$(digest firecracker)"
  --firecracker-jailer-sha256 "$(digest jailer)"
  --firecracker-kernel-sha256 "$(digest vmlinux.bin)"
  --firecracker-rootfs-sha256 "$(digest rootfs.ext4)"
  --firecracker-supervisor-sha256 "$(digest awf-firecracker-supervisor)"
  --allow-domains example.com
  --skip-pull
  --diagnostic-logs
)

assert_no_residue() {
  if sudo ip netns list | grep -q '^awffc-'; then
    sudo ip netns list >&2
    echo "Firecracker network namespace residue detected" >&2
    return 1
  fi
  if sudo ip -o link show | grep -Eq ' (fch|fcn|fct)[0-9a-f]{12}[:@]'; then
    sudo ip -o link show >&2
    echo "Firecracker veth/TAP residue detected" >&2
    return 1
  fi
}

run_case() {
  local name=$1
  local expected=$2
  local command=$3
  shift 3
  local work="$RUN_ROOT/$name/work"
  local workspace="$RUN_ROOT/$name/workspace"
  local audit="$RUN_ROOT/$name/audit"
  local proxy_logs="$RUN_ROOT/$name/proxy-logs"
  mkdir -p "$work" "$workspace" "$audit" "$proxy_logs"
  printf 'host-input\n' >"$workspace/input.txt"

  set +e
  (
    export GITHUB_WORKSPACE="$workspace"
    export OPENAI_API_KEY="$SECRET_SENTINEL"
    sudo -E node "$ROOT/dist/cli.js" \
      "${COMMON[@]}" \
      --work-dir "$work" \
      --audit-dir "$audit" \
      --proxy-logs-dir "$proxy_logs" \
      "$@" \
      -- "$command"
  ) >"$RUN_ROOT/$name/stdout.log" 2>"$RUN_ROOT/$name/stderr.log"
  local status=$?
  set -e

  if [ "$status" -ne "$expected" ]; then
    echo "case $name: expected exit $expected, got $status" >&2
    tail -200 "$RUN_ROOT/$name/stderr.log" >&2
    return 1
  fi
  if grep -R --binary-files=without-match -F "$SECRET_SENTINEL" \
    "$RUN_ROOT/$name/stdout.log" \
    "$audit" \
    "$proxy_logs" >/dev/null 2>&1; then
    echo "case $name: secret sentinel leaked into guest-visible or diagnostic output" >&2
    return 1
  fi
  assert_no_residue
}

assert_no_residue

run_case allowed-https 0 \
  'wget -qO- https://example.com | grep -q "Example Domain"'
run_case blocked-domain 0 \
  '! wget -qO- https://github.com'
run_case direct-egress 0 \
  'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; ! wget -qO- https://example.com'
run_case arbitrary-tcp 0 \
  '! nc -z -w 3 1.1.1.1 443'
run_case dns-denial 0 \
  '! nslookup example.com 8.8.8.8'
run_case metadata-denial 0 \
  'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; ! wget -T 3 -qO- http://169.254.169.254/latest/meta-data/'
run_case api-proxy-reflect 0 \
  'wget -qO /tmp/reflect http://172.30.0.30:10000/reflect && grep -q "providers" /tmp/reflect && ! env | grep -F "awf-firecracker-real-secret-do-not-expose"'

run_case workspace-copyback 0 \
  'printf changed > .hidden && mkdir -p bin && printf "#!/bin/sh\necho ok\n" > bin/run && chmod 755 bin/run && ln -s bin/run run-link'
test "$(cat "$RUN_ROOT/workspace-copyback/workspace/.hidden")" = changed
test -x "$RUN_ROOT/workspace-copyback/workspace/bin/run"
test "$(readlink "$RUN_ROOT/workspace-copyback/workspace/run-link")" = bin/run

run_case exit-code 37 'exit 37'
run_case timeout-124 124 'sleep 90' --agent-timeout 1

corrupt="$RUN_ROOT/corrupt-rootfs.ext4"
printf 'not-an-ext4-image\n' >"$corrupt"
corrupt_digest=$(sha256sum "$corrupt" | awk '{print $1}')
run_case partial-start-cleanup 1 'true' \
  --firecracker-rootfs "$corrupt" \
  --firecracker-rootfs-sha256 "$corrupt_digest" \
  --firecracker-api-timeout-ms 3000

cancel_work="$RUN_ROOT/cancellation/work"
cancel_workspace="$RUN_ROOT/cancellation/workspace"
cancel_audit="$RUN_ROOT/cancellation/audit"
mkdir -p "$cancel_work" "$cancel_workspace" "$cancel_audit"
(
  export GITHUB_WORKSPACE="$cancel_workspace"
  export OPENAI_API_KEY="$SECRET_SENTINEL"
  exec sudo -E node "$ROOT/dist/cli.js" \
    "${COMMON[@]}" \
    --work-dir "$cancel_work" \
    --audit-dir "$cancel_audit" \
    -- 'sleep 300'
) >"$RUN_ROOT/cancellation/stdout.log" 2>"$RUN_ROOT/cancellation/stderr.log" &
cancel_pid=$!
for _ in $(seq 1 60); do
  sudo ip netns list | grep -q '^awffc-' && break
  sleep 1
done
kill -TERM "$cancel_pid"
set +e
wait "$cancel_pid"
cancel_status=$?
set -e
[ "$cancel_status" -eq 143 ] || {
  echo "cancellation: expected exit 143, got $cancel_status" >&2
  exit 1
}
assert_no_residue

keep_work="$RUN_ROOT/keep/work"
keep_workspace="$RUN_ROOT/keep/workspace"
keep_audit="$RUN_ROOT/keep/audit"
mkdir -p "$keep_work" "$keep_workspace" "$keep_audit"
(
  export GITHUB_WORKSPACE="$keep_workspace"
  export OPENAI_API_KEY="$SECRET_SENTINEL"
  sudo -E node "$ROOT/dist/cli.js" \
    "${COMMON[@]}" \
    --keep-containers \
    --work-dir "$keep_work" \
    --audit-dir "$keep_audit" \
    -- 'true'
) >"$RUN_ROOT/keep/stdout.log" 2>"$RUN_ROOT/keep/stderr.log"
sudo ip netns list | grep -q '^awffc-' || {
  echo "keep mode did not preserve the run network namespace" >&2
  exit 1
}
test -d "$keep_work/firecracker-jailer"
test -f "$keep_audit/firecracker/network-plan.json"
test -f "$keep_audit/firecracker/firecracker.log"
test -f "$keep_audit/firecracker/firecracker.metrics.jsonl"
find "$keep_audit/firecracker" -type f -size +1048576c -print -quit \
  | grep -q . && {
    echo "Firecracker diagnostic artifact exceeded the 1 MiB bound" >&2
    exit 1
  }

while read -r namespace _; do
  case "$namespace" in
    awffc-*) sudo ip netns delete "$namespace" ;;
  esac
done < <(sudo ip netns list)
sudo docker compose -f "$keep_work/docker-compose.yml" down --volumes --remove-orphans
assert_no_residue

echo "Firecracker live smoke/security suite passed."
