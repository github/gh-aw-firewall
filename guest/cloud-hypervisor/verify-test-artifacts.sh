#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${1:?usage: verify-test-artifacts.sh ARTIFACT_DIR}

for file in \
  cloud-hypervisor \
  vmlinux.bin \
  rootfs.ext4 \
  awf-supervisor \
  SHA256SUMS \
  manifest.json \
  sbom.spdx.json; do
  test -f "$ARTIFACT_DIR/$file" || {
    echo "missing Cloud Hypervisor artifact: $file" >&2
    exit 1
  }
done

(
  cd "$ARTIFACT_DIR"
  sha256sum --check SHA256SUMS
)

"$ARTIFACT_DIR/cloud-hypervisor" --version | grep -F '53.0'
file "$ARTIFACT_DIR/vmlinux.bin" | grep -E 'Linux kernel|boot executable'
e2fsck -f -n "$ARTIFACT_DIR/rootfs.ext4"
debugfs -R 'stat /usr/sbin/awf-supervisor' "$ARTIFACT_DIR/rootfs.ext4" 2>&1 \
  | grep -F 'Type: regular'
for tool in \
  /bin/bash \
  /usr/bin/curl \
  /usr/bin/gcc \
  /usr/bin/git \
  /usr/bin/gh \
  /usr/bin/jq \
  /usr/bin/make \
  /usr/sbin/capsh \
  /usr/sbin/gosu \
  /usr/sbin/ip; do
  debugfs -R "stat $tool" "$ARTIFACT_DIR/rootfs.ext4" 2>&1 \
    | grep -F 'Inode:'
done
bash_stat=$(debugfs -R 'stat /bin/bash' "$ARTIFACT_DIR/rootfs.ext4" 2>&1)
printf '%s\n' "$bash_stat" | grep -E 'Mode:[[:space:]]+0755'
printf '%s\n' "$bash_stat" | grep -E 'User:[[:space:]]+0[[:space:]]+Group:[[:space:]]+0'
passwd_stat=$(debugfs -R 'stat /etc/passwd' "$ARTIFACT_DIR/rootfs.ext4" 2>&1)
printf '%s\n' "$passwd_stat" | grep -E 'Mode:[[:space:]]+0644'
printf '%s\n' "$passwd_stat" | grep -E 'User:[[:space:]]+0[[:space:]]+Group:[[:space:]]+0'
debugfs -R 'cat /usr/lib/os-release' "$ARTIFACT_DIR/rootfs.ext4" 2>/dev/null \
  | grep -F 'Ubuntu 22.04'
grep -F '"purpose": "AWF Cloud Hypervisor preview test artifacts; not production defaults"' \
  "$ARTIFACT_DIR/manifest.json"
grep -F '"base": "awf-build-tools"' "$ARTIFACT_DIR/manifest.json"
grep -F '"spdxVersion": "SPDX-2.3"' "$ARTIFACT_DIR/sbom.spdx.json"
