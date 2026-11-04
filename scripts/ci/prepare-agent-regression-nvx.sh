#!/usr/bin/env bash
set -euo pipefail

output="${RUNNER_TEMP:?}/agent-runtime-nvx"
package_dir="$RUNNER_TEMP/agent-runtime-nvx-package"
archive=nvx-0.1.0-linux-kvm.tar.gz
mkdir -p "$output" "$package_dir"
gh release download v0.1.0-dev.8fb0f1d64f2f --repo microsoft/nvx \
  --pattern "$archive" --dir "$package_dir"
printf '%s  %s\n' \
  0a4bb74e76e80a524c3dccd9336b77705ef91d6a908d6979403c59151a5883da \
  "$package_dir/$archive" | sha256sum --check --status
tar -xzf "$package_dir/$archive" -C "$package_dir"
extracted="$package_dir/nvx-0.1.0-linux-kvm"
(cd "$extracted" && sha256sum --check SHA256SUMS)
install -m 0555 "$extracted/bin/openvmm" "$output/openvmm"
install -m 0444 "$extracted/guest/vmlinux" "$output/vmlinux"
install -m 0444 "$extracted/guest/initramfs.cpio.gz" "$output/initramfs.cpio.gz"

jq -n \
  --arg tag "v$(node -p "require('./package.json').version")" \
  --arg commit "$(git rev-parse HEAD)" \
  --arg openvmm_sha "$(sha256sum "$output/openvmm" | cut -d' ' -f1)" \
  --arg kernel_sha "$(sha256sum "$output/vmlinux" | cut -d' ' -f1)" \
  --arg initramfs_sha "$(sha256sum "$output/initramfs.cpio.gz" | cut -d' ' -f1)" \
  --argjson openvmm_size "$(stat -c %s "$output/openvmm")" \
  --argjson kernel_size "$(stat -c %s "$output/vmlinux")" \
  --argjson initramfs_size "$(stat -c %s "$output/initramfs.cpio.gz")" \
  '{
    schemaVersion: 2,
    release: {
      repository: "github/gh-aw-firewall",
      workflow: "github/gh-aw-firewall/.github/workflows/daily-agent-runtime-regression.yml",
      tag: $tag,
      sourceCommit: $commit
    },
    upstream: {
      releaseTag: "v0.1.0-dev.8fb0f1d64f2f",
      nvxCommit: "8fb0f1d64f2f67e0017a4f94693244297852ed1f",
      openvmmCommit: "0ac254109ed32fc5fa2b1a6fc526a10593b1f986"
    },
    architecture: "x86_64",
    artifacts: {
      openvmm: {file: "openvmm", sizeBytes: $openvmm_size, sha256: $openvmm_sha},
      kernel: {file: "vmlinux", sizeBytes: $kernel_size, sha256: $kernel_sha},
      initramfs: {file: "initramfs.cpio.gz", sizeBytes: $initramfs_size, sha256: $initramfs_sha}
    }
  }' > "$output/manifest.json"
