#!/usr/bin/env bash
set -euo pipefail

runtime=${1:?runtime is required}
kind=${2:?recovery kind is required}
sample_id=${3:?sample id is required}

: "${AWF_BENCHMARK_RECOVERY_EVIDENCE:?recovery evidence path is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"

case "$runtime" in nvx|cloud-hypervisor) ;; *) exit 2 ;; esac
case "$kind" in cancellation|stale-recovery) ;; *) exit 2 ;; esac

# shellcheck source=scripts/ci/nvx-phase4-runtime-checks.sh
source "$(dirname "${BASH_SOURCE[0]}")/nvx-phase4-runtime-checks.sh"

root="$RUNNER_TEMP/nvx-phase4-recovery/$sample_id"
work="$root/work"
config="$root/config.json"
workspace="$GITHUB_WORKSPACE/.nvx-phase4-recovery/$sample_id"
guest_status="$workspace/guest-status.json"
ready_marker="$workspace/runtime-ready"
measurement_name=$(basename "${AWF_BENCHMARK_RECOVERY_EVIDENCE%.json}")
diagnostics_dir="$(dirname "$AWF_BENCHMARK_RECOVERY_EVIDENCE")/runtime-$measurement_name"
mkdir -p "$root" "$workspace"
mkdir -p "$diagnostics_dir"
mkdir -p "$work"
chmod 0700 "$root" "$work" "$workspace" "$diagnostics_dir"

cat > "$workspace/workload.sh" <<'EOF'
#!/bin/sh
set -eu
root=${AWF_PHASE4_RECOVERY_ROOT:?}
test "$(pwd)" = /workspace
if awk '$5 == "/host" { found = 1 } END { exit !found }' /proc/self/mountinfo; then
  exit 40
fi
if env | grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)='; then
  exit 41
fi
blocked=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://example.com 2>/dev/null || true)
blocked=${blocked:-000}
case "$blocked" in 000|403) ;; *) exit 42 ;; esac
scratch_capacity=$(df -Pk /tmp | awk 'NR == 2 {print $2 * 1024}')
node_version=$("$AWF_PHASE4_NODE_BIN" --version)
curl_version=$(curl --version | sed -n '1p')
printf '{"credentialIsolation":true,"egressPolicy":true,"workspaceOnlyExposure":true,"scratchCapacityBytes":%s,"guestTools":{"node":"%s","curl":"%s"}}\n' \
  "$scratch_capacity" "$node_version" "$curl_version" > "$root/guest-status.json"
printf '%s\n' ready > "$root/runtime-ready"
sleep 300
EOF
chmod 0755 "$workspace/workload.sh"

if [ "$runtime" = nvx ]; then
  node_guest=node
else
  node_host=$(command -v node)
  test -x "$node_host"
  cp "$node_host" "$workspace/node"
  chmod 0555 "$workspace/node"
  node_guest="/workspace/.nvx-phase4-recovery/$sample_id/node"
fi

snapshot_processes() {
  {
    sudo pgrep -a -x openvmm 2>/dev/null || true
    sudo pgrep -a -x virtiofsd 2>/dev/null || true
    sudo pgrep -af '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[c]loud-hypervisor --api-socket' \
      2>/dev/null || true
  } | sort
}
snapshot_mounts() {
  findmnt -rn -o TARGET 2>/dev/null | grep -E 'awf-(nvx|cloud-hypervisor)' | sort || true
}
snapshot_netns() {
  sudo ip netns list 2>/dev/null | sort || true
}
snapshot_cgroups() {
  sudo find /sys/fs/cgroup -maxdepth 4 -type d \
    \( -path '/sys/fs/cgroup/awf-nvx*' -o -path '/sys/fs/cgroup/awf-cloud-hypervisor*' \) \
    ! -path '/sys/fs/cgroup/awf-nvx' \
    ! -path '/sys/fs/cgroup/awf-cloud-hypervisor' -print 2>/dev/null | sort
}
normalize_acl() {
  if grep -Eq '^(user|group):[^:]' <<<"$1"; then printf '%s\n' "$1"; else
    grep -v '^mask::' <<<"$1"
  fi
}

processes_before=$(snapshot_processes)
mounts_before=$(snapshot_mounts)
netns_before=$(snapshot_netns)
cgroups_before=$(snapshot_cgroups)
cleanup_before=$(runtime_storage_snapshot "$runtime" cleanup)
runs_before=$(runtime_storage_snapshot "$runtime" run)
scratch_before=$(runtime_storage_snapshot "$runtime" scratch)
snapshots_before=$(runtime_storage_snapshot "$runtime" snapshot)
if [ -n "${AWF_PHASE4_KVM_RUNTIME_ACL_BASELINE:-}" ]; then
  kvm_before=$(sudo cat "$AWF_PHASE4_KVM_RUNTIME_ACL_BASELINE")
else
  kvm_before=$(sudo getfacl --absolute-names --numeric /dev/kvm 2>/dev/null)
fi

jq -n '{
  network:{allowDomains:[],isolation:true},
  filesystem:{allowWrite:["/workspace/.nvx-phase4-recovery"]},
  apiProxy:{enabled:false}
}' > "$config"

runtime_args=()
cleanup_root=
if [ "$runtime" = nvx ]; then
  : "${NVX_OPENVMM:?}" "${NVX_KERNEL:?}" "${NVX_INITRAMFS:?}" "${NVX_LAYER:?}"
  : "${NVX_MANIFEST:?}" "${NVX_MANIFEST_BUNDLE:?}"
  cleanup_root=/var/lib/awf-nvx/cleanup
  runtime_args=(
    --container-runtime nvx --nvx-preview --nvx-mount-policy workspace-only
    --nvx-layer "$NVX_LAYER" --nvx-openvmm "$NVX_OPENVMM"
    --nvx-kernel "$NVX_KERNEL" --nvx-initramfs "$NVX_INITRAMFS"
    --nvx-artifact-manifest "$NVX_MANIFEST"
    --nvx-artifact-manifest-bundle "$NVX_MANIFEST_BUNDLE"
    --nvx-signer-workflow github/gh-aw-firewall/.github/workflows/nvx-phase-4-benchmark.yml
    --nvx-memory-mib 4096 --nvx-memory-max-bytes 4294967296
    --nvx-pids-max 256 --nvx-scratch-bytes 2147483648
  )
else
  : "${GH_AW_CLOUD_HYPERVISOR_BINARY:?}" "${GH_AW_CLOUD_HYPERVISOR_KERNEL:?}"
  : "${GH_AW_CLOUD_HYPERVISOR_ROOTFS:?}" "${GH_AW_CLOUD_HYPERVISOR_SUPERVISOR:?}"
  : "${GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST:?}"
  : "${GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST_BUNDLE:?}"
  cleanup_root=/run/awf-cloud-hypervisor/pending-cleanup
  runtime_args=(
    --container-runtime cloud-hypervisor --cloud-hypervisor-preview
    --cloud-hypervisor-mount-policy workspace-only
    --cloud-hypervisor-binary "$GH_AW_CLOUD_HYPERVISOR_BINARY"
    --cloud-hypervisor-kernel "$GH_AW_CLOUD_HYPERVISOR_KERNEL"
    --cloud-hypervisor-rootfs "$GH_AW_CLOUD_HYPERVISOR_ROOTFS"
    --cloud-hypervisor-supervisor "$GH_AW_CLOUD_HYPERVISOR_SUPERVISOR"
    --cloud-hypervisor-artifact-manifest "$GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST"
    --cloud-hypervisor-artifact-manifest-bundle \
      "$GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST_BUNDLE"
    --cloud-hypervisor-artifact-release-tag v0.28.54
    --cloud-hypervisor-vcpus 2 --cloud-hypervisor-memory-mib 4096
    --cloud-hypervisor-scratch-mib 2048
  )
fi

run_awf() {
  local command=$1
  sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,ImageOS,AWF_PHASE4_RECOVERY_ROOT \
    node dist/cli.js --config "$config" --work-dir "$work" \
    --container-workdir /workspace \
    --env "AWF_PHASE4_RECOVERY_ROOT=$AWF_PHASE4_RECOVERY_ROOT" \
    --env "AWF_PHASE4_NODE_BIN=$node_guest" \
    --image-tag \
    "0.28.54,squid=sha256:960930db796d005e63153b9ffd984b58ebda1ed8c26800c09eb7515dc94237db,agent=sha256:fc4f3d07d9f0479aa76d4a6d55f36735c29e0558f10a413fbd36e3d00b34a830,api-proxy=sha256:f8dff30ac37a8987b564f2872796a9c093b3ab281b1cdfc3493c1ea5fa84ff79" \
    --log-level debug "${runtime_args[@]}" -- "$command"
}

export AWF_PHASE4_RECOVERY_ROOT="/workspace/.nvx-phase4-recovery/$sample_id"
started_ms=$(date +%s%3N)
run_awf "/bin/sh $AWF_PHASE4_RECOVERY_ROOT/workload.sh" >"$root/first.log" 2>&1 &
launcher_pid=$!
manager_pid=
manager_start_time=
readiness=false
cleanup_record=
cleanup_record_identity_valid=false
runtime_process_observed=false
for _ in $(seq 1 600); do
  if ! kill -0 "$launcher_pid" 2>/dev/null; then break; fi
  cleanup_identity=$(awf_cleanup_identity "$runtime" "$cleanup_root" || true)
  if [ -n "$cleanup_identity" ]; then
    IFS=$'\t' read -r cleanup_record manager_pid manager_start_time <<< "$cleanup_identity"
  fi
  if [ -f "$ready_marker" ] && [ -s "$guest_status" ] && [ -n "$cleanup_record" ]; then
    if awf_cleanup_identity_valid "$runtime" "$cleanup_record" "$cleanup_root" \
      "$manager_pid" "$manager_start_time"; then
      cleanup_record_identity_valid=true
      runtime_process_observed=true
      readiness=true
      break
    fi
  fi
  sleep 0.1
done

manager_killed_after_record=false
terminal_observed=false
set +e
current_cleanup_identity=$(awf_cleanup_identity "$runtime" "$cleanup_root" || true)
if [ -n "$manager_pid" ] &&
  [ "$current_cleanup_identity" = "$cleanup_record"$'\t'"$manager_pid"$'\t'"$manager_start_time" ]; then
  if [ "$kind" = stale-recovery ] && [ "$cleanup_record_identity_valid" = true ] &&
    awf_cleanup_identity_valid "$runtime" "$cleanup_record" "$cleanup_root" \
      "$manager_pid" "$manager_start_time"; then
    if sudo kill -KILL "$manager_pid" 2>/dev/null; then
      manager_killed_after_record=true
    fi
  else
    sudo kill -TERM "$manager_pid" 2>/dev/null
  fi
fi
wait "$launcher_pid"
first_status=$?
if [ -n "$manager_pid" ]; then
  for _ in $(seq 1 100); do
    awf_manager_alive "$manager_pid" "$manager_start_time"
    alive_status=$?
    if [ "$alive_status" -eq 1 ]; then terminal_observed=true; break; fi
    if [ "$alive_status" -ne 0 ]; then break; fi
    sleep 0.1
  done
fi
if [ "$terminal_observed" != true ]; then manager_killed_after_record=false; fi
set -e

workload_after_recovery=false
if [ "$kind" = stale-recovery ] && [ "$terminal_observed" = true ] &&
  [ "$manager_killed_after_record" = true ]; then
  sudo rm -rf -- "$work"
  mkdir -p "$work"
  chmod 0700 "$work"
  set +e
  run_awf 'true' >"$root/recovery.log" 2>&1
  recovery_status=$?
  set -e
  if [ "$recovery_status" -eq 0 ]; then workload_after_recovery=true; fi
fi

if [ -f "$root/first.log" ]; then
  cp --no-clobber "$root/first.log" "$diagnostics_dir/first.log"
fi
if [ -f "$root/recovery.log" ]; then
  cp --no-clobber "$root/recovery.log" "$diagnostics_dir/recovery.log"
fi
if [ -s "$guest_status" ]; then
  cp --no-clobber "$guest_status" "$diagnostics_dir/guest-status.json"
fi
jq -n \
  --arg runtime "$runtime" \
  --arg kind "$kind" \
  --arg managerPid "$manager_pid" \
  --arg managerStartTime "$manager_start_time" \
  --arg cleanupRecord "$(basename "${cleanup_record:-}")" \
  --argjson cleanupRecordIdentityValid "$cleanup_record_identity_valid" \
  --argjson readyMarker "$([ -f "$ready_marker" ] && echo true || echo false)" \
  --argjson guestStatus "$([ -s "$guest_status" ] && echo true || echo false)" \
  --argjson runtimeProcessObserved "$runtime_process_observed" \
  --argjson readinessConfirmed "$readiness" \
  --argjson terminalObserved "$terminal_observed" \
  --argjson managerKilledAfterCleanupRecord "$manager_killed_after_record" \
  --argjson workloadAfterRecovery "$workload_after_recovery" \
  '{
    runtime:$runtime,kind:$kind,
    manager:{pid:$managerPid,startTime:$managerStartTime},
    cleanupRecord:{name:$cleanupRecord,identityValid:$cleanupRecordIdentityValid},
    observed:{
      readyMarker:$readyMarker,guestStatus:$guestStatus,
      runtimeProcess:$runtimeProcessObserved,readiness:$readinessConfirmed,
      terminal:$terminalObserved,managerKilledAfterCleanupRecord:$managerKilledAfterCleanupRecord,
      workloadAfterRecovery:$workloadAfterRecovery
    }
  }' > "$diagnostics_dir/readiness.json"
chmod 0600 "$diagnostics_dir"/*

guest_egress=false
guest_credential=false
guest_workspace=false
bounded_scratch=false
guest_tools_json=null
if [ -s "$guest_status" ]; then
  guest_egress=$(jq -r '.egressPolicy == true' "$guest_status")
  guest_credential=$(jq -r '.credentialIsolation == true' "$guest_status")
  guest_workspace=$(jq -r '.workspaceOnlyExposure == true' "$guest_status")
  scratch_capacity=$(jq -er '.scratchCapacityBytes' "$guest_status")
  if [ "$scratch_capacity" -gt 0 ] && [ "$scratch_capacity" -le 2147483648 ]; then
    bounded_scratch=true
  fi
  guest_tools_json=$(jq -c '.guestTools // null' "$guest_status")
fi
runtime_no_fallback=false
if { [ "$runtime" = nvx ] && [ "$readiness" = true ] &&
     [ "$cleanup_record_identity_valid" = true ]; } ||
  { [ "$runtime" = cloud-hypervisor ] &&
    grep -Fq "[cloud-hypervisor] runtime=cloud-hypervisor maturity=preview fallback=disabled" \
      "$root/first.log"; }; then
  runtime_no_fallback=true
fi
immutable_artifacts=true
if [ "$runtime" = nvx ]; then
  artifacts=("$NVX_OPENVMM" "$NVX_KERNEL" "$NVX_INITRAMFS" "$NVX_MANIFEST" "$NVX_MANIFEST_BUNDLE")
else
  artifacts=(
    "$GH_AW_CLOUD_HYPERVISOR_BINARY" "$GH_AW_CLOUD_HYPERVISOR_KERNEL"
    "$GH_AW_CLOUD_HYPERVISOR_ROOTFS" "$GH_AW_CLOUD_HYPERVISOR_SUPERVISOR"
    "$GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST"
    "$GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST_BUNDLE"
  )
fi
for artifact in "${artifacts[@]}"; do
  if [ ! -f "$artifact" ] || [ "$(stat -c %u "$artifact")" != 0 ] ||
    [ "$((8#$(stat -c %a "$artifact") & 8#022))" != 0 ]; then
    immutable_artifacts=false
  fi
done

for _ in $(seq 1 100); do
  processes_after=$(snapshot_processes)
  mounts_after=$(snapshot_mounts)
  netns_after=$(snapshot_netns)
  cgroups_after=$(snapshot_cgroups)
  cleanup_after=$(runtime_storage_snapshot "$runtime" cleanup)
  runs_after=$(runtime_storage_snapshot "$runtime" run)
  scratch_after=$(runtime_storage_snapshot "$runtime" scratch)
  snapshots_after=$(runtime_storage_snapshot "$runtime" snapshot)
  kvm_after=$(sudo getfacl --absolute-names --numeric /dev/kvm 2>/dev/null)
  if [ "$processes_before" = "$processes_after" ] &&
    [ "$mounts_before" = "$mounts_after" ] &&
    [ "$netns_before" = "$netns_after" ] &&
    [ "$cgroups_before" = "$cgroups_after" ] &&
    [ "$cleanup_before" = "$cleanup_after" ] &&
    [ "$runs_before" = "$runs_after" ] &&
    [ "$scratch_before" = "$scratch_after" ] &&
    [ "$snapshots_before" = "$snapshots_after" ]; then
    break
  fi
  sleep 0.1
done
ended_ms=$(date +%s%3N)

process_tree_gone=$([ "$processes_before" = "$processes_after" ] && echo true || echo false)
mounts_restored=$([ "$mounts_before" = "$mounts_after" ] && echo true || echo false)
namespaces_restored=$([ "$netns_before" = "$netns_after" ] && echo true || echo false)
cgroups_restored=$([ "$cgroups_before" = "$cgroups_after" ] && echo true || echo false)
cleanup_removed=$([ "$cleanup_before" = "$cleanup_after" ] && echo true || echo false)
kvm_restored=$(
  [ "$(normalize_acl "$kvm_before")" = "$(normalize_acl "$kvm_after")" ] &&
    echo true || echo false
)
run_removed=$([ ! -e "$work" ] && [ "$runs_before" = "$runs_after" ] && echo true || echo false)
scratch_removed=$([ "$scratch_before" = "$scratch_after" ] && echo true || echo false)
snapshot_removed=$([ "$snapshots_before" = "$snapshots_after" ] && echo true || echo false)
identity_checked=false
if [ "$kind" = stale-recovery ] && [ "$cleanup_record_identity_valid" = true ] &&
  [ "$manager_killed_after_record" = true ] && [ "$terminal_observed" = true ] &&
  [ "$cleanup_removed" = true ] && [ "$workload_after_recovery" = true ]; then
  identity_checked=true
fi

residue=()
[ "$process_tree_gone" = true ] || residue+=("runtime-process")
[ "$mounts_restored" = true ] || residue+=("mount")
[ "$namespaces_restored" = true ] || residue+=("network-namespace")
[ "$cgroups_restored" = true ] || residue+=("cgroup")
[ "$cleanup_removed" = true ] || residue+=("cleanup-record")
[ "$kvm_restored" = true ] || residue+=("kvm-acl")
[ "$run_removed" = true ] || residue+=("run-directory")
[ "$scratch_removed" = true ] || residue+=("scratch")
[ "$snapshot_removed" = true ] || residue+=("trusted-artifact-snapshot")
rm -rf -- "$workspace"
[ ! -e "$workspace" ] || residue+=("workspace-staging")

success=false
if [ "$readiness" = true ] && [ "$terminal_observed" = true ] &&
  [ "$cleanup_record_identity_valid" = true ] &&
  [ "$guest_egress" = true ] && [ "$guest_credential" = true ] &&
  [ "$guest_workspace" = true ] && [ "$runtime_no_fallback" = true ] &&
  [ "$immutable_artifacts" = true ] && [ "$bounded_scratch" = true ] &&
  [ "${#residue[@]}" -eq 0 ]; then
  if [ "$kind" = cancellation ] && [ "$first_status" -ne 0 ]; then success=true; fi
  if [ "$kind" = stale-recovery ] && [ "$manager_killed_after_record" = true ] &&
    [ "$workload_after_recovery" = true ] && [ "$identity_checked" = true ]; then success=true; fi
fi
failure_category=workload-failure
[ "$success" = true ] && failure_category=success
if [ "$success" = false ] && [ "$guest_egress" = true ] &&
  [ "$guest_credential" = true ] && [ "$guest_workspace" = true ] &&
  [ "$runtime_no_fallback" = true ] && [ "$immutable_artifacts" = true ] &&
  [ "$bounded_scratch" = true ] && [ "${#residue[@]}" -eq 0 ] &&
  grep -Eqi 'EAI_AGAIN|ENETUNREACH|ETIMEDOUT|ECONNRESET|upstream[^[:alnum:]]+(502|503)|HTTP[^[:alnum:]]+(502|503)' \
    "$root/first.log"; then
  failure_category=network-infrastructure
fi
if [ "$cleanup_record_identity_valid" != true ] ||
  { [ "$kind" = stale-recovery ] && [ "$identity_checked" != true ]; }; then
  failure_category=provenance
fi

if [ "${#residue[@]}" -eq 0 ]; then residue_json='[]'; else
  residue_json=$(printf '%s\n' "${residue[@]}" | jq -R . | jq -s .)
fi
jq -n \
  --argjson durationMs "$((ended_ms - started_ms))" \
  --arg kind "$kind" \
  --argjson success "$success" \
  --arg failureCategory "$failure_category" \
  --argjson residue "$residue_json" \
  --argjson readinessConfirmed "$readiness" \
  --argjson terminalObserved "$terminal_observed" \
  --argjson managerKilledAfterCleanupRecord "$manager_killed_after_record" \
  --argjson workloadAfterRecovery "$workload_after_recovery" \
  --argjson guestTools "$guest_tools_json" \
  --argjson processTreeGone "$process_tree_gone" \
  --argjson mountsRestored "$mounts_restored" \
  --argjson namespacesRestored "$namespaces_restored" \
  --argjson cgroupsRestored "$cgroups_restored" \
  --argjson runDirectoryRemoved "$run_removed" \
  --argjson scratchRemoved "$scratch_removed" \
  --argjson snapshotRemoved "$snapshot_removed" \
  --argjson cleanupRecordRemoved "$cleanup_removed" \
  --argjson kvmAclRestored "$kvm_restored" \
  --argjson identityCheckedCleanup "$identity_checked" \
  --argjson provenance "$cleanup_record_identity_valid" \
  --argjson runtimeFallback "$runtime_no_fallback" \
  --argjson egressPolicy "$guest_egress" \
  --argjson credentialIsolation "$guest_credential" \
  --argjson workspaceOnlyExposure "$guest_workspace" \
  --argjson immutableArtifacts "$immutable_artifacts" \
  --argjson boundedScratch "$bounded_scratch" \
  '{
    durationMs:$durationMs,success:$success,failureCategory:$failureCategory,
    assertionFailures:[],residue:$residue,
    readinessConfirmed:$readinessConfirmed,terminalObserved:$terminalObserved,
    managerKilledAfterCleanupRecord:$managerKilledAfterCleanupRecord,
    workloadAfterRecovery:$workloadAfterRecovery,guestTools:$guestTools,
    assertions:{
      provenance:$provenance,runtimeFallback:$runtimeFallback,egressPolicy:$egressPolicy,
      credentialIsolation:$credentialIsolation,workspaceOnlyExposure:$workspaceOnlyExposure,
      immutableArtifacts:$immutableArtifacts,boundedScratch:$boundedScratch,
      kvmAclRestoration:$kvmAclRestored,
      residue:($residue | length == 0),
      processTreeGone:$processTreeGone,mountsRestored:$mountsRestored,
      namespacesRestored:$namespacesRestored,cgroupsRestored:$cgroupsRestored,
      runDirectoryRemoved:$runDirectoryRemoved,scratchRemoved:$scratchRemoved,
      snapshotRemoved:$snapshotRemoved,cleanupRecordRemoved:$cleanupRecordRemoved,
      kvmAclRestored:$kvmAclRestored,
      identityCheckedCleanup:$identityCheckedCleanup
    }
  } | if $kind == "cancellation"
    then del(.assertions.identityCheckedCleanup) else . end' \
  > "$AWF_BENCHMARK_RECOVERY_EVIDENCE"

[ "$success" = true ]
