#!/usr/bin/env bash
set -euo pipefail

umask 077

# Cloud Hypervisor v53.0 foundation guest artifacts.
#
# This mirrors guest/firecracker/build-test-artifacts.sh's conventions and
# intentionally reuses the *exact same* pinned Linux kernel source and
# Firecracker microvm-kernel-ci config as the Firecracker pipeline: that
# config already builds a PCI-capable kernel (CONFIG_PCI, CONFIG_VIRTIO_PCI,
# CONFIG_PCI_MMCONFIG for ACPI MCFG/PCIe ECAM, CONFIG_VIRTIO_BLK,
# CONFIG_VIRTIO_NET, CONFIG_VIRTIO_CONSOLE, CONFIG_VSOCKETS,
# CONFIG_VIRTIO_VSOCKETS, CONFIG_EXT4_FS, CONFIG_PVH for firmware-less direct
# boot) with virtio-fs, hotplug-only, and confidential-computing options left
# off. Reusing it keeps both VMM backends' guest kernels identical and
# reviewed against a single trusted source instead of maintaining a second,
# hand-curated kernel config.
#
# guest/firecracker-supervisor/build.sh is reused unmodified: it documents
# itself as VMM-neutral (length-prefixed JSON framing over vsock/UDS), so no
# Cloud Hypervisor-specific supervisor is needed.
#
# NOTE: this produces artifacts for the Cloud Hypervisor *foundation* only.
# There is no lifecycle backend yet (see src/cloud-hypervisor/), so these
# artifacts are not wired into any runnable AWF workload in this release.

CLOUD_HYPERVISOR_VERSION=53.0
CLOUD_HYPERVISOR_BINARY_SHA256=448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc
LINUX_VERSION=6.1.141
LINUX_SHA256=bc3c45faf6f5f0450666c75fa9dad9bc7c0cf7c7cba0dbd94e5cfdc58229c116
KERNEL_CONFIG_SHA256=adbc70ab5e89213ba00594b12d25e09bdf8bb1ed3c252d7449326bb14c22963b
BUSYBOX_VERSION=1.36.1
BUSYBOX_SHA256=b8cc24c9574d809e7279c3be349795c5d5ceb6fdf19ca709f80cde50e47de314
CA_BUNDLE_DATE=2025-02-25
CA_BUNDLE_SHA256=50a6277ec69113f00c5fd45f09e8b97a4b3e32daa35d3a95ab30137a55386cef
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1767225600}

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUTPUT=${OUTPUT:-"$ROOT/release/cloud-hypervisor-test-x86_64"}
BUILD=${BUILD:-"$ROOT/.build/cloud-hypervisor-test-x86_64"}
JOBS=${JOBS:-$(getconf _NPROCESSORS_ONLN)}

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "Cloud Hypervisor test artifacts must be built on Linux x86_64 (GitHub-hosted Ubuntu runners only)" >&2
  exit 1
fi

for tool in curl sha256sum tar make gcc ld mke2fs e2fsck go; do
  command -v "$tool" >/dev/null || {
    echo "required build tool not found: $tool" >&2
    exit 1
  }
done

rm -rf "$BUILD" "$OUTPUT"
mkdir -p "$BUILD/downloads" "$OUTPUT"

download_verified() {
  local url=$1
  local expected=$2
  local destination=$3
  curl --fail --location --proto '=https' --tlsv1.2 "$url" --output "$destination"
  printf '%s  %s\n' "$expected" "$destination" | sha256sum --check --status
}

# Cloud Hypervisor ships a single statically-linked release binary — no
# jailer-equivalent process and no archive/SHA256SUMS bundle to unpack.
binary="$OUTPUT/cloud-hypervisor"
download_verified \
  "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v${CLOUD_HYPERVISOR_VERSION}/cloud-hypervisor-static" \
  "$CLOUD_HYPERVISOR_BINARY_SHA256" \
  "$binary"
chmod 0755 "$binary"

linux_tar="$BUILD/downloads/linux-${LINUX_VERSION}.tar.xz"
kernel_config="$BUILD/downloads/cloud-hypervisor-kernel.config"
download_verified \
  "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${LINUX_VERSION}.tar.xz" \
  "$LINUX_SHA256" \
  "$linux_tar"
# Reuses Firecracker's pinned, PCI-capable microvm-kernel-ci config (see
# header comment): same kernel source + same config as
# guest/firecracker/build-test-artifacts.sh, pinned to the Firecracker
# v1.16.1 release tag for stable provenance.
download_verified \
  "https://raw.githubusercontent.com/firecracker-microvm/firecracker/v1.16.1/resources/guest_configs/microvm-kernel-ci-x86_64-6.1.config" \
  "$KERNEL_CONFIG_SHA256" \
  "$kernel_config"
tar --extract --xz --file "$linux_tar" --directory "$BUILD"
cp "$kernel_config" "$BUILD/linux-${LINUX_VERSION}/.config"
make -C "$BUILD/linux-${LINUX_VERSION}" \
  ARCH=x86_64 \
  KBUILD_BUILD_TIMESTAMP="@${SOURCE_DATE_EPOCH}" \
  KBUILD_BUILD_USER=awf \
  KBUILD_BUILD_HOST=github \
  LOCALVERSION=-awf-cloud-hypervisor \
  olddefconfig
make -C "$BUILD/linux-${LINUX_VERSION}" \
  -j"$JOBS" \
  ARCH=x86_64 \
  KBUILD_BUILD_TIMESTAMP="@${SOURCE_DATE_EPOCH}" \
  KBUILD_BUILD_USER=awf \
  KBUILD_BUILD_HOST=github \
  LOCALVERSION=-awf-cloud-hypervisor \
  bzImage
install -m 0644 \
  "$BUILD/linux-${LINUX_VERSION}/arch/x86/boot/bzImage" \
  "$OUTPUT/vmlinux.bin"

busybox_tar="$BUILD/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2"
download_verified \
  "https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2" \
  "$BUSYBOX_SHA256" \
  "$busybox_tar"
tar --extract --bzip2 --file "$busybox_tar" --directory "$BUILD"
busybox_dir="$BUILD/busybox-${BUSYBOX_VERSION}"
make -C "$busybox_dir" defconfig
enable_busybox_option() {
  local option=$1
  if grep -q "^CONFIG_${option}=" "$busybox_dir/.config"; then
    sed -i "s/^CONFIG_${option}=.*/CONFIG_${option}=y/" "$busybox_dir/.config"
  elif grep -q "^# CONFIG_${option} is not set$" "$busybox_dir/.config"; then
    sed -i "s/^# CONFIG_${option} is not set$/CONFIG_${option}=y/" "$busybox_dir/.config"
  else
    printf 'CONFIG_%s=y\n' "$option" >>"$busybox_dir/.config"
  fi
}
disable_busybox_option() {
  local option=$1
  if grep -q "^CONFIG_${option}=" "$busybox_dir/.config"; then
    sed -i "s/^CONFIG_${option}=.*/# CONFIG_${option} is not set/" "$busybox_dir/.config"
  elif ! grep -q "^# CONFIG_${option} is not set$" "$busybox_dir/.config"; then
    printf '# CONFIG_%s is not set\n' "$option" >>"$busybox_dir/.config"
  fi
}
for option in \
  STATIC \
  WGET \
  FEATURE_WGET_HTTPS \
  TLS \
  IP \
  IPADDR \
  IPLINK \
  IPROUTE \
  NC \
  NSLOOKUP \
  TIMEOUT; do
  enable_busybox_option "$option"
done
# BusyBox 1.36.1 tc depends on CBQ UAPI definitions removed from newer build hosts.
# The minimal guest never uses traffic control; AWF enforces policy in the host netns.
disable_busybox_option TC
make -C "$busybox_dir" -j"$JOBS"

# The AWF guest supervisor is intentionally VMM-neutral (see
# guest/firecracker-supervisor/protocol.go) and is shared as-is between the
# Firecracker and Cloud Hypervisor guest pipelines.
supervisor="$OUTPUT/awf-supervisor"
VERSION="v${CLOUD_HYPERVISOR_VERSION}" \
  OUTPUT="$supervisor" \
  "$ROOT/guest/firecracker-supervisor/build.sh"

rootfs_tree="$BUILD/rootfs"
mkdir -p \
  "$rootfs_tree/bin" \
  "$rootfs_tree/dev" \
  "$rootfs_tree/etc/ssl/certs" \
  "$rootfs_tree/proc" \
  "$rootfs_tree/root" \
  "$rootfs_tree/sbin" \
  "$rootfs_tree/sys" \
  "$rootfs_tree/tmp" \
  "$rootfs_tree/usr/bin" \
  "$rootfs_tree/usr/sbin" \
  "$rootfs_tree/workspace"
make -C "$busybox_dir" CONFIG_PREFIX="$rootfs_tree" install
install -m 0755 "$supervisor" "$rootfs_tree/sbin/awf-supervisor"
cat >"$rootfs_tree/etc/passwd" <<'EOF'
root:x:0:0:root:/root:/bin/sh
awf:x:1000:1000:AWF guest:/workspace:/bin/sh
nobody:x:65534:65534:nobody:/:/bin/false
EOF
cat >"$rootfs_tree/etc/group" <<'EOF'
root:x:0:
awf:x:1000:
nogroup:x:65534:
EOF
cat >"$rootfs_tree/etc/resolv.conf" <<'EOF'
# Direct DNS is intentionally unavailable in the Cloud Hypervisor foundation guest.
EOF
ca_bundle="$BUILD/downloads/cacert-${CA_BUNDLE_DATE}.pem"
download_verified \
  "https://curl.se/ca/cacert-${CA_BUNDLE_DATE}.pem" \
  "$CA_BUNDLE_SHA256" \
  "$ca_bundle"
install -m 0644 "$ca_bundle" "$rootfs_tree/etc/ssl/certs/ca-certificates.crt"
chmod 01777 "$rootfs_tree/tmp"
find "$rootfs_tree" -print0 | xargs -0 touch --no-dereference --date="@${SOURCE_DATE_EPOCH}"

rootfs="$OUTPUT/rootfs.ext4"
E2FSPROGS_FAKE_TIME="$SOURCE_DATE_EPOCH" mke2fs \
  -t ext4 \
  -F \
  -q \
  -b 4096 \
  -d "$rootfs_tree" \
  -U 2f6f6e8f-2f2a-4b6a-9b9a-7d6a4a1c5c3a \
  -E lazy_itable_init=0,lazy_journal_init=0 \
  "$rootfs" \
  32768
E2FSPROGS_FAKE_TIME="$SOURCE_DATE_EPOCH" e2fsck -f -y "$rootfs" >/dev/null

(
  cd "$OUTPUT"
  sha256sum \
    cloud-hypervisor \
    vmlinux.bin \
    rootfs.ext4 \
    awf-supervisor \
    > SHA256SUMS
)

cat >"$OUTPUT/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "purpose": "AWF Cloud Hypervisor foundation test artifacts; not production defaults; no lifecycle backend yet",
  "architecture": "x86_64",
  "sourceDateEpoch": ${SOURCE_DATE_EPOCH},
  "cloudHypervisor": {
    "version": "${CLOUD_HYPERVISOR_VERSION}",
    "binarySha256": "${CLOUD_HYPERVISOR_BINARY_SHA256}"
  },
  "kernel": {
    "version": "${LINUX_VERSION}",
    "sourceSha256": "${LINUX_SHA256}",
    "configSha256": "${KERNEL_CONFIG_SHA256}",
    "configSource": "firecracker-microvm/firecracker v1.16.1 resources/guest_configs/microvm-kernel-ci-x86_64-6.1.config (PCI-capable)"
  },
  "userspace": {
    "busyboxVersion": "${BUSYBOX_VERSION}",
    "busyboxSourceSha256": "${BUSYBOX_SHA256}",
    "caBundleDate": "${CA_BUNDLE_DATE}",
    "caBundleSha256": "${CA_BUNDLE_SHA256}"
  }
}
EOF

cat >"$OUTPUT/sbom.spdx.json" <<EOF
{
  "spdxVersion": "SPDX-2.3",
  "dataLicense": "CC0-1.0",
  "SPDXID": "SPDXRef-DOCUMENT",
  "name": "awf-cloud-hypervisor-test-x86_64",
  "documentNamespace": "https://github.com/github/gh-aw-firewall/cloud-hypervisor-test/${SOURCE_DATE_EPOCH}",
  "creationInfo": {
    "created": "2026-01-01T00:00:00Z",
    "creators": ["Tool: guest/cloud-hypervisor/build-test-artifacts.sh"]
  },
  "packages": [
    {
      "name": "cloud-hypervisor",
      "SPDXID": "SPDXRef-CloudHypervisor",
      "versionInfo": "${CLOUD_HYPERVISOR_VERSION}",
      "downloadLocation": "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/tag/v${CLOUD_HYPERVISOR_VERSION}",
      "filesAnalyzed": false,
      "licenseConcluded": "Apache-2.0 OR BSD-3-Clause",
      "licenseDeclared": "Apache-2.0 OR BSD-3-Clause",
      "copyrightText": "NOASSERTION"
    },
    {
      "name": "linux",
      "SPDXID": "SPDXRef-Linux",
      "versionInfo": "${LINUX_VERSION}",
      "downloadLocation": "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${LINUX_VERSION}.tar.xz",
      "filesAnalyzed": false,
      "licenseConcluded": "GPL-2.0-only",
      "licenseDeclared": "GPL-2.0-only",
      "copyrightText": "NOASSERTION"
    },
    {
      "name": "busybox",
      "SPDXID": "SPDXRef-BusyBox",
      "versionInfo": "${BUSYBOX_VERSION}",
      "downloadLocation": "https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2",
      "filesAnalyzed": false,
      "licenseConcluded": "GPL-2.0-only",
      "licenseDeclared": "GPL-2.0-only",
      "copyrightText": "NOASSERTION"
    }
  ],
  "relationships": [
    { "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-CloudHypervisor" },
    { "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-Linux" },
    { "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-BusyBox" }
  ]
}
EOF

tar \
  --sort=name \
  --mtime="@${SOURCE_DATE_EPOCH}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --create \
  --gzip \
  --file "$OUTPUT/awf-cloud-hypervisor-test-x86_64.tar.gz" \
  --directory "$OUTPUT" \
  cloud-hypervisor \
  vmlinux.bin \
  rootfs.ext4 \
  awf-supervisor \
  SHA256SUMS \
  manifest.json \
  sbom.spdx.json
