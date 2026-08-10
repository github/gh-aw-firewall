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
debugfs -R 'stat /sbin/awf-supervisor' "$ARTIFACT_DIR/rootfs.ext4" 2>&1 \
  | grep -F 'Type: regular'
grep -F '"purpose": "AWF Cloud Hypervisor foundation test artifacts; not production defaults; no lifecycle backend yet"' \
  "$ARTIFACT_DIR/manifest.json"
grep -F '"spdxVersion": "SPDX-2.3"' "$ARTIFACT_DIR/sbom.spdx.json"
