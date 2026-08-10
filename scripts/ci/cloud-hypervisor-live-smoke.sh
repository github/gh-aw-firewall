#!/usr/bin/env bash
set -euo pipefail

# Live GitHub-hosted Ubuntu x86_64 KVM smoke/security suite for the Cloud
# Hypervisor preview backend.
#
# This reproduces the same 13-case behavioral/security contract as
# scripts/ci/firecracker-live-smoke.sh (allowed/blocked domains, direct
# egress, arbitrary TCP, DNS, metadata IP, mandatory API-proxy reflect with
# secret-sentinel absence, workspace copy-back incl. symlinks/permissions,
# exit-code propagation, timeout, SIGTERM cancellation, partial-start
# rollback, keep/preserve diagnostics), then adds Cloud Hypervisor-specific
# live checks that have no Firecracker/jailer equivalent:
#
#   - device-assumptions: confirms the guest-visible eth0/{/dev/vda,/dev/vdb}
#     layout documented in docs/cloud-hypervisor-foundation.md Part 6 holds.
#   - security-assertions: while a run is live, inspects the host-visible
#     Cloud Hypervisor process and its own vm.info response to confirm the
#     launcher's jailer-replacement boundary (netns join, non-root identity,
#     empty capability set, no_new_privs, active seccomp filter, per-run
#     cgroup membership/limits, landlock_enable reflected in vm.create, and
#     an exactly-minimal disk/net/vsock device set with no path to the
#     host-only API socket) — see src/cloud-hypervisor/launcher.ts.
#
# NOTE on shared namespace/interface naming: src/microvm/network.ts is
# VMM-neutral and used unmodified by both the Firecracker and Cloud
# Hypervisor backends (see docs/cloud-hypervisor-foundation.md Part 2), so
# the network namespace (`awffc-*`) and veth/TAP (`fch*`/`fcn*`/`fct*`)
# naming below is intentionally identical to Firecracker's, not a defect.
# The cgroup path (`awf-cloud-hypervisor/<runId>`) and process name
# (`cloud-hypervisor`) residue checks below ARE Cloud Hypervisor-specific.

ARTIFACT_DIR=${1:?usage: cloud-hypervisor-live-smoke.sh ARTIFACT_DIR}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
RUN_ROOT=${RUNNER_TEMP:-/tmp}/awf-cloud-hypervisor-live
SECRET_SENTINEL=awf-cloud-hypervisor-real-secret-do-not-expose
CGROUP_ROOT=/sys/fs/cgroup/awf-cloud-hypervisor
# Generous, non-flaky ceilings for regression detection on shared
# GitHub-hosted runners (see task Part 4: "measured but non-flaky").
BOOT_READINESS_CEILING_MS=90000
CLEANUP_CEILING_MS=20000

ARTIFACT_DIR=$(cd "$ARTIFACT_DIR" && pwd)
rm -rf "$RUN_ROOT"
mkdir -p "$RUN_ROOT"

digest() {
  awk -v file="$1" '$2 == file { print $1; exit }' "$ARTIFACT_DIR/SHA256SUMS"
}

COMMON=(
  --container-runtime cloud-hypervisor
  --cloud-hypervisor-preview
  --cloud-hypervisor-binary "$ARTIFACT_DIR/cloud-hypervisor"
  --cloud-hypervisor-kernel "$ARTIFACT_DIR/vmlinux.bin"
  --cloud-hypervisor-rootfs "$ARTIFACT_DIR/rootfs.ext4"
  --cloud-hypervisor-supervisor "$ARTIFACT_DIR/awf-supervisor"
  --cloud-hypervisor-binary-sha256 "$(digest cloud-hypervisor)"
  --cloud-hypervisor-kernel-sha256 "$(digest vmlinux.bin)"
  --cloud-hypervisor-rootfs-sha256 "$(digest rootfs.ext4)"
  --cloud-hypervisor-supervisor-sha256 "$(digest awf-supervisor)"
  --allow-domains example.com
  --skip-pull
  --diagnostic-logs
)

assert_no_residue() {
  if sudo ip netns list | grep -q '^awffc-'; then
    sudo ip netns list >&2
    echo "Cloud Hypervisor network namespace residue detected" >&2
    return 1
  fi
  if sudo ip -o link show | grep -Eq ' (fch|fcn|fct)[0-9a-f]{12}[:@]'; then
    sudo ip -o link show >&2
    echo "Cloud Hypervisor veth/TAP residue detected" >&2
    return 1
  fi
  if [ -d "$CGROUP_ROOT" ] && [ -n "$(sudo find "$CGROUP_ROOT" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
    sudo find "$CGROUP_ROOT" -mindepth 1 -maxdepth 1 >&2
    echo "Cloud Hypervisor cgroup residue detected" >&2
    return 1
  fi
  if pgrep -f 'cloud-hypervisor --api-socket' >/dev/null 2>&1; then
    pgrep -af 'cloud-hypervisor --api-socket' >&2
    echo "Cloud Hypervisor process residue detected" >&2
    return 1
  fi
  if sudo find /tmp -maxdepth 4 -type d -name 'cloud-hypervisor-run' 2>/dev/null \
    | xargs -r -I{} sudo find {} -mindepth 1 -maxdepth 3 -print 2>/dev/null \
    | grep -q .; then
    echo "Cloud Hypervisor run-directory residue detected" >&2
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

boot_start_ns=$(date +%s%N)
run_case allowed-https 0 \
  'wget -qO- https://example.com | grep -q "Example Domain"'
boot_end_ns=$(date +%s%N)
boot_ms=$(( (boot_end_ns - boot_start_ns) / 1000000 ))
echo "Cloud Hypervisor boot+readiness+run+cleanup baseline: ${boot_ms}ms"
if [ "$boot_ms" -gt "$BOOT_READINESS_CEILING_MS" ]; then
  echo "boot-readiness: exceeded ${BOOT_READINESS_CEILING_MS}ms ceiling (took ${boot_ms}ms)" >&2
  exit 1
fi

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
  'wget -qO /tmp/reflect http://172.30.0.30:10000/reflect && grep -q "providers" /tmp/reflect && ! env | grep -F "awf-cloud-hypervisor-real-secret-do-not-expose"'

run_case workspace-copyback 0 \
  'printf changed > .hidden && mkdir -p bin && printf "#!/bin/sh\necho ok\n" > bin/run && chmod 755 bin/run && ln -s bin/run run-link'
test "$(cat "$RUN_ROOT/workspace-copyback/workspace/.hidden")" = changed
test -x "$RUN_ROOT/workspace-copyback/workspace/bin/run"
test "$(readlink "$RUN_ROOT/workspace-copyback/workspace/run-link")" = bin/run

run_case exit-code 37 'exit 37'
run_case timeout-124 124 'sleep 90' --agent-timeout 1

# Cloud Hypervisor-specific guest device-topology assumptions (Part 6 of
# docs/cloud-hypervisor-foundation.md): PCI-attached rootfs/workspace disks
# surface as /dev/vda and /dev/vdb, and the single virtio-net device is
# deterministically named eth0.
run_case device-assumptions 0 \
  'test -b /dev/vda && test -b /dev/vdb && ip link show eth0 | grep -q eth0'

corrupt="$RUN_ROOT/corrupt-rootfs.ext4"
printf 'not-an-ext4-image\n' >"$corrupt"
corrupt_digest=$(sha256sum "$corrupt" | awk '{print $1}')
run_case partial-start-cleanup 1 'true' \
  --cloud-hypervisor-rootfs "$corrupt" \
  --cloud-hypervisor-rootfs-sha256 "$corrupt_digest" \
  --cloud-hypervisor-api-timeout-ms 3000

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
cleanup_start_ns=$(date +%s%N)
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
cleanup_end_ns=$(date +%s%N)
cleanup_ms=$(( (cleanup_end_ns - cleanup_start_ns) / 1000000 ))
echo "Cloud Hypervisor SIGTERM-to-clean-residue duration: ${cleanup_ms}ms"
if [ "$cleanup_ms" -gt "$CLEANUP_CEILING_MS" ]; then
  echo "cancellation: cleanup exceeded ${CLEANUP_CEILING_MS}ms ceiling (took ${cleanup_ms}ms)" >&2
  exit 1
fi

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
test -d "$keep_work/cloud-hypervisor-run"
test -f "$keep_audit/cloud-hypervisor/network-plan.json"
test -f "$keep_audit/cloud-hypervisor/cloud-hypervisor.log"
find "$keep_audit/cloud-hypervisor" -type f -size +1048576c -print -quit \
  | grep -q . && {
    echo "Cloud Hypervisor diagnostic artifact exceeded the 1 MiB bound" >&2
    exit 1
  }

while read -r namespace _; do
  case "$namespace" in
    awffc-*) sudo ip netns delete "$namespace" ;;
  esac
done < <(sudo ip netns list)
sudo docker compose -f "$keep_work/docker-compose.yml" down --volumes --remove-orphans
assert_no_residue

# --- Cloud Hypervisor-specific live security assertions -------------------
#
# Reproduces the launcher's jailer-replacement boundary live, while a run is
# in flight: netns-join + non-root privilege drop + empty capability set +
# no_new_privs + active seccomp filter + per-run cgroup membership/limits +
# landlock_enable reflected in vm.create + an exactly-minimal disk/net/vsock
# device set (see src/cloud-hypervisor/launcher.ts and manager.ts).
sec_work="$RUN_ROOT/security/work"
sec_workspace="$RUN_ROOT/security/workspace"
sec_audit="$RUN_ROOT/security/audit"
mkdir -p "$sec_work" "$sec_workspace" "$sec_audit"
(
  export GITHUB_WORKSPACE="$sec_workspace"
  export OPENAI_API_KEY="$SECRET_SENTINEL"
  exec sudo -E node "$ROOT/dist/cli.js" \
    "${COMMON[@]}" \
    --work-dir "$sec_work" \
    --audit-dir "$sec_audit" \
    -- 'sleep 25'
) >"$RUN_ROOT/security/stdout.log" 2>"$RUN_ROOT/security/stderr.log" &
sec_pid=$!

api_socket=""
for _ in $(seq 1 60); do
  api_socket=$(sudo find "$sec_work/cloud-hypervisor-run" -name api.socket 2>/dev/null | head -1)
  [ -n "$api_socket" ] && break
  sleep 1
done
if [ -z "$api_socket" ]; then
  echo "security-assertions: Cloud Hypervisor API socket never appeared" >&2
  kill -TERM "$sec_pid" 2>/dev/null || true
  wait "$sec_pid" 2>/dev/null || true
  exit 1
fi
run_directory=$(dirname "$api_socket")
run_id=$(basename "$run_directory")
# Cgroup root matches whichever hierarchy preflight detected (GitHub-hosted
# Ubuntu runners use cgroup v2 exclusively per docs/cloud-hypervisor-foundation.md
# Part 6, but this is discovered rather than assumed for robustness).
if sudo test -d "$CGROUP_ROOT/$run_id"; then
  cgroup_path="$CGROUP_ROOT/$run_id"
elif sudo test -d "/sys/fs/cgroup/memory/awf-cloud-hypervisor/$run_id"; then
  cgroup_path="/sys/fs/cgroup/memory/awf-cloud-hypervisor/$run_id"
else
  cgroup_path="$CGROUP_ROOT/$run_id"
fi

fail_security() {
  echo "security-assertions: $*" >&2
  kill -TERM "$sec_pid" 2>/dev/null || true
  wait "$sec_pid" 2>/dev/null || true
  exit 1
}

vmm_pid=""
for _ in $(seq 1 30); do
  vmm_pid=$(sudo cat "$cgroup_path/cgroup.procs" 2>/dev/null | head -1)
  [ -n "$vmm_pid" ] && break
  sleep 1
done
[ -n "$vmm_pid" ] || fail_security "no Cloud Hypervisor PID found in $cgroup_path/cgroup.procs"

# Non-root process identity.
proc_uid=$(sudo stat -c %u "/proc/$vmm_pid" 2>/dev/null || echo "")
[ -n "$proc_uid" ] || fail_security "could not stat /proc/$vmm_pid"
[ "$proc_uid" != "0" ] || fail_security "Cloud Hypervisor process is running as root"

# Empty effective capability set (setpriv --inh-caps=-all --bounding-set=-all).
cap_eff=$(sudo awk '/^CapEff:/{print $2}' "/proc/$vmm_pid/status" 2>/dev/null || echo "")
[ "$cap_eff" = "0000000000000000" ] \
  || fail_security "process retains effective capabilities: ${cap_eff:-unknown}"

# no_new_privs set (setpriv --no-new-privs).
no_new_privs=$(sudo awk '/^NoNewPrivs:/{print $2}' "/proc/$vmm_pid/status" 2>/dev/null || echo "")
[ "$no_new_privs" = "1" ] || fail_security "no_new_privs is not set (got ${no_new_privs:-unknown})"

# Seccomp filter active (Cloud Hypervisor's own --seccomp true; mode 2 = filter).
seccomp_mode=$(sudo awk '/^Seccomp:/{print $2}' "/proc/$vmm_pid/status" 2>/dev/null || echo "")
[ "$seccomp_mode" = "2" ] || fail_security "seccomp filter is not active (mode=${seccomp_mode:-unknown})"

# Per-run cgroup membership and non-trivial, bounded limits.
sudo test -f "$cgroup_path/cgroup.procs" || fail_security "cgroup.procs missing at $cgroup_path"
if sudo test -f "$cgroup_path/memory.max"; then
  memory_max=$(sudo cat "$cgroup_path/memory.max")
  case "$memory_max" in
    ''|*[!0-9]*) fail_security "memory.max is not a bounded numeric value: $memory_max" ;;
  esac
  memory_current=$(sudo cat "$cgroup_path/memory.current" 2>/dev/null || echo 0)
  case "$memory_current" in
    ''|*[!0-9]*) fail_security "memory.current is not numeric: $memory_current" ;;
  esac
  [ "$memory_current" -gt 0 ] || fail_security "memory.current reports zero usage; cgroup accounting looks inactive"
  [ "$memory_current" -le "$memory_max" ] || fail_security "memory.current ($memory_current) exceeds memory.max ($memory_max)"
elif sudo test -f "$cgroup_path/memory.limit_in_bytes"; then
  memory_max=$(sudo cat "$cgroup_path/memory.limit_in_bytes")
  case "$memory_max" in
    ''|*[!0-9]*) fail_security "memory.limit_in_bytes is not a bounded numeric value: $memory_max" ;;
  esac
else
  fail_security "no memory limit file found under $cgroup_path (neither cgroup v2 nor v1)"
fi

# vm.info reflects landlock_enable and an exactly-minimal, expected device
# topology (rootfs+workspace disks, single net device, vsock) — proving the
# host-only API socket is never exposed to the guest as any device.
vm_info=$(sudo curl --silent --show-error --max-time 5 --unix-socket "$api_socket" \
  http://localhost/api/v1/vm.info) || fail_security "vm.info request failed"
node -e '
  const info = JSON.parse(process.argv[1]);
  const config = info.config || {};
  if (config.landlock_enable !== true) {
    throw new Error("landlock_enable is not true in vm.info: " + JSON.stringify(config.landlock_enable));
  }
  const disks = config.disks || [];
  if (disks.length !== 2) {
    throw new Error("expected exactly 2 disks (rootfs, workspace), got " + disks.length);
  }
  const net = config.net || [];
  if (net.length !== 1) {
    throw new Error("expected exactly 1 net device, got " + net.length);
  }
  if (!config.vsock || typeof config.vsock.cid !== "number") {
    throw new Error("expected a vsock device with a numeric cid");
  }
  for (const disk of disks) {
    if (disk.path && disk.path.endsWith("api.socket")) {
      throw new Error("API socket path is exposed as a guest disk");
    }
  }
' "$vm_info" || fail_security "vm.info device-topology assertion failed: $vm_info"

kill -TERM "$sec_pid"
set +e
wait "$sec_pid"
sec_status=$?
set -e
[ "$sec_status" -eq 143 ] || {
  echo "security-assertions: expected exit 143 after cancellation, got $sec_status" >&2
  exit 1
}
assert_no_residue

echo "Cloud Hypervisor live smoke/security suite passed."
