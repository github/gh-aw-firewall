#!/usr/bin/env bash
set -euo pipefail

runtime=${1:?runtime is required}
workload=${2:?workload is required}
sample_id=${3:?sample id is required}
mode=${4:?execution mode is required}
cache_state=${5:?cache state is required}
resource_profile=${6:?resource profile is required}

: "${AWF_BENCHMARK_EVENTS:?AWF_BENCHMARK_EVENTS is required}"
: "${AWF_BENCHMARK_ASSERTIONS:?AWF_BENCHMARK_ASSERTIONS is required}"
: "${AWF_BENCHMARK_RESIDUE:?AWF_BENCHMARK_RESIDUE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"

evidence_dir=$(dirname "$AWF_BENCHMARK_EVENTS")

case "$runtime" in
  nvx|cloud-hypervisor) ;;
  *) echo "unsupported runtime: $runtime" >&2; exit 2 ;;
esac
case "$workload" in
  build-test|copilot-inference) ;;
  *) echo "unsupported workload: $workload" >&2; exit 2 ;;
esac
case "$mode" in
  sequential|concurrent) ;;
  *) echo "unsupported execution mode: $mode" >&2; exit 2 ;;
esac
case "$cache_state" in
  cold|warm) ;;
  *) echo "unsupported cache state: $cache_state" >&2; exit 2 ;;
esac
case "$resource_profile" in
  minimum)
    cpu_cores=1 memory_mib=2048 pids_max=128 scratch_mib=1024
    ;;
  default)
    cpu_cores=2 memory_mib=4096 pids_max=256 scratch_mib=2048
    ;;
  elevated)
    cpu_cores=4 memory_mib=6144 pids_max=512 scratch_mib=4096
    ;;
  *) echo "unsupported resource profile: $resource_profile" >&2; exit 2 ;;
esac
memory_bytes=$((memory_mib * 1024 * 1024))
readonly scratch_limit_bytes=$((scratch_mib * 1024 * 1024))
readonly nvx_host_pids_max=256

now_ms() {
  date +%s%3N
}

# shellcheck source=scripts/ci/nvx-phase4-runtime-checks.sh
source "$(dirname "${BASH_SOURCE[0]}")/nvx-phase4-runtime-checks.sh"

runtime_process_snapshot() {
  for name in openvmm virtiofsd; do
    sudo pgrep -a -x "$name" 2>/dev/null || true
  done
  sudo pgrep -af \
    '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[c]loud-hypervisor --api-socket' \
    2>/dev/null || true
}

runtime_storage_bytes() {
  local roots=()
  if [ "$runtime" = nvx ]; then
    roots=(
      /var/lib/awf-nvx/trusted-artifacts
      /var/lib/awf-nvx/runs
      /var/lib/awf-nvx/cleanup
    )
  else
    roots=(/run/awf-cloud-hypervisor /var/lib/awf-cloud-hypervisor/trusted-artifacts)
  fi
  { sudo du -sb "${roots[@]}" 2>/dev/null || true; } |
    awk '{sum += $1} END {print sum + 0}'
}

tune_campaign_cgroup() {
  local cgroup=$1
  printf '%s %s\n' "$((cpu_cores * 100000))" 100000 |
    sudo tee "$cgroup/cpu.max" >/dev/null
  if [ "$runtime" = cloud-hypervisor ]; then
    printf '%s\n' "$pids_max" | sudo tee "$cgroup/pids.max" >/dev/null
  fi
}

guest_resource_limits_match() {
  local expected_runtime=$1 expected_pids_max=$2
  shift 2
  jq -se --arg runtime "$expected_runtime" --argjson pidsMax "$expected_pids_max" '
    all(.[];
      .runtime == $runtime and
      .configuredPidsMax == $pidsMax and
      (if $runtime == "nvx" then
        .pidsMax == $pidsMax and .cgroupPidsMax == ($pidsMax + 1)
      else
        .pidsMax == null and .cgroupPidsMax == null
      end)
    )
  ' "$@" >/dev/null
}

campaign_resource_limits_enforced() {
  local execution_mode=$1
  local expected_memory_max=$2 expected_cpu_max=$3 expected_host_pids_max=$4
  local guest_limits=$5
  local observed_cgroup=$6 observed_memory_max=$7 observed_cpu_max=$8 observed_pids_max=$9
  local peer_guest_limits=${10} peer_cgroup=${11} peer_memory_max=${12}
  local peer_cpu_max=${13} peer_pids_max=${14}

  [ "$guest_limits" = true ] &&
    [ -n "$observed_cgroup" ] &&
    [ "$observed_memory_max" = "$expected_memory_max" ] &&
    [ "$observed_cpu_max" = "$expected_cpu_max" ] &&
    [ "$observed_pids_max" = "$expected_host_pids_max" ] ||
    return 1
  if [ "$execution_mode" = concurrent ]; then
    [ "$peer_guest_limits" = true ] &&
      [ -n "$peer_cgroup" ] &&
      [ "$peer_memory_max" = "$expected_memory_max" ] &&
      [ "$peer_cpu_max" = "$expected_cpu_max" ] &&
      [ "$peer_pids_max" = "$expected_host_pids_max" ] ||
      return 1
  fi
}

capture_runtime_identity() {
  sudo rm -f -- "$2"
  sudo node - "$runtime" "$1" "$2" <<'IDENTITY'
const fs = require("node:fs");
const path = require("node:path");
const [runtime, workDir, output] = process.argv.slice(2);
const root = runtime === "nvx" ? "/var/lib/awf-nvx/cleanup" : "/run/awf-cloud-hypervisor/pending-cleanup";
try {
  for (const name of fs.readdirSync(root).filter(name => name.endsWith(".json"))) {
    const record = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    const ownerArgs = fs.readFileSync(`/proc/${record.owner.pid}/cmdline`, "utf8").split("\0");
    const index = ownerArgs.indexOf("--work-dir");
    if (index < 0 || ownerArgs[index + 1] !== workDir) continue;
    const process = runtime === "nvx" ? record.resources.openvmm : record.processes.vmm?.identity;
    const cgroup = runtime === "nvx" ? record.resources.cgroup?.path : record.paths.cgroupPath;
    const runDirectory = runtime === "nvx" ? record.resources.runDirectory?.path : record.paths.runDirectory;
    if (!process || record.vmmIdentity?.state !== "live" || !cgroup || !runDirectory) continue;
    const procRoot = `/proc/${process.pid}`;
    const stat = fs.readFileSync(`${procRoot}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTime = fields[19];
    const uid = Number(fs.readFileSync(`${procRoot}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1]);
    const membership = fs.readFileSync(`${procRoot}/cgroup`, "utf8").trim();
    const networkNamespace = fs.readlinkSync(`${procRoot}/ns/net`);
    if (fields[0] === "Z" || startTime !== (process.startTimeTicks ?? process.startTime) ||
        uid !== record.vmmIdentity.uid || uid !== process.uid ||
        fs.readlinkSync(`${procRoot}/exe`) !== process.executable ||
        membership !== `0::${cgroup.slice("/sys/fs/cgroup".length)}` ||
        networkNamespace !== process.networkNamespace ||
        networkNamespace !== `net:[${fs.statSync(record.network.netnsPath).ino}]`) continue;
    const runStat = fs.statSync(runDirectory, { bigint: true });
    const cgroupStat = fs.statSync(cgroup, { bigint: true });
    const runIdentity = runtime === "nvx" ? record.resources.runDirectory : record.identities.runDirectory;
    const cgroupIdentity = runtime === "nvx" ? record.resources.cgroup : record.identities.cgroup;
    if (runStat.ino.toString() !== runIdentity.inode || runStat.dev.toString() !== runIdentity.device ||
        cgroupStat.ino.toString() !== cgroupIdentity.inode || cgroupStat.dev.toString() !== cgroupIdentity.device) continue;
    fs.writeFileSync(output, JSON.stringify({
      runId: record.runId, pid: process.pid, uid, account: record.vmmIdentity.name,
      runDirectory, cleanupRecord: path.join(root, name), cgroup, networkNamespace,
    }), { mode: 0o600 });
    break;
  }
} catch {
  // A launch may still be updating its durable record; the host retries.
}
IDENTITY
  if sudo test -f "$2"; then sudo chown "$(id -u):$(id -g)" "$2"; fi
}

sample_root="$RUNNER_TEMP/nvx-phase4-campaign/$sample_id"
work_dir="$sample_root/awf"
workspace_dir="$GITHUB_WORKSPACE/.nvx-phase4-campaign/$sample_id"
proxy_logs="$sample_root/api-proxy-logs"
guest_status="$workspace_dir/guest-status.json"
first_marker="$workspace_dir/first-work"
complete_marker="$workspace_dir/workload-complete"
awf_log="$sample_root/awf.log"
if [[ -e "$sample_root" || -e "$workspace_dir" ]]; then
  echo "sample paths already exist" >&2
  exit 1
fi
mkdir -p "$sample_root" "$work_dir" "$proxy_logs" "$workspace_dir"
chmod 0700 "$sample_root" "$work_dir" "$proxy_logs" "$workspace_dir"

preflight_started=$(now_ms)
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test -c /dev/kvm
test -f dist/cli.js
sudo sync
if [ "$cache_state" = cold ]; then
  sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'
else
  find dist scripts/ci -maxdepth 4 -type f -print0 |
    xargs -0 cat >/dev/null
  if [ "$runtime" = nvx ]; then
    cat "$NVX_OPENVMM" "$NVX_KERNEL" "$NVX_INITRAMFS" >/dev/null
  else
    cat "$GH_AW_CLOUD_HYPERVISOR_BINARY" \
      "$GH_AW_CLOUD_HYPERVISOR_KERNEL" \
      "$GH_AW_CLOUD_HYPERVISOR_ROOTFS" >/dev/null
  fi
fi

if [ -n "${AWF_PHASE4_KVM_RUNTIME_ACL_BASELINE:-}" ]; then
  kvm_acl_expected_source="$AWF_PHASE4_KVM_RUNTIME_ACL_BASELINE"
  kvm_acl_before=$(sudo cat "$AWF_PHASE4_KVM_RUNTIME_ACL_BASELINE")
else
  kvm_acl_expected_source=/dev/kvm
  kvm_acl_before=$(sudo getfacl --absolute-names --numeric /dev/kvm 2>/dev/null)
fi
kvm_acl_before_snapshot="$RUNNER_TEMP/nvx-phase4-kvm-acl-before-$sample_id.txt"
kvm_acl_after_snapshot="$RUNNER_TEMP/nvx-phase4-kvm-acl-after-$sample_id.txt"
printf '%s\n' "$kvm_acl_before" > "$kvm_acl_before_snapshot"
chmod 0600 "$kvm_acl_before_snapshot"
restore_kvm_acl() {
  sudo setfacl --restore="$kvm_acl_before_snapshot" >/dev/null 2>&1 || true
}
normalize_kvm_acl() {
  local acl=$1
  if grep -Eq '^(user|group):[^:]' <<<"$acl"; then
    printf '%s\n' "$acl"
  else
    grep -v '^mask::' <<<"$acl"
  fi
}
trap restore_kvm_acl EXIT
processes_before=$(runtime_process_snapshot)
cleanup_before=$(runtime_storage_snapshot "$runtime" cleanup)
runs_before=$(runtime_storage_snapshot "$runtime" run)
scratch_before=$(runtime_storage_snapshot "$runtime" scratch)
snapshots_before=$(runtime_storage_snapshot "$runtime" snapshot)
netns_before=$(sudo ip netns list 2>/dev/null || true)
cgroups_before=$(sudo find /sys/fs/cgroup -maxdepth 4 -type d \
  \( -path '/sys/fs/cgroup/awf-nvx*' -o \
     -path '/sys/fs/cgroup/awf-cloud-hypervisor*' \) \
  ! -path '/sys/fs/cgroup/awf-nvx' \
  ! -path '/sys/fs/cgroup/awf-cloud-hypervisor' -print 2>/dev/null | sort)
mounts_before=$(findmnt -rn -o TARGET 2>/dev/null | grep -E 'awf-(nvx|cloud-hypervisor)' || true)
runtime_storage_before=$(runtime_storage_bytes)

runtime_args=()
if [ "$runtime" = nvx ]; then
  : "${NVX_OPENVMM:?NVX_OPENVMM is required}"
  : "${NVX_KERNEL:?NVX_KERNEL is required}"
  : "${NVX_INITRAMFS:?NVX_INITRAMFS is required}"
  : "${NVX_LAYER:?NVX_LAYER is required}"
  : "${NVX_MANIFEST:?NVX_MANIFEST is required}"
  : "${NVX_MANIFEST_BUNDLE:?NVX_MANIFEST_BUNDLE is required}"
  for artifact in \
    "$NVX_OPENVMM" "$NVX_KERNEL" "$NVX_INITRAMFS" \
    "$NVX_MANIFEST" "$NVX_MANIFEST_BUNDLE"; do
    test -f "$artifact"
    test "$(stat -c %u "$artifact")" = 0
    test "$((8#$(stat -c %a "$artifact") & 8#022))" = 0
  done
  runtime_args=(
    --container-runtime nvx
    --nvx-preview
    --nvx-mount-policy workspace-only
    --nvx-layer "$NVX_LAYER"
    --nvx-openvmm "$NVX_OPENVMM"
    --nvx-kernel "$NVX_KERNEL"
    --nvx-initramfs "$NVX_INITRAMFS"
    --nvx-artifact-manifest "$NVX_MANIFEST"
    --nvx-artifact-manifest-bundle "$NVX_MANIFEST_BUNDLE"
    --nvx-signer-workflow github/gh-aw-firewall/.github/workflows/nvx-phase-4-benchmark.yml
    --nvx-memory-mib "$memory_mib"
    --nvx-memory-max-bytes "$memory_bytes"
    --nvx-pids-max "$pids_max"
    --nvx-scratch-bytes "$scratch_limit_bytes"
  )
else
  : "${GH_AW_CLOUD_HYPERVISOR_BINARY:?cloud-hypervisor binary is required}"
  : "${GH_AW_CLOUD_HYPERVISOR_KERNEL:?cloud-hypervisor kernel is required}"
  : "${GH_AW_CLOUD_HYPERVISOR_ROOTFS:?cloud-hypervisor rootfs is required}"
  : "${GH_AW_CLOUD_HYPERVISOR_SUPERVISOR:?cloud-hypervisor supervisor is required}"
  : "${GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST:?cloud-hypervisor manifest is required}"
  : "${GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST_BUNDLE:?cloud-hypervisor manifest bundle is required}"
  runtime_args=(
    --container-runtime cloud-hypervisor
    --cloud-hypervisor-preview
    --cloud-hypervisor-mount-policy workspace-only
    --cloud-hypervisor-binary "$GH_AW_CLOUD_HYPERVISOR_BINARY"
    --cloud-hypervisor-kernel "$GH_AW_CLOUD_HYPERVISOR_KERNEL"
    --cloud-hypervisor-rootfs "$GH_AW_CLOUD_HYPERVISOR_ROOTFS"
    --cloud-hypervisor-supervisor "$GH_AW_CLOUD_HYPERVISOR_SUPERVISOR"
    --cloud-hypervisor-artifact-manifest "$GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST"
    --cloud-hypervisor-artifact-manifest-bundle "$GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST_BUNDLE"
    --cloud-hypervisor-artifact-release-tag v0.28.54
    --cloud-hypervisor-vcpus "$cpu_cores"
    --cloud-hypervisor-memory-mib "$memory_mib"
    --cloud-hypervisor-scratch-mib "$scratch_mib"
  )
fi

cat > "$workspace_dir/workload.sh" <<'EOF'
#!/bin/sh
set -eu
root=${AWF_PHASE4_CANARY_ROOT:?}
guest_stage=bootstrap
guest_fail() {
  code=$1
  reason=$2
  printf '%s\n' "$reason" > "$root/guest-error"
  exit "$code"
}
guest_exit() {
  status=$?
  if [ "$status" -ne 0 ] && [ ! -s "$root/guest-error" ]; then
    printf 'stage=%s status=%s\n' "$guest_stage" "$status" > "$root/guest-error"
  fi
  printf '%s\n' "$status" > "$root/workload-ended"
  while [ ! -f "$root/cleanup-release" ]; do sleep 0.1; done
}
read_nvx_guest_pids_limits() {
  cmdline_file=$1
  cgroup_membership_file=$2
  cgroup_root=$3
  kernel_pids_max=$(
    tr ' ' '\n' < "$cmdline_file" |
      sed -n 's/^nvx_pids_max=//p' |
      tail -n 1
  )
  case "$kernel_pids_max" in
    ''|*[!0-9]*|0) guest_fail 48 nvx-guest-pids-limit-missing ;;
  esac
  guest_cgroup=$(awk -F: '$1 == "0" { print $3 }' "$cgroup_membership_file")
  case "$guest_cgroup" in
    /*) ;;
    *) guest_fail 49 nvx-guest-cgroup-missing ;;
  esac
  guest_cgroup_pids_file="$cgroup_root${guest_cgroup%/}/pids.max"
  if [ ! -r "$guest_cgroup_pids_file" ]; then
    guest_fail 50 nvx-guest-cgroup-pids-limit-missing
  fi
  guest_cgroup_pids_max=$(cat "$guest_cgroup_pids_file")
  case "$guest_cgroup_pids_max" in
    ''|*[!0-9]*|0) guest_fail 51 nvx-guest-cgroup-pids-limit-invalid ;;
  esac
  if [ "$guest_cgroup_pids_max" != "$kernel_pids_max" ]; then
    guest_fail 52 nvx-guest-cgroup-pids-limit-mismatch
  fi
  printf '%s %s\n' "$guest_cgroup_pids_max" "$((guest_cgroup_pids_max - 1))"
}
trap guest_exit EXIT
guest_stage=workspace
test "$(pwd)" = /workspace
printf '%s\n' ready > "$root/runtime-ready"
if awk '$5 == "/host" { found = 1 } END { exit !found }' /proc/self/mountinfo; then
  guest_fail 40 host-mount-visible
fi
guest_stage=credentials
if env | grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)='; then
  guest_fail 41 real-credential-environment-visible
fi
copilot_placeholder="ghu_$(printf '%036s' '' | tr ' ' a)"
if [ -n "${COPILOT_GITHUB_TOKEN:-}" ] &&
   [ "$COPILOT_GITHUB_TOKEN" != "$copilot_placeholder" ]; then
  guest_fail 42 copilot-github-token-not-placeholder
fi
if [ -n "${COPILOT_TOKEN:-}" ] && [ "$COPILOT_TOKEN" != "$copilot_placeholder" ]; then
  guest_fail 44 copilot-token-not-placeholder
fi
if [ -n "${COPILOT_API_KEY:-}" ] &&
   [ "$COPILOT_API_KEY" != "dummy-byok-key-for-offline-mode" ]; then
  guest_fail 45 copilot-api-key-not-placeholder
fi
if [ -n "${COPILOT_PROVIDER_API_KEY:-}" ] &&
   [ "$COPILOT_PROVIDER_API_KEY" != "$copilot_placeholder" ]; then
  guest_fail 46 copilot-provider-api-key-not-placeholder
fi
guest_stage=egress
blocked=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://example.com 2>/dev/null || true)
blocked=${blocked:-000}
case "$blocked" in 000|403) ;; *) guest_fail 43 deny-by-default-egress-failed ;; esac
guest_stage=toolchain
guest_node_version=$("$AWF_PHASE4_NODE_BIN" --version)
guest_curl_version=$(curl --version | awk 'NR == 1 {print $1, $2}')
scratch_capacity=$(df -Pk /tmp | awk 'NR == 2 {printf "%.0f\n", $2 * 1024}')
guest_pids_max=
guest_cgroup_pids_max=
if [ "$AWF_PHASE4_RUNTIME" = nvx ]; then
  guest_pids_limits=$(
    read_nvx_guest_pids_limits /proc/cmdline /proc/self/cgroup /sys/fs/cgroup
  )
  guest_cgroup_pids_max=${guest_pids_limits%% *}
  guest_pids_max=${guest_pids_limits#* }
fi
scratch_before_bytes=$(du -sb /tmp 2>/dev/null | awk '{print $1}')
scratch_before_bytes=${scratch_before_bytes:-0}
scratch_peak_bytes=$scratch_before_bytes
GUEST_NODE_VERSION=$guest_node_version \
GUEST_CURL_VERSION=$guest_curl_version \
SCRATCH_CAPACITY_BYTES=$scratch_capacity \
GUEST_PIDS_MAX=$guest_pids_max \
GUEST_CGROUP_PIDS_MAX=$guest_cgroup_pids_max \
"$AWF_PHASE4_NODE_BIN" -e '
  require("node:fs").writeFileSync(process.argv[1], JSON.stringify({
    credentialIsolation: true, egressPolicy: true, workspaceOnlyExposure: true,
    runtime: process.env.AWF_PHASE4_RUNTIME,
    configuredPidsMax: Number(process.env.AWF_PHASE4_PROFILE_PIDS_MAX),
    pidsMax: process.env.GUEST_PIDS_MAX ? Number(process.env.GUEST_PIDS_MAX) : null,
    cgroupPidsMax: process.env.GUEST_CGROUP_PIDS_MAX ?
      Number(process.env.GUEST_CGROUP_PIDS_MAX) : null,
    nodeVersion: process.env.GUEST_NODE_VERSION,
    curlVersion: process.env.GUEST_CURL_VERSION,
    scratchCapacityBytes: Number(process.env.SCRATCH_CAPACITY_BYTES),
  }));
' "$root/guest-preflight.json"
# Host inspection and resource tuning must complete before either workload runs.
while [ ! -f "$root/workload-release" ]; do sleep 0.1; done
if [ -f "$root/workload-abort" ]; then guest_fail 47 concurrent-peer-failed; fi
guest_stage=workload
case "${AWF_PHASE4_WORKLOAD:?}" in
  build-test)
    printf '%s\n' ready > "$root/first-work"
    mkdir -p /tmp/phase4-build
    cat > /tmp/phase4-build/build.js <<'BUILD'
const assert = require("node:assert/strict");
const value = Array.from({ length: 1000 }, (_, index) => index).reduce((a, b) => a + b, 0);
assert.equal(value, 499500);
process.stdout.write(`${value}\n`);
BUILD
    "$AWF_PHASE4_NODE_BIN" --check /tmp/phase4-build/build.js
    "$AWF_PHASE4_NODE_BIN" /tmp/phase4-build/build.js > "$root/build-proof"
    grep -qx 499500 "$root/build-proof"
    test -s "$root/build-proof"
    scratch_peak_bytes=$(du -sb /tmp 2>/dev/null | awk '{print $1}')
    scratch_peak_bytes=${scratch_peak_bytes:-$scratch_before_bytes}
    ;;
  copilot-inference)
    : "${AWF_PHASE4_COPILOT_BIN:?}"
    : > "$root/copilot-proof"
    run_copilot() {
      instance=$1
      runtime_home="/tmp/phase4-copilot-home-$instance"
      mkdir -m 0700 "$runtime_home"
      HOME="$runtime_home" \
      COPILOT_HOME="$runtime_home/.copilot" \
      XDG_CACHE_HOME="$runtime_home/.cache" \
      XDG_CONFIG_HOME="$runtime_home/.config" \
      XDG_STATE_HOME="$runtime_home/.local/state" \
      "$AWF_PHASE4_COPILOT_BIN" \
        --prompt "Respond with exactly PHASE4-CAMPAIGN-PROOF and nothing else." \
        --silent --no-color --stream on --allow-all-tools \
        --disable-builtin-mcps --no-custom-instructions --no-auto-update \
        --no-ask-user --model claude-sonnet-5 --max-ai-credits 30
    }
    run_copilot 1 > "$root/copilot-proof" &
    copilot_pid=$!
    while kill -0 "$copilot_pid" 2>/dev/null; do
      current_scratch_bytes=$(du -sb /tmp 2>/dev/null | awk '{print $1}')
      current_scratch_bytes=${current_scratch_bytes:-$scratch_before_bytes}
      if [ "$current_scratch_bytes" -gt "$scratch_peak_bytes" ]; then
        scratch_peak_bytes=$current_scratch_bytes
      fi
      if [ -s "$root/copilot-proof" ]; then
        printf '%s\n' ready > "$root/first-work"
        break
      fi
      sleep 0.05
    done
    wait "$copilot_pid"
    if [ ! -f "$root/first-work" ] && [ -s "$root/copilot-proof" ]; then
      printf '%s\n' ready > "$root/first-work"
    fi
    test -f "$root/first-work"
    test "$(grep -c 'PHASE4-CAMPAIGN-PROOF' "$root/copilot-proof")" -ge 1
    ;;
esac
scratch_after_bytes=$(du -sb /tmp 2>/dev/null | awk '{print $1}')
scratch_after_bytes=${scratch_after_bytes:-$scratch_before_bytes}
if [ "$scratch_after_bytes" -gt "$scratch_peak_bytes" ]; then
  scratch_peak_bytes=$scratch_after_bytes
fi
scratch_usage_bytes=$((scratch_peak_bytes - scratch_before_bytes))
if [ "$scratch_usage_bytes" -lt 0 ]; then scratch_usage_bytes=0; fi
guest_stage=evidence
GUEST_NODE_VERSION=$guest_node_version \
GUEST_CURL_VERSION=$guest_curl_version \
SCRATCH_CAPACITY_BYTES=$scratch_capacity \
SCRATCH_USAGE_BYTES=$scratch_usage_bytes \
GUEST_PIDS_MAX=$guest_pids_max \
GUEST_CGROUP_PIDS_MAX=$guest_cgroup_pids_max \
"$AWF_PHASE4_NODE_BIN" -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({
    credentialIsolation: true,
    egressPolicy: true,
    workspaceOnlyExposure: true,
    runtime: process.env.AWF_PHASE4_RUNTIME,
    configuredPidsMax: Number(process.env.AWF_PHASE4_PROFILE_PIDS_MAX),
    pidsMax: process.env.GUEST_PIDS_MAX ? Number(process.env.GUEST_PIDS_MAX) : null,
    cgroupPidsMax: process.env.GUEST_CGROUP_PIDS_MAX ?
      Number(process.env.GUEST_CGROUP_PIDS_MAX) : null,
    nodeVersion: process.env.GUEST_NODE_VERSION,
    curlVersion: process.env.GUEST_CURL_VERSION,
    scratchCapacityBytes: Number(process.env.SCRATCH_CAPACITY_BYTES),
    scratchUsageBytes: Number(process.env.SCRATCH_USAGE_BYTES),
  }));
' "$root/guest-status.json"
printf '%s\n' complete > "$root/workload-complete"
EOF
chmod 0755 "$workspace_dir/workload.sh"

if [ "$workload" = copilot-inference ]; then
  if [ "$runtime" = nvx ]; then
    copilot_host="$RUNNER_TEMP/gh-aw/nvx-engine/copilot"
  else
    copilot_host=$(command -v copilot)
  fi
  test -x "$copilot_host"
  cp "$copilot_host" "$workspace_dir/copilot"
  chmod 0555 "$workspace_dir/copilot"
fi
if [ "$runtime" = nvx ]; then
  node_guest=node
else
  node_host=$(command -v node)
  test -x "$node_host"
  cp "$node_host" "$workspace_dir/node"
  chmod 0555 "$workspace_dir/node"
  node_guest="/workspace/.nvx-phase4-campaign/$sample_id/node"
fi

config="$sample_root/awf-config.json"
jq -n \
  --arg proxy_logs "$proxy_logs" \
  '{
    network:{
      allowDomains:[
        "api.business.githubcopilot.com",
        "api.enterprise.githubcopilot.com",
        "api.github.com",
        "api.githubcopilot.com",
        "api.individual.githubcopilot.com",
        "github.com"
      ],
      isolation:true
    },
    filesystem:{allowWrite:["/workspace/.nvx-phase4-campaign"]},
    apiProxy:{enabled:true},
    logging:{proxyLogsDir:$proxy_logs}
  }' > "$config"

export AWF_PHASE4_CANARY_ROOT="/workspace/.nvx-phase4-campaign/$sample_id"
export AWF_PHASE4_WORKLOAD="$workload"
export AWF_PHASE4_RUNTIME="$runtime"
export AWF_PHASE4_PROFILE_PIDS_MAX="$pids_max"
export AWF_PHASE4_MODE="$mode"
export AWF_PHASE4_COPILOT_BIN="$AWF_PHASE4_CANARY_ROOT/copilot"
export AWF_PHASE4_NODE_BIN="$node_guest"
preflight_completed=

peer_workspace="$workspace_dir/peer"
peer_work_dir="$sample_root/peer-awf"
peer_log="$sample_root/peer-awf.log"
peer_proxy_logs="$sample_root/peer-api-proxy-logs"
peer_pid=
if [ "$mode" = concurrent ]; then
  mkdir -m 0700 "$peer_workspace" "$peer_work_dir" "$peer_proxy_logs"
fi

run_awf() {
  local instance_root=$1 instance_work=$2 instance_config=$3
  exec sudo --preserve-env=AWF_PHASE4_WORKLOAD,AWF_PHASE4_RUNTIME,AWF_PHASE4_PROFILE_PIDS_MAX,AWF_PHASE4_COPILOT_BIN,AWF_PHASE4_NODE_BIN,COPILOT_GITHUB_TOKEN,GITHUB_ACTIONS,RUNNER_ENVIRONMENT,ImageOS \
  node dist/cli.js \
  --config "$instance_config" \
  --work-dir "$instance_work" \
  --container-workdir /workspace \
  --enable-api-proxy \
  --image-tag "0.28.54,squid=sha256:960930db796d005e63153b9ffd984b58ebda1ed8c26800c09eb7515dc94237db,agent=sha256:fc4f3d07d9f0479aa76d4a6d55f36735c29e0558f10a413fbd36e3d00b34a830,api-proxy=sha256:f8dff30ac37a8987b564f2872796a9c093b3ab281b1cdfc3493c1ea5fa84ff79" \
  --env "AWF_PHASE4_CANARY_ROOT=$instance_root" \
  --env "AWF_PHASE4_WORKLOAD=$workload" \
  --env "AWF_PHASE4_RUNTIME=$runtime" \
  --env "AWF_PHASE4_PROFILE_PIDS_MAX=$pids_max" \
  --env "AWF_PHASE4_COPILOT_BIN=$AWF_PHASE4_COPILOT_BIN" \
  --env "AWF_PHASE4_NODE_BIN=$AWF_PHASE4_NODE_BIN" \
  --log-level debug \
  "${runtime_args[@]}" \
  -- "/bin/sh $AWF_PHASE4_CANARY_ROOT/workload.sh"
}

run_peer() {
  exec sudo --preserve-env=COPILOT_GITHUB_TOKEN,GITHUB_ACTIONS,RUNNER_ENVIRONMENT,ImageOS \
    node - --work-dir "$peer_work_dir" --container-workdir /workspace \
    --network-isolation --enable-api-proxy --log-level debug "${runtime_args[@]}" \
    --env "AWF_PHASE4_CANARY_ROOT=$AWF_PHASE4_CANARY_ROOT/peer" \
    --env "AWF_PHASE4_WORKLOAD=$workload" \
    --env "AWF_PHASE4_RUNTIME=$runtime" \
    --env "AWF_PHASE4_PROFILE_PIDS_MAX=$pids_max" \
    --env "AWF_PHASE4_COPILOT_BIN=$AWF_PHASE4_COPILOT_BIN" \
    --env "AWF_PHASE4_NODE_BIN=$AWF_PHASE4_NODE_BIN" \
    -- "/bin/sh $AWF_PHASE4_CANARY_ROOT/workload.sh" <<'PEER'
const fs = require("node:fs/promises");
const path = require("node:path");
const { program } = require(path.resolve("dist/cli-options.js"));
const { buildConfig } = require(path.resolve("dist/commands/build-config.js"));
const { logger } = require(path.resolve("dist/logger.js"));
program.parse(process.argv.slice(2), { from: "user" });
const options = program.opts();
logger.setLevel("debug");
const config = buildConfig({
  options: {
    ...options,
    networkIsolation: true,
    filesystemAllowWrite: ["/workspace/.nvx-phase4-campaign"],
  },
  agentCommand: program.args.join(" "), logLevel: "debug",
  allowedDomains: [], blockedDomains: [], localhostDetected: false,
  additionalEnv: Object.fromEntries(options.env.map(value => {
    const index = value.indexOf("=");
    return [value.slice(0, index), value.slice(index + 1)];
  })),
  dnsServers: ["8.8.8.8", "8.8.4.4"],
});
const factory = config.containerRuntime === "nvx"
  ? require(path.resolve("dist/nvx/runtime-backend.js")).createNvxRuntimeBackend
  : require(path.resolve("dist/cloud-hypervisor/runtime-backend.js")).createCloudHypervisorRuntimeBackend;
// The primary CLI alone owns sidecars and host policy. The peer only owns its
// inspected runtime; rediscovery/revalidation uses the ordinary backend path.
const backend = factory(config, async () => {});
let stopping;
const stop = () => stopping ??= backend.stop();
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { void stop().catch(error => { console.error(error); process.exitCode = 1; }); });
}
(async () => {
  try {
    await backend.start(config.workDir, [], undefined);
    const result = await backend.exec(config.workDir, [], undefined);
    process.exitCode = result.exitCode;
  } finally {
    await stop();
    await fs.rm(config.workDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
PEER
}

run_awf "$AWF_PHASE4_CANARY_ROOT" "$work_dir" "$config" >"$awf_log" 2>&1 &
awf_pid=$!

deadline=$((SECONDS + 900))
runtime_ready=
first_work=
workload_completed=
observed_cgroup=
observed_memory_max=
observed_cpu_max=
observed_pids_max=
peer_cgroup=
peer_memory_max=
peer_cpu_max=
peer_pids_max=
primary_cleanup_record=
peer_cleanup_record=
concurrent_isolation=false
if [ "$mode" = sequential ]; then concurrent_isolation=true; fi
workload_released=false
cleanup_released=false
peak_host_disk_bytes=0
cpu_usage_micros=0
primary_cpu_micros=0
peer_cpu_micros=0
while kill -0 "$awf_pid" 2>/dev/null ||
      { [ -n "$peer_pid" ] && kill -0 "$peer_pid" 2>/dev/null; }; do
  current_host=$(
    local_bytes=$(
      du -sb "$sample_root" "$workspace_dir" 2>/dev/null |
        awk '{sum += $1} END {print sum + 0}'
    )
    runtime_bytes=$(runtime_storage_bytes)
    runtime_delta=$((runtime_bytes - runtime_storage_before))
    if [ "$runtime_delta" -lt 0 ]; then runtime_delta=0; fi
    echo $((local_bytes + runtime_delta))
  )
  current_host=${current_host:-0}
  if [ "$current_host" -gt "$peak_host_disk_bytes" ]; then
    peak_host_disk_bytes=$current_host
  fi
  if [ -z "$observed_cgroup" ]; then
    capture_runtime_identity "$work_dir" "$evidence_dir/runtime-identity.json"
    if sudo test -s "$evidence_dir/runtime-identity.json"; then
      candidate=$(sudo jq -er '.cgroup' "$evidence_dir/runtime-identity.json")
      if [[ "$candidate" == "/sys/fs/cgroup/awf-$runtime/"* ]] &&
         sudo test -f "$candidate/memory.max" &&
         sudo test -f "$candidate/cpu.max" &&
         sudo test -f "$candidate/pids.max" &&
         sudo test -f "$candidate/cpu.stat"; then
        observed_cgroup=$candidate
        primary_cleanup_record=$(sudo jq -er '.cleanupRecord' "$evidence_dir/runtime-identity.json")
        preflight_completed=$(now_ms)
        tune_campaign_cgroup "$candidate"
        observed_memory_max=$(sudo cat "$candidate/memory.max")
        observed_cpu_max=$(sudo cat "$candidate/cpu.max")
        observed_pids_max=$(sudo cat "$candidate/pids.max")
      fi
    fi
  fi
  if [ "$mode" = concurrent ] && [ -z "$peer_pid" ] &&
     [ -s "$workspace_dir/guest-preflight.json" ]; then
    run_peer >"$peer_log" 2>&1 &
    peer_pid=$!
  fi
  if [ "$mode" = concurrent ] && [ -z "$peer_cgroup" ]; then
    capture_runtime_identity "$peer_work_dir" "$evidence_dir/peer-runtime-identity.json"
    if sudo test -s "$evidence_dir/peer-runtime-identity.json"; then
     peer_cgroup=$(sudo jq -er '.cgroup' "$evidence_dir/peer-runtime-identity.json")
     peer_cleanup_record=$(sudo jq -er '.cleanupRecord' "$evidence_dir/peer-runtime-identity.json")
     tune_campaign_cgroup "$peer_cgroup"
     peer_memory_max=$(sudo cat "$peer_cgroup/memory.max")
     peer_cpu_max=$(sudo cat "$peer_cgroup/cpu.max")
     peer_pids_max=$(sudo cat "$peer_cgroup/pids.max")
    fi
  fi
  if [ "$mode" = concurrent ] && [ -n "$peer_pid" ] &&
     [ "$workload_released" = false ] &&
     { { [ -f "$peer_workspace/workload-ended" ] &&
         [ ! -s "$peer_workspace/guest-preflight.json" ]; } ||
       ! kill -0 "$peer_pid" 2>/dev/null ||
       ! kill -0 "$awf_pid" 2>/dev/null; }; then
    touch "$workspace_dir/workload-abort" "$peer_workspace/workload-abort"
    touch "$workspace_dir/workload-release" "$peer_workspace/workload-release"
    touch "$workspace_dir/cleanup-release" "$peer_workspace/cleanup-release"
    workload_released=true
    cleanup_released=true
  fi
  if [ "$workload_released" = false ] && [ -n "$observed_cgroup" ] &&
    [ -s "$workspace_dir/guest-preflight.json" ]; then
    if [ "$mode" = concurrent ] && [ -n "$peer_cgroup" ] &&
      [ -s "$peer_workspace/guest-preflight.json" ]; then
     capture_runtime_identity "$work_dir" "$evidence_dir/runtime-identity.json"
     capture_runtime_identity "$peer_work_dir" "$evidence_dir/peer-runtime-identity.json"
     if sudo jq -es '
       length == 2 and
       (map(.runId) | unique | length == 2) and
       (map(.pid) | unique | length == 2) and
       (map(.uid) | unique | length == 2) and
       (map(.account) | unique | length == 2) and
       (map(.runDirectory) | unique | length == 2) and
       (map(.cleanupRecord) | unique | length == 2) and
       (map(.cgroup) | unique | length == 2) and
       (map(.networkNamespace) | unique | length == 2)
     ' "$evidence_dir/runtime-identity.json" "$evidence_dir/peer-runtime-identity.json" >/dev/null; then
       concurrent_isolation=true
     fi
     touch "$peer_workspace/workload-release"
     touch "$workspace_dir/workload-release"
     workload_released=true
    elif [ "$mode" = sequential ]; then
     touch "$workspace_dir/workload-release"
     workload_released=true
    fi
  fi
  if [ -n "$observed_cgroup" ] &&
     sudo test -f "$observed_cgroup/cpu.stat"; then
    current_cpu_micros=$(sudo awk '$1 == "usage_usec" { print $2 }' \
         "$observed_cgroup/cpu.stat" 2>/dev/null || true)
    if [[ "$current_cpu_micros" =~ ^[0-9]+$ ]] &&
          [ "$current_cpu_micros" -gt "$primary_cpu_micros" ]; then
         primary_cpu_micros=$current_cpu_micros
    fi
  fi
  if [ -n "$peer_cgroup" ] && sudo test -f "$peer_cgroup/cpu.stat"; then
    current_peer_cpu=$(sudo awk '$1 == "usage_usec" { print $2 }' "$peer_cgroup/cpu.stat" 2>/dev/null || true)
    if [[ "$current_peer_cpu" =~ ^[0-9]+$ ]] && [ "$current_peer_cpu" -gt "$peer_cpu_micros" ]; then
      peer_cpu_micros=$current_peer_cpu
    fi
  fi
  cpu_usage_micros=$((primary_cpu_micros + peer_cpu_micros))
  if [ -z "$runtime_ready" ] && [ "$workload_released" = true ]; then
    runtime_ready=$(now_ms)
  fi
  if [ -z "$first_work" ] && [ -f "$first_marker" ]; then
    first_work=$(now_ms)
  fi
  if [ -z "$workload_completed" ] && [ -f "$complete_marker" ] &&
     { [ "$mode" = sequential ] || [ -f "$peer_workspace/workload-complete" ]; }; then
    workload_completed=$(now_ms)
  fi
  if [ "$cleanup_released" = false ] && [ -f "$workspace_dir/workload-ended" ] &&
     { [ "$mode" = sequential ] || [ -f "$peer_workspace/workload-ended" ] ||
       { [ -n "$peer_pid" ] && ! kill -0 "$peer_pid" 2>/dev/null; } ||
       [ ! -s "$workspace_dir/guest-preflight.json" ]; }; then
    touch "$workspace_dir/cleanup-release"
    if [ "$mode" = concurrent ]; then touch "$peer_workspace/cleanup-release"; fi
    cleanup_released=true
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    touch "$workspace_dir/cleanup-release" "$workspace_dir/workload-release"
    if [ "$mode" = concurrent ]; then
      touch "$peer_workspace/cleanup-release" "$peer_workspace/workload-release"
    fi
    sudo kill -TERM "$awf_pid" 2>/dev/null || true
    if [ -n "$peer_pid" ]; then sudo kill -TERM "$peer_pid" 2>/dev/null || true; fi
    break
  fi
  sleep 0.1
done
set +e
wait "$awf_pid"
awf_status=$?
peer_status=0
if [ -n "$peer_pid" ]; then
  wait "$peer_pid"
  peer_status=$?
  if [ "$peer_status" -ne 0 ]; then awf_status=$peer_status; fi
fi
set -e

for _cleanup_attempt in $(seq 1 50); do
  processes_after=$(runtime_process_snapshot)
  netns_after=$(sudo ip netns list 2>/dev/null || true)
  cgroups_after=$(sudo find /sys/fs/cgroup -maxdepth 4 -type d \
    \( -path '/sys/fs/cgroup/awf-nvx*' -o \
       -path '/sys/fs/cgroup/awf-cloud-hypervisor*' \) \
    ! -path '/sys/fs/cgroup/awf-nvx' \
    ! -path '/sys/fs/cgroup/awf-cloud-hypervisor' -print 2>/dev/null | sort)
  mounts_after=$(findmnt -rn -o TARGET 2>/dev/null | grep -E 'awf-(nvx|cloud-hypervisor)' || true)
  kvm_acl_after=$(sudo getfacl --absolute-names --numeric /dev/kvm 2>/dev/null)
  cleanup_after=$(runtime_storage_snapshot "$runtime" cleanup)
  runs_after=$(runtime_storage_snapshot "$runtime" run)
  scratch_after=$(runtime_storage_snapshot "$runtime" scratch)
  snapshots_after=$(runtime_storage_snapshot "$runtime" snapshot)
  if [ "$processes_before" = "$processes_after" ] &&
     [ "$netns_before" = "$netns_after" ] &&
     [ "$cgroups_before" = "$cgroups_after" ] &&
     [ "$mounts_before" = "$mounts_after" ] &&
     [ "$cleanup_before" = "$cleanup_after" ] &&
     { [ "$mode" = sequential ] ||
       { [ -n "$primary_cleanup_record" ] && [ -n "$peer_cleanup_record" ] &&
         ! sudo test -e "$primary_cleanup_record" &&
         ! sudo test -e "$peer_cleanup_record"; }; } &&
     [ "$runs_before" = "$runs_after" ] &&
     [ "$scratch_before" = "$scratch_after" ] &&
     [ "$snapshots_before" = "$snapshots_after" ] &&
     [ "$(normalize_kvm_acl "$kvm_acl_before")" = \
       "$(normalize_kvm_acl "$kvm_acl_after")" ]; then
    break
  fi
  sleep 0.1
done
cleanup_completed=$(now_ms)
printf '%s\n' "$kvm_acl_after" > "$kvm_acl_after_snapshot"
chmod 0600 "$kvm_acl_after_snapshot"
npx tsx scripts/ci/nvx-phase4-kvm-acl-evidence.ts \
  "$kvm_acl_before_snapshot" "$kvm_acl_expected_source" \
  "$kvm_acl_after_snapshot" /dev/kvm \
  "$evidence_dir/kvm-acl-diagnostics-$sample_id.json"
restore_kvm_acl
trap - EXIT
rm -f -- "$kvm_acl_before_snapshot" "$kvm_acl_after_snapshot"

preflight_completed=${preflight_completed:-$preflight_started}
runtime_ready=${runtime_ready:-$preflight_completed}
first_work=${first_work:-$runtime_ready}
workload_completed=${workload_completed:-$first_work}
scratch_bytes=0
guest_node_version=
guest_curl_version=
if [ -s "$workspace_dir/guest-preflight.json" ]; then
  guest_node_version=$(jq -er '.nodeVersion' "$workspace_dir/guest-preflight.json")
  guest_curl_version=$(jq -er '.curlVersion' "$workspace_dir/guest-preflight.json")
fi
if [ -s "$guest_status" ]; then
  scratch_bytes=$(jq -er '.scratchUsageBytes' "$guest_status")
  guest_node_version=$(jq -er '.nodeVersion' "$guest_status")
  guest_curl_version=$(jq -er '.curlVersion' "$guest_status")
fi
if [ "$mode" = concurrent ] && [ -s "$peer_workspace/guest-status.json" ]; then
  peer_scratch_bytes=$(jq -er '.scratchUsageBytes' "$peer_workspace/guest-status.json")
  scratch_bytes=$((scratch_bytes + peer_scratch_bytes))
fi
host_disk_bytes=$peak_host_disk_bytes

jq -n \
  --argjson artifactPreflightStartedMs "$preflight_started" \
  --argjson artifactPreflightCompletedMs "$preflight_completed" \
  --argjson runtimeReadyMs "$runtime_ready" \
  --argjson firstWorkloadMs "$first_work" \
  --argjson workloadCompletedMs "$workload_completed" \
  --argjson cleanupCompletedMs "$cleanup_completed" \
  --argjson scratchBytes "$scratch_bytes" \
  --argjson hostDiskBytes "$host_disk_bytes" \
  --argjson cpuUsageMicros "$cpu_usage_micros" \
  --arg guestNodeVersion "$guest_node_version" \
  --arg guestCurlVersion "$guest_curl_version" \
  --arg cachePreparation "$([ "$cache_state" = cold ] && echo cold-cache-flushed || echo warm-cache-primed)" \
  '{
    artifactPreflightStartedMs:$artifactPreflightStartedMs,
    artifactPreflightCompletedMs:$artifactPreflightCompletedMs,
    runtimeReadyMs:$runtimeReadyMs,
    firstWorkloadMs:$firstWorkloadMs,
    workloadCompletedMs:$workloadCompletedMs,
    cleanupCompletedMs:$cleanupCompletedMs,
    scratchBytes:$scratchBytes,
    hostDiskBytes:$hostDiskBytes,
    cpuUsageMicros:$cpuUsageMicros,
    guestTools:{node:$guestNodeVersion,curl:$guestCurlVersion},
    cachePreparation:$cachePreparation
  }' > "$AWF_BENCHMARK_EVENTS"

residue=()
[ "$processes_before" = "$processes_after" ] || residue+=("runtime-process")
[ "$netns_before" = "$netns_after" ] || residue+=("network-namespace")
[ "$cgroups_before" = "$cgroups_after" ] || residue+=("cgroup")
[ "$mounts_before" = "$mounts_after" ] || residue+=("mount")
[ "$cleanup_before" = "$cleanup_after" ] || residue+=("cleanup-record")
if [ "$mode" = concurrent ]; then
  [ -n "$primary_cleanup_record" ] &&
    ! sudo test -e "$primary_cleanup_record" ||
    residue+=("cleanup-record:primary")
  [ -n "$peer_cleanup_record" ] &&
    ! sudo test -e "$peer_cleanup_record" ||
    residue+=("cleanup-record:peer")
fi
[ "$runs_before" = "$runs_after" ] || residue+=("runtime-run-directory")
[ "$scratch_before" = "$scratch_after" ] || residue+=("runtime-scratch")
[ "$snapshots_before" = "$snapshots_after" ] || residue+=("trusted-artifact-snapshot")
test ! -e "$work_dir" || residue+=("run-directory:$work_dir")
kvm_restored=false
if [ "$(normalize_kvm_acl "$kvm_acl_before")" = \
  "$(normalize_kvm_acl "$kvm_acl_after")" ]; then
  kvm_restored=true
else
  residue+=("kvm-acl")
fi
guest_ok=false
egress=false
credential=false
workspace=false
bounded_scratch=false
security_files=("$workspace_dir/guest-preflight.json")
status_files=("$guest_status")
if [ "$mode" = concurrent ]; then
  security_files+=("$peer_workspace/guest-preflight.json")
  status_files+=("$peer_workspace/guest-status.json")
fi
all_preflight=true
all_status=true
for file in "${security_files[@]}"; do
  if [ ! -s "$file" ]; then all_preflight=false; fi
done
for file in "${status_files[@]}"; do
  if [ ! -s "$file" ]; then all_status=false; fi
done
if [ "$all_status" = true ]; then guest_ok=true; fi
if [ "$all_preflight" = true ]; then
  egress=$(jq -sr 'all(.[]; .egressPolicy == true)' "${security_files[@]}")
  credential=$(jq -sr 'all(.[]; .credentialIsolation == true)' "${security_files[@]}")
  workspace=$(jq -sr 'all(.[]; .workspaceOnlyExposure == true)' "${security_files[@]}")
  bounded_scratch=$(jq -sr --argjson limit "$scratch_limit_bytes" \
    'all(.[]; (.scratchCapacityBytes | type) == "number" and
      .scratchCapacityBytes > 0 and .scratchCapacityBytes <= $limit)' "${security_files[@]}")
fi
runtime_selected_no_fallback=false
if { [ "$runtime" = nvx ] && grep -Fq "[nvx] Agent command exited" "$awf_log"; } ||
   { [ "$runtime" = cloud-hypervisor ] &&
     grep -Fq "[cloud-hypervisor] runtime=cloud-hypervisor maturity=preview fallback=disabled" \
       "$awf_log"; }; then
  runtime_selected_no_fallback=true
fi
if [ "$mode" = concurrent ]; then
  if { [ "$runtime" = nvx ] && ! grep -Fq "[nvx] Agent command exited" "$peer_log"; } ||
     { [ "$runtime" = cloud-hypervisor ] &&
       ! grep -Fq "[cloud-hypervisor] runtime=cloud-hypervisor maturity=preview fallback=disabled" "$peer_log"; }; then
    runtime_selected_no_fallback=false
  fi
fi
immutable_artifacts=false
if [ "$runtime" = nvx ]; then
  immutable_artifacts=true
  for artifact in \
    "$NVX_OPENVMM" "$NVX_KERNEL" "$NVX_INITRAMFS" \
    "$NVX_MANIFEST" "$NVX_MANIFEST_BUNDLE"; do
    if [ "$(stat -c %u "$artifact")" != 0 ] ||
       [ "$((8#$(stat -c %a "$artifact") & 8#022))" != 0 ]; then
      immutable_artifacts=false
    fi
  done
else
  immutable_artifacts=true
  for artifact in \
    "$GH_AW_CLOUD_HYPERVISOR_BINARY" "$GH_AW_CLOUD_HYPERVISOR_KERNEL" \
    "$GH_AW_CLOUD_HYPERVISOR_ROOTFS" "$GH_AW_CLOUD_HYPERVISOR_SUPERVISOR" \
    "$GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST" \
    "$GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST_BUNDLE"; do
    if [ ! -f "$artifact" ] || [ "$(stat -c %u "$artifact")" != 0 ] ||
       [ "$((8#$(stat -c %a "$artifact") & 8#022))" != 0 ]; then
      immutable_artifacts=false
    fi
  done
fi
resource_limits=false
# Both launchers add 256 MiB of host-runtime headroom to the matched guest
# limit.
expected_memory_max=$((memory_bytes + 256 * 1024 * 1024))
expected_cpu_max="$((cpu_cores * 100000)) 100000"
expected_host_pids_max=$pids_max
if [ "$runtime" = nvx ]; then expected_host_pids_max=$nvx_host_pids_max; fi
guest_limits=false
peer_guest_limits=true
if guest_resource_limits_match "$runtime" "$pids_max" "$workspace_dir/guest-preflight.json"; then
  guest_limits=true
fi
if [ "$mode" = concurrent ] &&
   ! guest_resource_limits_match "$runtime" "$pids_max" "$peer_workspace/guest-preflight.json"; then
  peer_guest_limits=false
fi
if campaign_resource_limits_enforced \
  "$mode" "$expected_memory_max" "$expected_cpu_max" "$expected_host_pids_max" \
  "$guest_limits" "$observed_cgroup" "$observed_memory_max" "$observed_cpu_max" \
  "$observed_pids_max" "$peer_guest_limits" "$peer_cgroup" "$peer_memory_max" \
  "$peer_cpu_max" "$peer_pids_max"; then
  resource_limits=true
fi
guest_pids_max=$(jq -er '.pidsMax // ""' "$workspace_dir/guest-preflight.json")
guest_cgroup_pids_max=$(jq -er '.cgroupPidsMax // ""' "$workspace_dir/guest-preflight.json")
peer_guest_pids_max=
peer_guest_cgroup_pids_max=
if [ "$mode" = concurrent ]; then
  peer_guest_pids_max=$(jq -er '.pidsMax // ""' "$peer_workspace/guest-preflight.json")
  peer_guest_cgroup_pids_max=$(jq -er '.cgroupPidsMax // ""' "$peer_workspace/guest-preflight.json")
fi
jq -n \
  --arg cgroup "$observed_cgroup" \
  --arg memoryMax "$observed_memory_max" \
  --arg cpuMax "$observed_cpu_max" \
  --arg pidsMax "$observed_pids_max" \
  --arg peerCgroup "$peer_cgroup" \
  --arg peerMemoryMax "$peer_memory_max" \
  --arg peerCpuMax "$peer_cpu_max" \
  --arg peerPidsMax "$peer_pids_max" \
  --arg expectedMemoryMax "$expected_memory_max" \
  --arg expectedHostPidsMax "$expected_host_pids_max" \
  --arg configuredGuestPidsMax "$pids_max" \
  --arg guestPidsMax "$guest_pids_max" \
  --arg guestCgroupPidsMax "$guest_cgroup_pids_max" \
  --arg peerGuestPidsMax "$peer_guest_pids_max" \
  --arg peerGuestCgroupPidsMax "$peer_guest_cgroup_pids_max" \
  '{cgroup:$cgroup,memoryMax:$memoryMax,cpuMax:$cpuMax,pidsMax:$pidsMax,
    expectedMemoryMax:$expectedMemoryMax,expectedPidsMax:$expectedHostPidsMax,
    guest:{configuredPidsMax:$configuredGuestPidsMax,observedPidsMax:$guestPidsMax,
      observedCgroupPidsMax:$guestCgroupPidsMax},
    peer:{cgroup:$peerCgroup,memoryMax:$peerMemoryMax,cpuMax:$peerCpuMax,pidsMax:$peerPidsMax,
      expectedPidsMax:$expectedHostPidsMax,
      guest:{configuredPidsMax:$configuredGuestPidsMax,observedPidsMax:$peerGuestPidsMax,
        observedCgroupPidsMax:$peerGuestCgroupPidsMax}}}' \
  > "$evidence_dir/resources.json"
chmod 0600 "$evidence_dir/resources.json"

raw_evidence_dir="$(dirname "$AWF_BENCHMARK_EVENTS")/runtime-$sample_id"
mkdir "$raw_evidence_dir"
chmod 0700 "$raw_evidence_dir"
cp --no-clobber "$awf_log" "$raw_evidence_dir/awf.log"
if [ -s "$guest_status" ]; then
  cp --no-clobber "$guest_status" "$raw_evidence_dir/guest-status.json"
fi
if [ -s "$workspace_dir/guest-preflight.json" ]; then
  cp --no-clobber "$workspace_dir/guest-preflight.json" "$raw_evidence_dir/guest-preflight.json"
fi
if [ "$mode" = concurrent ]; then
  if [ -f "$peer_log" ]; then cp --no-clobber "$peer_log" "$raw_evidence_dir/peer-awf.log"; fi
  for file in guest-preflight.json guest-status.json build-proof copilot-proof guest-error; do
    if [ -s "$peer_workspace/$file" ]; then
      cp --no-clobber "$peer_workspace/$file" "$raw_evidence_dir/peer-$file"
    fi
  done
  for marker in workload-ended workload-abort runtime-ready; do
    if [ -e "$peer_workspace/$marker" ]; then
      cp --no-clobber "$peer_workspace/$marker" "$raw_evidence_dir/peer-$marker"
    fi
  done
  if [ -s "$evidence_dir/peer-runtime-identity.json" ]; then
    cp --no-clobber "$evidence_dir/peer-runtime-identity.json" \
      "$raw_evidence_dir/peer-runtime-identity.json"
  fi
  test ! -e "$peer_work_dir" || residue+=("run-directory:$peer_work_dir")
fi
for proof in build-proof copilot-proof; do
  if [ -s "$workspace_dir/$proof" ]; then
    cp --no-clobber "$workspace_dir/$proof" "$raw_evidence_dir/$proof"
  fi
done
if [ -s "$workspace_dir/guest-error" ]; then
  cp --no-clobber "$workspace_dir/guest-error" "$raw_evidence_dir/guest-error.txt"
fi
proxy_roots=("$proxy_logs")
failure_logs=("$raw_evidence_dir/awf.log")
if [ "$mode" = concurrent ]; then
  proxy_roots+=("$peer_proxy_logs")
  failure_logs+=("$raw_evidence_dir/peer-awf.log")
fi
for log_kind in token-usage token-tracker-audit; do
  if [ "$log_kind" = token-usage ]; then
    token_output=${AWF_PHASE4_TOKEN_USAGE_OUTPUT:-}
  else
    token_output=${AWF_PHASE4_TOKEN_TRACKER_AUDIT_OUTPUT:-}
  fi
  if [ -n "$token_output" ]; then
    test ! -e "$token_output"
    while IFS= read -r -d '' token_log; do
      cat "$token_log" >> "$token_output"
    done < <(find "${proxy_roots[@]}" -name "$log_kind.jsonl" -type f -print0 | sort -z)
  fi
done
for token_log_evidence in \
  "${AWF_PHASE4_TOKEN_USAGE_OUTPUT:-}" \
  "${AWF_PHASE4_TOKEN_TRACKER_AUDIT_OUTPUT:-}"; do
  if [ -n "$token_log_evidence" ] && [ -e "$token_log_evidence" ]; then
    chmod 0600 "$token_log_evidence"
  fi
done
chmod 0600 "$raw_evidence_dir"/*

rm -rf -- "$workspace_dir"
sudo rm -rf -- "$sample_root"
test ! -e "$workspace_dir" || residue+=("workspace-staging:$workspace_dir")
test ! -e "$sample_root" || residue+=("sample-staging:$sample_root")

if [ "${#residue[@]}" -eq 0 ]; then
  printf '[]\n' > "$AWF_BENCHMARK_RESIDUE"
else
  printf '%s\n' "${residue[@]}" | jq -R . | jq -s . > "$AWF_BENCHMARK_RESIDUE"
fi

failure_category="workload-failure"
if [ "$awf_status" -eq 0 ] && [ "$guest_ok" = true ] &&
   [ -n "$observed_cgroup" ] && [ "$egress" = true ] &&
   [ "$credential" = true ] && [ "$workspace" = true ] &&
   [ "$concurrent_isolation" = true ] &&
   [ "$runtime_selected_no_fallback" = true ] && [ "$immutable_artifacts" = true ] &&
   [ "$bounded_scratch" = true ] && [ "$resource_limits" = true ] &&
   [ "$kvm_restored" = true ] && [ "${#residue[@]}" -eq 0 ]; then
  failure_category=success
elif [ "$egress" = true ] && [ "$credential" = true ] && [ "$workspace" = true ] &&
    [ "$concurrent_isolation" = true ] &&
   [ "$runtime_selected_no_fallback" = true ] && [ "$immutable_artifacts" = true ] &&
   [ "$bounded_scratch" = true ] && [ "$resource_limits" = true ] &&
   [ "$kvm_restored" = true ] && [ "${#residue[@]}" -eq 0 ] &&
   grep -Eqi 'EAI_AGAIN|ENETUNREACH|ETIMEDOUT|ECONNRESET|upstream[^[:alnum:]]+(502|503)|HTTP[^[:alnum:]]+(502|503)' \
     "${failure_logs[@]}"; then
  failure_category=network-infrastructure
fi
jq -n \
  --argjson provenance "$([ -n "$observed_cgroup" ] && echo true || echo false)" \
  --argjson runtimeFallback "$runtime_selected_no_fallback" \
  --argjson egressPolicy "$egress" \
  --argjson credentialIsolation "$credential" \
  --argjson workspaceOnlyExposure "$workspace" \
  --argjson concurrentIsolation "$concurrent_isolation" \
  --argjson immutableArtifacts "$immutable_artifacts" \
  --argjson boundedScratch "$bounded_scratch" \
  --argjson kvmAclRestoration "$kvm_restored" \
  --argjson residue "$([ "${#residue[@]}" -eq 0 ] && echo true || echo false)" \
  --argjson resourceLimitsEnforced "$resource_limits" \
  --arg failureCategory "$failure_category" \
  '{
    assertions:{
      provenance:$provenance,
      runtimeFallback:$runtimeFallback,
      egressPolicy:$egressPolicy,
      credentialIsolation:$credentialIsolation,
      workspaceOnlyExposure:$workspaceOnlyExposure,
      concurrentIsolation:$concurrentIsolation,
      immutableArtifacts:$immutableArtifacts,
      boundedScratch:$boundedScratch,
      kvmAclRestoration:$kvmAclRestoration,
      residue:$residue
    },
    resourceLimitsEnforced:$resourceLimitsEnforced,
    failureCategory:$failureCategory
  }' > "$AWF_BENCHMARK_ASSERTIONS"
exit "$awf_status"
