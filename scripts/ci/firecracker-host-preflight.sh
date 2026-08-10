#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${1:?usage: firecracker-host-preflight.sh ARTIFACT_DIR}

fail() {
  echo "::error title=Firecracker host preflight::$*" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || fail "Linux is required; macOS and Windows are unsupported."
[ "$(uname -m)" = x86_64 ] || fail "This CI artifact set requires an x86_64 host."
[ -c /dev/kvm ] || fail "/dev/kvm is missing; use a KVM-capable host."
[ -r /dev/kvm ] && [ -w /dev/kvm ] \
  || fail "/dev/kvm must be readable and writable by the workflow user."

for control in \
  /proc/sys/net/ipv4/ip_forward \
  /proc/sys/net/ipv6/conf/all/disable_ipv6 \
  /proc/sys/kernel/seccomp/actions_avail; do
  [ -r "$control" ] || fail "Required host kernel control is unavailable: $control"
done
[ -r /sys/fs/cgroup/cgroup.controllers ] || [ -w /sys/fs/cgroup ] \
  || fail "A usable cgroup v1 or v2 hierarchy is required by jailer."

for tool in nft ip sysctl mke2fs debugfs e2fsck rsync docker sha256sum timeout; do
  command -v "$tool" >/dev/null || fail "Required host tool is missing: $tool"
done
command -v sudo >/dev/null || fail "Passwordless sudo is required for jailer and netns setup."
sudo -n true || fail "Passwordless sudo is required for jailer and netns setup."
docker info >/dev/null || fail "A host-visible Docker Engine is required."
docker compose version >/dev/null || fail "Docker Compose v2 is required."

"$ARTIFACT_DIR/firecracker" --version | grep -Fq '1.16.1' \
  || fail "Firecracker v1.16.1 is required."
"$ARTIFACT_DIR/jailer" --version | grep -Fq '1.16.1' \
  || fail "jailer v1.16.1 is required."
(
  cd "$ARTIFACT_DIR"
  sha256sum --check --strict SHA256SUMS
) || fail "Artifact digest verification failed."

echo "Firecracker host preflight passed on Linux/x86_64 with accessible KVM."
