#!/usr/bin/env bash
set -euo pipefail

# Fail-closed CI host preflight for the Cloud Hypervisor live-KVM job.
#
# Checks Linux/x86_64, /dev/kvm, kernel controls, cgroup hierarchy, required
# host tools, Docker, and artifact digests. Two backend-specific requirements:
#   1. GitHub-hosted-only host eligibility is enforced here too (this
#      backend rejects self-hosted runners; see
#      src/cloud-hypervisor/host-eligibility.ts), so a misconfigured
#      self-hosted runner fails fast in CI instead of failing later inside
#      the CLI.
#   2. `setpriv` is required (the launcher's jailer replacement — see
#      src/cloud-hypervisor/launcher.ts) and there is no jailer binary to
#      version-check.

ARTIFACT_DIR=${1:?usage: cloud-hypervisor-host-preflight.sh ARTIFACT_DIR}

fail() {
  echo "::error title=Cloud Hypervisor host preflight::$*" >&2
  exit 1
}

require_regular_file() {
  local file=$1
  local label=$2
  [ -f "$file" ] && [ ! -L "$file" ] \
    || fail "$label is missing or is not a regular file: $file"
}

[ "$(uname -s)" = Linux ] || fail "Linux is required; macOS and Windows are unsupported."
[ "$(uname -m)" = x86_64 ] || fail "This CI artifact set requires an x86_64 host."

# GitHub-hosted-only host eligibility (mirrors
# src/cloud-hypervisor/host-eligibility.ts::evaluateGithubHostedRunnerEligibility).
[ "${GITHUB_ACTIONS:-}" = true ] \
  || fail "Cloud Hypervisor is supported only inside GitHub Actions runs (GITHUB_ACTIONS != \"true\")."
[ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] \
  || fail "Cloud Hypervisor is supported only on GitHub-hosted runners, not self-hosted (RUNNER_ENVIRONMENT=${RUNNER_ENVIRONMENT:-unset})."
case "${ImageOS:-}" in
  ubuntu*) : ;;
  *) fail "Cloud Hypervisor requires a GitHub-hosted Ubuntu runner image (ImageOS=${ImageOS:-unset})." ;;
esac

[ -c /dev/kvm ] || fail "/dev/kvm is missing; use a KVM-capable host."
sudo -n test -r /dev/kvm -a -w /dev/kvm \
  || fail "/dev/kvm must be readable and writable by the privileged AWF orchestrator."

for control in \
  /proc/sys/net/ipv4/ip_forward \
  /proc/sys/net/ipv6/conf/all/disable_ipv6 \
  /proc/sys/kernel/seccomp/actions_avail; do
  [ -r "$control" ] || fail "Required host kernel control is unavailable: $control"
done
[ -r /sys/fs/cgroup/cgroup.controllers ] || [ -w /sys/fs/cgroup ] \
  || fail "A usable cgroup v1 or v2 hierarchy is required to bound the Cloud Hypervisor process."

for tool in nft ip sysctl mke2fs debugfs e2fsck rsync mount umount setpriv docker sha256sum stat jq timeout curl; do
  command -v "$tool" >/dev/null || fail "Required host tool is missing: $tool"
done
command -v sudo >/dev/null || fail "Passwordless sudo is required for the netns-join/privilege-drop launcher."
sudo -n true || fail "Passwordless sudo is required for the netns-join/privilege-drop launcher."
docker info >/dev/null || fail "A host-visible Docker Engine is required."
docker compose version >/dev/null || fail "Docker Compose v2 is required."

# Kernel LSM support for Landlock, the filesystem-confinement boundary the
# launcher relies on in place of a jailer chroot (see
# src/cloud-hypervisor/launcher.ts).
if [ -r /sys/kernel/security/lsm ]; then
  grep -Fq landlock /sys/kernel/security/lsm \
    || fail "The running kernel does not report Landlock in /sys/kernel/security/lsm."
else
  fail "/sys/kernel/security/lsm is unavailable; cannot confirm Landlock LSM support."
fi

"$ARTIFACT_DIR/cloud-hypervisor" --version | grep -Fq '53.0' \
  || fail "Cloud Hypervisor v53.0 is required."
[ -f "$ARTIFACT_DIR/virtiofsd" ] && [ ! -L "$ARTIFACT_DIR/virtiofsd" ] \
  && [ -x "$ARTIFACT_DIR/virtiofsd" ] \
  || fail "A regular executable sibling virtiofsd artifact is required."
virtiofsd_mode=$(stat -c '%a' "$ARTIFACT_DIR/virtiofsd")
(( (8#$virtiofsd_mode & 8#022) == 0 )) \
  || fail "virtiofsd must not be group- or world-writable."
virtiofsd_uid=$(stat -c '%u' "$ARTIFACT_DIR/virtiofsd")
[ "$virtiofsd_uid" -eq 0 ] || [ "$virtiofsd_uid" -eq "$(id -u)" ] \
  || fail "virtiofsd must be owned by root or the workflow operator."
"$ARTIFACT_DIR/virtiofsd" --version 2>&1 | grep -Eq '(^| )1\.13\.3($| )' \
  || fail "virtiofsd v1.13.3 is required."
(
  cd "$ARTIFACT_DIR"
  sha256sum --check --strict SHA256SUMS
) || fail "Artifact digest verification failed."

require_regular_file "$ARTIFACT_DIR/enclave-manifest.json" \
  "Cloud Hypervisor enclave artifact manifest"
require_regular_file "$ARTIFACT_DIR/enclave-rootfs.SHA256SUMS" \
  "Cloud Hypervisor enclave checksum set"
(
  cd "$ARTIFACT_DIR"
  sha256sum --check --strict enclave-rootfs.SHA256SUMS
) || fail "Enclave rootfs digest verification failed."

test "$(jq -r '.artifactType' "$ARTIFACT_DIR/enclave-manifest.json")" = \
  awf-cloud-hypervisor-enclave-rootfs-set \
  || fail "Cloud Hypervisor enclave artifact manifest type is invalid."
test "$(jq -r '.architecture' "$ARTIFACT_DIR/enclave-manifest.json")" = x86_64 \
  || fail "Cloud Hypervisor enclave artifact architecture is invalid."
test "$(jq -r '.compatibility.cloudHypervisorVersion' "$ARTIFACT_DIR/enclave-manifest.json")" = 53.0 \
  || fail "Cloud Hypervisor enclave rootfs compatibility version is invalid."

rootfs_name=enclave-rootfs.ext4
rootfs="$ARTIFACT_DIR/$rootfs_name"
require_regular_file "$rootfs" "Cloud Hypervisor shared enclave rootfs"
rootfs_sha256=$(sha256sum "$rootfs" | awk '{print $1}')
rootfs_size=$(stat -c '%s' "$rootfs")
jq -e --arg file "$rootfs_name" --arg sha256 "$rootfs_sha256" \
  --argjson size "$rootfs_size" '
  def valid_identity:
    .file == $file and .sha256 == $sha256 and .sizeBytes == $size
    and .uid == 65534 and .gid == 65534;
  if .schemaVersion == 2 then
    (.rootfs | valid_identity)
    and (.entrypoints | keys == ["agent", "script"])
    and .entrypoints.script == "/usr/local/bin/run-enclave-script"
    and .entrypoints.agent == "/usr/local/bin/run-enclave-agent"
  elif .schemaVersion == 1 then
    # Compatibility with the earlier shared-rootfs manifest, not two files.
    (.rootfs | keys == ["agent", "script"])
    and (.rootfs.script | valid_identity)
    and (.rootfs.agent | valid_identity)
    and .rootfs.script.role == "script" and .rootfs.agent.role == "agent"
    and .rootfs.script.entrypoint == "/usr/local/bin/run-enclave-script"
    and .rootfs.agent.entrypoint == "/usr/local/bin/run-enclave-agent"
  else false end
' "$ARTIFACT_DIR/enclave-manifest.json" >/dev/null \
  || fail "Cloud Hypervisor shared enclave rootfs identity or fixed entrypoints are invalid."

echo "Cloud Hypervisor host preflight passed on GitHub-hosted Ubuntu x86_64 with accessible KVM."
