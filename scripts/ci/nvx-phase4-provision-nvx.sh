#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?}" "${GITHUB_SHA:?}" "${GITHUB_ENV:?}" "${GH_TOKEN:?}"
NVX_RELEASE=v0.1.0-dev.be859aa77ffa
NVX_ARCHIVE=nvx-0.1.0-linux-kvm.tar.gz
NVX_ARCHIVE_SHA256=ad6bf948d84d60d92f35103b52dc3ad33a421e9a4457ce0823d1890a6985a912
package="$RUNNER_TEMP/nvx-package"
artifacts="$RUNNER_TEMP/nvx-artifacts"
layer="$RUNNER_TEMP/nvx-layer"
mkdir -p "$package" "$artifacts" "$layer"
# shellcheck disable=SC2191
apk_packages=(
  ada-libs=2.9.2-r4 alpine-baselayout=3.7.0-r0 alpine-baselayout-data=3.7.0-r0
  alpine-keys=2.5-r0 alpine-release=3.22.1-r0 apk-tools=2.14.9-r2
  bash=5.2.37-r0 brotli-libs=1.1.0-r2 busybox=1.37.0-r18
  busybox-binsh=1.37.0-r18 c-ares=1.34.8-r0 ca-certificates=20260909-r0
  ca-certificates-bundle=20250619-r0 curl=8.14.1-r3 icu-data-en=76.1-r1
  icu-libs=76.1-r1 libapk2=2.14.9-r2 libcrypto3=3.5.1-r0
  libcurl=8.14.1-r3 libgcc=14.2.0-r6 libidn2=2.3.7-r0
  libncursesw=6.5_p20250503-r0 libpsl=0.21.5-r3 libssl3=3.5.1-r0
  libstdc++=14.2.0-r6 libunistring=1.3-r0 musl=1.2.5-r10
  musl-utils=1.2.5-r10 ncurses-terminfo-base=6.5_p20250503-r0
  nghttp2-libs=1.69.0-r0 nodejs=22.23.2-r0 npm=11.6.4-r0
  readline=8.2.13-r1 scanelf=1.3.8-r1 simdjson=3.12.0-r0
  simdutf=7.2.1-r0 sqlite-libs=3.49.2-r1 ssl_client=1.37.0-r18
  zlib=1.3.1-r2 zstd-libs=1.5.7-r0
)
gh release download "$NVX_RELEASE" --repo microsoft/nvx \
  --pattern "$NVX_ARCHIVE" --dir "$package"
printf '%s  %s\n' "$NVX_ARCHIVE_SHA256" "$package/$NVX_ARCHIVE" |
  sha256sum --check --status
tar -xzf "$package/$NVX_ARCHIVE" -C "$package"
extracted="$package/nvx-0.1.0-linux-kvm"
(cd "$extracted" && sha256sum --check SHA256SUMS)
sudo install -o root -g root -m 0555 "$extracted/bin/openvmm" "$artifacts/openvmm"
sudo install -o root -g root -m 0444 "$extracted/guest/vmlinux" "$artifacts/vmlinux"
sudo install -o root -g root -m 0444 \
  "$extracted/guest/initramfs.cpio.gz" "$artifacts/initramfs.cpio.gz"
jq -n \
  --arg source "$GITHUB_SHA" \
  --arg openvmm "$(sha256sum "$artifacts/openvmm" | cut -d' ' -f1)" \
  --arg kernel "$(sha256sum "$artifacts/vmlinux" | cut -d' ' -f1)" \
  --arg initramfs "$(sha256sum "$artifacts/initramfs.cpio.gz" | cut -d' ' -f1)" \
  --argjson openvmm_size "$(stat -c %s "$artifacts/openvmm")" \
  --argjson kernel_size "$(stat -c %s "$artifacts/vmlinux")" \
  --argjson initramfs_size "$(stat -c %s "$artifacts/initramfs.cpio.gz")" \
  '{schemaVersion:2,release:{repository:"github/gh-aw-firewall",
    workflow:"github/gh-aw-firewall/.github/workflows/nvx-phase-4-benchmark.yml",
    tag:"v0.28.54",sourceCommit:$source},
    upstream:{releaseTag:"v0.1.0-dev.be859aa77ffa",
      nvxCommit:"be859aa77ffa7a20f9ef50f68c5386acdfca9955",
      openvmmCommit:"762bc1c7a203b16aee752324d6a4ab0bde1a713a"},
    architecture:"x86_64",
    artifacts:{openvmm:{file:"openvmm",sizeBytes:$openvmm_size,sha256:$openvmm},
      kernel:{file:"vmlinux",sizeBytes:$kernel_size,sha256:$kernel},
      initramfs:{file:"initramfs.cpio.gz",sizeBytes:$initramfs_size,sha256:$initramfs}}}' \
  > "$artifacts/manifest.json"
sudo chown root:root "$artifacts/manifest.json"
sudo chmod 0444 "$artifacts/manifest.json"

image=alpine@sha256:eafc1edb577d2e9b458664a15f23ea1c370214193226069eb22921169fc7e43f
sudo docker pull "$image"
container=$(sudo docker create "$image" sh -ec '
  apk add --no-cache "$@" >/dev/null 2>&1
  printf "%s\n" __PACKAGES__
  apk info -v | sort
  printf "%s\n" __TOOLS__
  printf "bash=%s\n" "$(bash --version | head -n 1)"
  printf "curl=%s\n" "$(curl --version | head -n 1)"
  printf "node=%s\n" "$(node --version)"
  printf "npm=%s\n" "$(npm --version)"
' install "${apk_packages[@]}")
sudo docker start --attach "$container" | tee "$artifacts/toolchain.txt" >/dev/null
awk '/^__PACKAGES__$/{inside=1; next} /^__TOOLS__$/{inside=0} inside' \
  "$artifacts/toolchain.txt" > "$artifacts/packages.txt"
awk '/^__TOOLS__$/{inside=1; next} inside' \
  "$artifacts/toolchain.txt" > "$artifacts/tools.txt"
sudo docker export "$container" | tar -xf - -C "$layer"
sudo docker rm "$container"
workload_uid=$(node -e \
  "process.stdout.write(require('./dist/host-identity').getSafeHostUid())")
workload_gid=$(node -e \
  "process.stdout.write(require('./dist/host-identity').getSafeHostGid())")
sudo awk -F: -v uid="$workload_uid" '$1 != "awf" && $3 != uid' "$layer/etc/passwd" |
  tee "$RUNNER_TEMP/nvx-passwd" >/dev/null
printf 'awf:x:%s:%s:AWF workload:/home/awf:/bin/sh\n' \
  "$workload_uid" "$workload_gid" >> "$RUNNER_TEMP/nvx-passwd"
sudo install -o root -g root -m 0644 "$RUNNER_TEMP/nvx-passwd" "$layer/etc/passwd"
if ! sudo awk -F: -v gid="$workload_gid" \
  '$3 == gid { found = 1 } END { exit !found }' "$layer/etc/group"; then
  printf 'awf:x:%s:\n' "$workload_gid" | sudo tee -a "$layer/etc/group" >/dev/null
fi
sudo install -d -o "$workload_uid" -g "$workload_gid" -m 0700 "$layer/home/awf"
sudo install -d -o root -g root -m 1777 "$layer/tmp"
layer_sha256=$(tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -cf - -C "$layer" . | sha256sum | cut -d' ' -f1)
package_inventory_sha256=$(sha256sum "$artifacts/packages.txt" | cut -d' ' -f1)
packages_json=$(jq -Rn '[inputs | select(length > 0)]' < "$artifacts/packages.txt")
tool_value() { sed -n "s/^$1=//p" "$artifacts/tools.txt"; }
jq -n \
  --arg layerSha256 "$layer_sha256" \
  --arg packageInventorySha256 "$package_inventory_sha256" \
  --argjson packages "$packages_json" \
  --arg bash "$(tool_value bash)" --arg curl "$(tool_value curl)" \
  --arg node "$(tool_value node)" --arg npm "$(tool_value npm)" \
  '{layerSha256:$layerSha256,packageInventorySha256:$packageInventorySha256,
    packages:$packages,tools:{bash:$bash,curl:$curl,node:$node,npm:$npm}}' \
  > "$artifacts/toolchain.json"
run_mount_options=$(findmnt -no OPTIONS /run)
sudo mount -o remount,size=8G /run
{
  echo "NVX_OPENVMM=$artifacts/openvmm"
  echo "NVX_KERNEL=$artifacts/vmlinux"
  echo "NVX_INITRAMFS=$artifacts/initramfs.cpio.gz"
  echo "NVX_LAYER=$layer"
  echo "NVX_TOOLCHAIN=$artifacts/toolchain.json"
  echo "NVX_MANIFEST=$artifacts/manifest.json"
  echo "AWF_PHASE4_RUN_MOUNT_OPTIONS=$run_mount_options"
} >> "$GITHUB_ENV"
