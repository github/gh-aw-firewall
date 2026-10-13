#!/usr/bin/env bash
set -euo pipefail

runtime=${1:?runtime is required}
workload=${2:?workload is required}
sample_id=${3:?sample id is required}

: "${AWF_BENCHMARK_EVENTS:?AWF_BENCHMARK_EVENTS is required}"
: "${AWF_BENCHMARK_ASSERTIONS:?AWF_BENCHMARK_ASSERTIONS is required}"
: "${AWF_BENCHMARK_RESIDUE:?AWF_BENCHMARK_RESIDUE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"

case "$runtime" in
  nvx|cloud-hypervisor) ;;
  *) echo "unsupported runtime: $runtime" >&2; exit 2 ;;
esac
case "$workload" in
  build-test|copilot-inference) ;;
  *) echo "unsupported workload: $workload" >&2; exit 2 ;;
esac

now_ms() {
  date +%s%3N
}

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
    roots=(/run/awf-cloud-hypervisor)
  fi
  { sudo du -sb "${roots[@]}" 2>/dev/null || true; } |
    awk '{sum += $1} END {print sum + 0}'
}

sample_root="$RUNNER_TEMP/nvx-phase4-canary/$sample_id"
work_dir="$sample_root/awf"
workspace_dir="$GITHUB_WORKSPACE/.nvx-phase4-canary/$sample_id"
proxy_logs="$sample_root/api-proxy-logs"
guest_status="$workspace_dir/guest-status.json"
ready_marker="$workspace_dir/runtime-ready"
first_marker="$workspace_dir/first-work"
complete_marker="$workspace_dir/workload-complete"
awf_log="$sample_root/awf.log"
if [[ -e "$sample_root" || -e "$workspace_dir" ]]; then
  echo "cold-cache sample paths already exist" >&2
  exit 1
fi
mkdir -p "$sample_root" "$work_dir" "$proxy_logs" "$workspace_dir"
chmod 0700 "$sample_root" "$work_dir" "$proxy_logs" "$workspace_dir"

preflight_started=$(now_ms)
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test -c /dev/kvm
test -x dist/cli.js

kvm_acl_before=$(sudo getfacl --absolute-names --numeric /dev/kvm 2>/dev/null)
processes_before=$(runtime_process_snapshot)
netns_before=$(sudo ip netns list 2>/dev/null || true)
cgroups_before=$(sudo find /sys/fs/cgroup -maxdepth 4 -type d \
  \( -path '/sys/fs/cgroup/awf-nvx*' -o \
     -path '/sys/fs/cgroup/awf-cloud-hypervisor*' \) -print 2>/dev/null | sort)
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
    --nvx-signer-workflow github/gh-aw-firewall/.github/workflows/nvx-phase-4-canary.yml
    --nvx-memory-mib 4096
    --nvx-memory-max-bytes 4294967296
    --nvx-pids-max 256
    --nvx-scratch-bytes 2147483648
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
    --cloud-hypervisor-vcpus 1
    --cloud-hypervisor-memory-mib 4096
  )
fi

cat > "$workspace_dir/workload.sh" <<'EOF'
#!/bin/sh
set -eu
root=${AWF_PHASE4_CANARY_ROOT:?}
test "$(pwd)" = /workspace
printf '%s\n' ready > "$root/runtime-ready"
test ! -e /host
if env | grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)='; then
  exit 41
fi
if [ -n "${COPILOT_GITHUB_TOKEN:-}" ] && [ "$COPILOT_GITHUB_TOKEN" != "******" ]; then
  exit 42
fi
if [ -n "${COPILOT_TOKEN:-}" ] && [ "$COPILOT_TOKEN" != "******" ]; then
  exit 44
fi
if [ -n "${COPILOT_API_KEY:-}" ] &&
   [ "$COPILOT_API_KEY" != "dummy-byok-key-for-offline-mode" ]; then
  exit 45
fi
test -z "${COPILOT_PROVIDER_API_KEY:-}"
blocked=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://example.com 2>/dev/null || true)
blocked=${blocked:-000}
case "$blocked" in 000|403) ;; *) exit 43 ;; esac
guest_node_version=$(node --version)
guest_curl_version=$(curl --version | awk 'NR == 1 {print $1, $2}')
scratch_capacity=$(df -PB1 /tmp | awk 'NR == 2 {print $2}')
scratch_before_bytes=$(du -sb /tmp 2>/dev/null | awk '{print $1}')
scratch_before_bytes=${scratch_before_bytes:-0}
scratch_peak_bytes=$scratch_before_bytes
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
    node --check /tmp/phase4-build/build.js
    node /tmp/phase4-build/build.js > "$root/build-proof"
    grep -qx 499500 "$root/build-proof"
    test -s "$root/build-proof"
    scratch_peak_bytes=$(du -sb /tmp 2>/dev/null | awk '{print $1}')
    scratch_peak_bytes=${scratch_peak_bytes:-$scratch_before_bytes}
    ;;
  copilot-inference)
    : "${AWF_PHASE4_COPILOT_BIN:?}"
    runtime_home=/tmp/phase4-copilot-home
    mkdir -m 0700 "$runtime_home"
    HOME=$runtime_home; export HOME
    COPILOT_HOME=$runtime_home/.copilot; export COPILOT_HOME
    XDG_CACHE_HOME=$runtime_home/.cache; export XDG_CACHE_HOME
    XDG_CONFIG_HOME=$runtime_home/.config; export XDG_CONFIG_HOME
    XDG_STATE_HOME=$runtime_home/.local/state; export XDG_STATE_HOME
    : > "$root/copilot-proof"
    "$AWF_PHASE4_COPILOT_BIN" \
      --prompt "Respond with exactly PHASE4-CANARY-PROOF and nothing else." \
      --silent --no-color --stream on --allow-all-tools \
      --disable-builtin-mcps --no-custom-instructions --no-auto-update \
      --no-ask-user --model claude-sonnet-5 --max-ai-credits 30 \
      > "$root/copilot-proof" &
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
    grep -q 'PHASE4-CANARY-PROOF' "$root/copilot-proof"
    ;;
esac
scratch_after_bytes=$(du -sb /tmp 2>/dev/null | awk '{print $1}')
scratch_after_bytes=${scratch_after_bytes:-$scratch_before_bytes}
if [ "$scratch_after_bytes" -gt "$scratch_peak_bytes" ]; then
  scratch_peak_bytes=$scratch_after_bytes
fi
scratch_usage_bytes=$((scratch_peak_bytes - scratch_before_bytes))
if [ "$scratch_usage_bytes" -lt 0 ]; then scratch_usage_bytes=0; fi
jq -n \
  --arg nodeVersion "$guest_node_version" \
  --arg curlVersion "$guest_curl_version" \
  --argjson scratchCapacityBytes "$scratch_capacity" \
  --argjson scratchUsageBytes "$scratch_usage_bytes" \
  '{credentialIsolation:true,egressPolicy:true,workspaceOnlyExposure:true,
    nodeVersion:$nodeVersion,curlVersion:$curlVersion,
    scratchCapacityBytes:$scratchCapacityBytes,scratchUsageBytes:$scratchUsageBytes}' \
  > "$root/guest-status.json"
printf '%s\n' complete > "$root/workload-complete"
EOF
chmod 0755 "$workspace_dir/workload.sh"

copilot_host="$RUNNER_TEMP/gh-aw/bin/copilot"
if [ "$workload" = copilot-inference ]; then
  test -x "$copilot_host"
  cp "$copilot_host" "$workspace_dir/copilot"
  chmod 0555 "$workspace_dir/copilot"
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
    filesystem:{allowWrite:["/workspace/.nvx-phase4-canary"]},
    apiProxy:{enabled:true},
    logging:{proxyLogsDir:$proxy_logs}
  }' > "$config"

export AWF_PHASE4_CANARY_ROOT="/workspace/.nvx-phase4-canary/$sample_id"
export AWF_PHASE4_WORKLOAD="$workload"
export AWF_PHASE4_COPILOT_BIN="$AWF_PHASE4_CANARY_ROOT/copilot"
preflight_completed=

set +e
# The runner user owns awf_log; sudo is required only for the AWF process.
# shellcheck disable=SC2024
sudo --preserve-env=AWF_PHASE4_CANARY_ROOT,AWF_PHASE4_WORKLOAD,AWF_PHASE4_COPILOT_BIN,COPILOT_GITHUB_TOKEN \
  node dist/cli.js \
  --config "$config" \
  --work-dir "$work_dir" \
  --container-workdir /workspace \
  --enable-api-proxy \
  --image-tag v0.28.54 \
  --env "AWF_PHASE4_CANARY_ROOT=$AWF_PHASE4_CANARY_ROOT" \
  --env "AWF_PHASE4_WORKLOAD=$workload" \
  --env "AWF_PHASE4_COPILOT_BIN=$AWF_PHASE4_COPILOT_BIN" \
  --log-level debug \
  "${runtime_args[@]}" \
  -- "/bin/sh $AWF_PHASE4_CANARY_ROOT/workload.sh" \
  >"$awf_log" 2>&1 &
awf_pid=$!
set -e

deadline=$((SECONDS + 900))
runtime_ready=
first_work=
workload_completed=
observed_cgroup=
observed_memory_max=
observed_cpu_max=
observed_pids_max=
peak_host_disk_bytes=0
cpu_usage_micros=0
while kill -0 "$awf_pid" 2>/dev/null; do
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
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      if ! grep -Fxq "$candidate" <<<"$cgroups_before" &&
         [ -f "$candidate/memory.max" ] &&
         [ -f "$candidate/cpu.max" ] &&
         [ -f "$candidate/pids.max" ] &&
         [ -f "$candidate/cpu.stat" ]; then
        observed_cgroup=$candidate
        preflight_completed=$(now_ms)
        observed_memory_max=$(sudo cat "$candidate/memory.max")
        observed_cpu_max=$(sudo cat "$candidate/cpu.max")
        observed_pids_max=$(sudo cat "$candidate/pids.max")
        break
      fi
    done < <(sudo find /sys/fs/cgroup -maxdepth 4 -type d \
      \( -path '/sys/fs/cgroup/awf-nvx*' -o \
         -path '/sys/fs/cgroup/awf-cloud-hypervisor*' \) -print 2>/dev/null)
  fi
  if [ -n "$observed_cgroup" ] && [ -f "$observed_cgroup/cpu.stat" ]; then
    current_cpu_micros=$(sudo awk '$1 == "usage_usec" { print $2 }' \
         "$observed_cgroup/cpu.stat")
    if [[ "$current_cpu_micros" =~ ^[0-9]+$ ]] &&
          [ "$current_cpu_micros" -gt "$cpu_usage_micros" ]; then
         cpu_usage_micros=$current_cpu_micros
    fi
  fi
  if [ -z "$runtime_ready" ] && [ -f "$ready_marker" ]; then
    runtime_ready=$(now_ms)
  fi
  if [ -z "$first_work" ] && [ -f "$first_marker" ]; then
    first_work=$(now_ms)
  fi
  if [ -z "$workload_completed" ] && [ -f "$complete_marker" ]; then
    workload_completed=$(now_ms)
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    sudo kill -TERM "$awf_pid" 2>/dev/null || true
    break
  fi
  sleep 0.1
done
set +e
wait "$awf_pid"
awf_status=$?
set -e
cleanup_completed=$(now_ms)

runtime_ready=${runtime_ready:-0}
first_work=${first_work:-0}
workload_completed=${workload_completed:-0}
preflight_completed=${preflight_completed:-0}
scratch_bytes=0
guest_node_version=
guest_curl_version=
if [ -s "$guest_status" ]; then
  scratch_bytes=$(jq -er '.scratchUsageBytes' "$guest_status")
  guest_node_version=$(jq -er '.nodeVersion' "$guest_status")
  guest_curl_version=$(jq -er '.curlVersion' "$guest_status")
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
  --arg cachePreparation "cold-cache-flushed" \
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
processes_after=$(runtime_process_snapshot)
netns_after=$(sudo ip netns list 2>/dev/null || true)
cgroups_after=$(sudo find /sys/fs/cgroup -maxdepth 4 -type d \
  \( -path '/sys/fs/cgroup/awf-nvx*' -o \
     -path '/sys/fs/cgroup/awf-cloud-hypervisor*' \) -print 2>/dev/null | sort)
mounts_after=$(findmnt -rn -o TARGET 2>/dev/null | grep -E 'awf-(nvx|cloud-hypervisor)' || true)
[ "$processes_before" = "$processes_after" ] || residue+=("runtime-process")
[ "$netns_before" = "$netns_after" ] || residue+=("network-namespace")
[ "$cgroups_before" = "$cgroups_after" ] || residue+=("cgroup")
[ "$mounts_before" = "$mounts_after" ] || residue+=("mount")
test ! -e "$work_dir" || residue+=("run-directory:$work_dir")
kvm_acl_after=$(sudo getfacl --absolute-names --numeric /dev/kvm 2>/dev/null)
kvm_restored=false
if [ "$kvm_acl_before" = "$kvm_acl_after" ]; then kvm_restored=true; fi
guest_ok=false
egress=false
credential=false
workspace=false
bounded_scratch=false
if [ -s "$guest_status" ]; then
  guest_ok=true
  egress=$(jq -r '.egressPolicy == true' "$guest_status")
  credential=$(jq -r '.credentialIsolation == true' "$guest_status")
  workspace=$(jq -r '.workspaceOnlyExposure == true' "$guest_status")
  scratch_capacity=$(jq -er '.scratchCapacityBytes' "$guest_status")
  if [ "$scratch_capacity" -le 2147483648 ]; then bounded_scratch=true; fi
fi
runtime_selected_no_fallback=false
if { [ "$runtime" = nvx ] && grep -Fq "[nvx] Agent command exited" "$awf_log"; } ||
   { [ "$runtime" = cloud-hypervisor ] &&
     grep -Fq "[cloud-hypervisor] runtime=cloud-hypervisor maturity=preview fallback=disabled" \
       "$awf_log"; }; then
  runtime_selected_no_fallback=true
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
if [ -n "$observed_cgroup" ] && [ "$observed_pids_max" = 256 ]; then
  read -r cpu_quota cpu_period <<<"$observed_cpu_max"
  if [ "$observed_memory_max" = 4563402752 ] &&
     [ "$cpu_period" = 100000 ] &&
     [ "$cpu_quota" = 200000 ]; then
    resource_limits=true
  fi
fi

raw_evidence_dir="$(dirname "$AWF_BENCHMARK_EVENTS")/runtime-$sample_id"
mkdir "$raw_evidence_dir"
chmod 0700 "$raw_evidence_dir"
cp --no-clobber "$awf_log" "$raw_evidence_dir/awf.log"
if [ -s "$guest_status" ]; then
  cp --no-clobber "$guest_status" "$raw_evidence_dir/guest-status.json"
fi
for proof in build-proof copilot-proof; do
  if [ -s "$workspace_dir/$proof" ]; then
    cp --no-clobber "$workspace_dir/$proof" "$raw_evidence_dir/$proof"
  fi
done
token_log=$(find "$proxy_logs" -name token-usage.jsonl -type f -print -quit)
if [ -n "$token_log" ] && [ -n "${AWF_PHASE4_TOKEN_USAGE_OUTPUT:-}" ]; then
  cp --no-clobber "$token_log" "$AWF_PHASE4_TOKEN_USAGE_OUTPUT"
fi
token_tracker_audit=$(find "$proxy_logs" -name token-tracker-audit.jsonl -type f -print -quit)
if [ -n "$token_tracker_audit" ] &&
   [ -n "${AWF_PHASE4_TOKEN_TRACKER_AUDIT_OUTPUT:-}" ]; then
  cp --no-clobber "$token_tracker_audit" "$AWF_PHASE4_TOKEN_TRACKER_AUDIT_OUTPUT"
fi
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
   [ "$runtime_selected_no_fallback" = true ] && [ "$immutable_artifacts" = true ] &&
   [ "$bounded_scratch" = true ] && [ "$resource_limits" = true ] &&
   [ "$kvm_restored" = true ] && [ "${#residue[@]}" -eq 0 ]; then
  failure_category=success
fi
jq -n \
  --argjson provenance "$([ -n "$observed_cgroup" ] && echo true || echo false)" \
  --argjson runtimeFallback "$runtime_selected_no_fallback" \
  --argjson egressPolicy "$egress" \
  --argjson credentialIsolation "$credential" \
  --argjson workspaceOnlyExposure "$workspace" \
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
      immutableArtifacts:$immutableArtifacts,
      boundedScratch:$boundedScratch,
      kvmAclRestoration:$kvmAclRestoration,
      residue:$residue
    },
    resourceLimitsEnforced:$resourceLimitsEnforced,
    failureCategory:$failureCategory
  }' > "$AWF_BENCHMARK_ASSERTIONS"
exit "$awf_status"
