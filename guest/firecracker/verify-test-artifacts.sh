#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${1:?usage: verify-test-artifacts.sh ARTIFACT_DIR}

for file in \
  firecracker \
  jailer \
  vmlinux.bin \
  rootfs.ext4 \
  awf-firecracker-supervisor \
  SHA256SUMS \
  manifest.json \
  sbom.spdx.json; do
  test -f "$ARTIFACT_DIR/$file" || {
    echo "missing Firecracker artifact: $file" >&2
    exit 1
  }
done

(
  cd "$ARTIFACT_DIR"
  sha256sum --check SHA256SUMS
)

"$ARTIFACT_DIR/firecracker" --version | grep -F '1.16.1'
"$ARTIFACT_DIR/jailer" --version | grep -F '1.16.1'
file "$ARTIFACT_DIR/vmlinux.bin" | grep -E 'Linux kernel|boot executable'
e2fsck -f -n "$ARTIFACT_DIR/rootfs.ext4"
debugfs -R 'stat /sbin/awf-supervisor' "$ARTIFACT_DIR/rootfs.ext4" 2>&1 \
  | grep -F 'Type: regular'
grep -F '"purpose": "AWF Firecracker preview test artifacts; not production defaults"' \
  "$ARTIFACT_DIR/manifest.json"
grep -F '"spdxVersion": "SPDX-2.3"' "$ARTIFACT_DIR/sbom.spdx.json"
