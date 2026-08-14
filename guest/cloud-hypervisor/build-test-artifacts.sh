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
# boot). AWF applies one deterministic overlay, CONFIG_FUSE_FS=y plus
# CONFIG_VIRTIO_FS=y, with the kernel's scripts/config before olddefconfig. The original upstream config
# SHA remains recorded separately from the final emitted kernel.config.
#
# guest/firecracker-supervisor/build.sh is reused unmodified: it documents
# itself as VMM-neutral (length-prefixed JSON framing over vsock/UDS), so no
# Cloud Hypervisor-specific supervisor is needed.
#
# NOTE: these artifacts back the real Cloud Hypervisor lifecycle backend in
# src/cloud-hypervisor/ (preview, gated behind --cloud-hypervisor-preview
# plus --container-runtime cloud-hypervisor on GitHub-hosted Ubuntu x86_64
# KVM runners only). They are published as a versioned GitHub Release asset
# (cloud-hypervisor-test-x86_64.tar.gz, see .github/workflows/release.yml)
# for external tooling to pin against, not just as an ephemeral CI artifact.

CLOUD_HYPERVISOR_VERSION=53.0
VIRTIOFSD_VERSION=1.10.0
CLOUD_HYPERVISOR_BINARY_SHA256=448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc
LINUX_VERSION=6.1.141
LINUX_SHA256=bc3c45faf6f5f0450666c75fa9dad9bc7c0cf7c7cba0dbd94e5cfdc58229c116
KERNEL_CONFIG_SHA256=adbc70ab5e89213ba00594b12d25e09bdf8bb1ed3c252d7449326bb14c22963b
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1767225600}
BUILD_TOOLS_IMAGE=${BUILD_TOOLS_IMAGE:-ghcr.io/github/gh-aw-firewall/build-tools:latest}

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUTPUT=${OUTPUT:-"$ROOT/release/cloud-hypervisor-test-x86_64"}
BUILD=${BUILD:-"$ROOT/.build/cloud-hypervisor-test-x86_64"}
JOBS=${JOBS:-$(getconf _NPROCESSORS_ONLN)}

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "Cloud Hypervisor test artifacts must be built on Linux x86_64 (GitHub-hosted Ubuntu runners only)" >&2
  exit 1
fi

for tool in curl sha256sum tar make gcc ld mke2fs e2fsck go docker sudo; do
  command -v "$tool" >/dev/null || {
    echo "required build tool not found: $tool" >&2
    exit 1
  }
done

sudo rm -rf "$BUILD"
rm -rf "$OUTPUT"
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

virtiofsd_source=/usr/libexec/virtiofsd
test -x "$virtiofsd_source" || {
  echo "Ubuntu Noble virtiofsd is required at $virtiofsd_source" >&2
  exit 1
}
"$virtiofsd_source" --version 2>&1 | grep -Eq "(^| )${VIRTIOFSD_VERSION}($| )"
virtiofsd_package=$(dpkg-query --search "$virtiofsd_source" | head -1 | cut -d: -f1)
virtiofsd_package_version=$(dpkg-query --show --showformat='${Version}' "$virtiofsd_package")
install -m 0755 "$virtiofsd_source" "$OUTPUT/virtiofsd"

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
"$BUILD/linux-${LINUX_VERSION}/scripts/config" \
  --file "$BUILD/linux-${LINUX_VERSION}/.config" \
  --enable FUSE_FS \
  --enable VIRTIO_FS
make -C "$BUILD/linux-${LINUX_VERSION}" \
  ARCH=x86_64 \
  KBUILD_BUILD_TIMESTAMP="@${SOURCE_DATE_EPOCH}" \
  KBUILD_BUILD_USER=awf \
  KBUILD_BUILD_HOST=github \
  LOCALVERSION=-awf-cloud-hypervisor \
  olddefconfig
grep -Fx 'CONFIG_VIRTIO_FS=y' "$BUILD/linux-${LINUX_VERSION}/.config"
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
install -m 0644 "$BUILD/linux-${LINUX_VERSION}/.config" "$OUTPUT/kernel.config"

# The AWF guest supervisor is intentionally VMM-neutral (see
# guest/firecracker-supervisor/protocol.go) and is shared as-is between the
# Firecracker and Cloud Hypervisor guest pipelines.
supervisor="$OUTPUT/awf-supervisor"
VERSION="${VERSION:-v${CLOUD_HYPERVISOR_VERSION}}" \
  OUTPUT="$supervisor" \
  "$ROOT/guest/firecracker-supervisor/build.sh"

rootfs_tree="$BUILD/rootfs"
if ! docker image inspect "$BUILD_TOOLS_IMAGE" >/dev/null 2>&1; then
  docker pull --platform linux/amd64 "$BUILD_TOOLS_IMAGE"
fi
build_tools_image_id=$(docker image inspect --format '{{.Id}}' "$BUILD_TOOLS_IMAGE")
build_tools_dockerfile_sha256=$(sha256sum "$ROOT/containers/build-tools/Dockerfile" | awk '{print $1}')
build_tools_container=$(docker create --platform linux/amd64 "$BUILD_TOOLS_IMAGE")
cleanup_build_tools_container() {
  docker rm -f "$build_tools_container" >/dev/null 2>&1 || true
  if [ -n "${rootfs_tree:-}" ] && [ -d "$rootfs_tree" ]; then
    sudo rm -rf "$rootfs_tree"
  fi
}
trap cleanup_build_tools_container EXIT
sudo mkdir -p \
  "$rootfs_tree/dev" \
  "$rootfs_tree/proc" \
  "$rootfs_tree/sys" \
  "$rootfs_tree/tmp" \
  "$rootfs_tree/home/awf" \
  "$rootfs_tree/workspace"
docker export "$build_tools_container" \
  | sudo tar \
      --extract \
      --directory "$rootfs_tree" \
      --numeric-owner \
      --preserve-permissions \
      --same-owner
sudo rm -f "$rootfs_tree/.dockerenv"
sudo find "$rootfs_tree/dev" "$rootfs_tree/proc" "$rootfs_tree/sys" \
  -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
sudo mkdir -p "$rootfs_tree/dev" "$rootfs_tree/proc" "$rootfs_tree/sys" "$rootfs_tree/workspace"
sudo mkdir -p "$rootfs_tree/home/awf"
sudo chown 1000:1000 "$rootfs_tree/home/awf"
sudo install -m 0755 "$supervisor" "$rootfs_tree/usr/sbin/awf-supervisor"
if ! grep -q '^awf:' "$rootfs_tree/etc/passwd"; then
  printf 'awf:x:1000:1000:AWF guest:/workspace:/bin/bash\n' \
    | sudo tee -a "$rootfs_tree/etc/passwd" >/dev/null
fi
if ! grep -q '^awf:' "$rootfs_tree/etc/group"; then
  printf 'awf:x:1000:\n' | sudo tee -a "$rootfs_tree/etc/group" >/dev/null
fi
sudo tee "$rootfs_tree/etc/resolv.conf" >/dev/null <<'EOF'
# Direct DNS is intentionally unavailable in the Cloud Hypervisor foundation guest.
EOF
sudo chmod 01777 "$rootfs_tree/tmp"
sudo find "$rootfs_tree" -print0 \
  | sudo xargs -0 touch --no-dereference --date="@${SOURCE_DATE_EPOCH}"

rootfs="$OUTPUT/rootfs.ext4"
rootfs_usage_bytes=$(sudo du --summarize --block-size=1 "$rootfs_tree" | awk '{print $1}')
rootfs_bytes=$((rootfs_usage_bytes + rootfs_usage_bytes / 4 + 512 * 1024 * 1024))
rootfs_blocks=$(((rootfs_bytes + 4095) / 4096))
sudo env E2FSPROGS_FAKE_TIME="$SOURCE_DATE_EPOCH" mke2fs \
  -t ext4 \
  -F \
  -q \
  -b 4096 \
  -d "$rootfs_tree" \
  -U 2f6f6e8f-2f2a-4b6a-9b9a-7d6a4a1c5c3a \
  -E lazy_itable_init=0,lazy_journal_init=0 \
  "$rootfs" \
  "$rootfs_blocks"
sudo env E2FSPROGS_FAKE_TIME="$SOURCE_DATE_EPOCH" e2fsck -f -y "$rootfs" >/dev/null
sudo chown "$(id -u):$(id -g)" "$rootfs"
chmod 0600 "$rootfs"

(
  cd "$OUTPUT"
  sha256sum \
    cloud-hypervisor \
    virtiofsd \
    vmlinux.bin \
    kernel.config \
    rootfs.ext4 \
    awf-supervisor \
    > SHA256SUMS
)

cat >"$OUTPUT/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "purpose": "AWF Cloud Hypervisor preview test artifacts; not production defaults",
  "architecture": "x86_64",
  "sourceDateEpoch": ${SOURCE_DATE_EPOCH},
  "cloudHypervisor": {
    "version": "${CLOUD_HYPERVISOR_VERSION}",
    "binarySha256": "${CLOUD_HYPERVISOR_BINARY_SHA256}"
  },
  "virtiofsd": {
    "version": "${VIRTIOFSD_VERSION}",
    "source": "Ubuntu Noble /usr/libexec/virtiofsd package artifact",
    "package": "${virtiofsd_package}",
    "packageVersion": "${virtiofsd_package_version}",
    "binarySha256": "$(sha256sum "$OUTPUT/virtiofsd" | awk '{print $1}')"
  },
  "kernel": {
    "version": "${LINUX_VERSION}",
    "sourceSha256": "${LINUX_SHA256}",
    "configSha256": "${KERNEL_CONFIG_SHA256}",
    "upstreamConfigSha256": "${KERNEL_CONFIG_SHA256}",
    "configSource": "firecracker-microvm/firecracker v1.16.1 resources/guest_configs/microvm-kernel-ci-x86_64-6.1.config (PCI-capable)",
    "configOverlay": "scripts/config --enable FUSE_FS --enable VIRTIO_FS followed by olddefconfig",
    "finalConfigSha256": "$(sha256sum "$OUTPUT/kernel.config" | awk '{print $1}')"
  },
  "userspace": {
    "base": "awf-build-tools",
    "image": "${BUILD_TOOLS_IMAGE}",
    "imageId": "${build_tools_image_id}",
    "dockerfileSha256": "${build_tools_dockerfile_sha256}",
    "distribution": "ubuntu:22.04"
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
      "name": "virtiofsd",
      "SPDXID": "SPDXRef-Virtiofsd",
      "versionInfo": "${VIRTIOFSD_VERSION}",
      "downloadLocation": "https://packages.ubuntu.com/noble/virtiofsd",
      "filesAnalyzed": false,
      "licenseConcluded": "Apache-2.0 OR BSD-3-Clause",
      "licenseDeclared": "Apache-2.0 OR BSD-3-Clause",
      "copyrightText": "NOASSERTION"
    },
    {
      "name": "awf-build-tools-sysroot",
      "SPDXID": "SPDXRef-BuildTools",
      "versionInfo": "${build_tools_image_id}",
      "downloadLocation": "NOASSERTION",
      "filesAnalyzed": false,
      "licenseConcluded": "NOASSERTION",
      "licenseDeclared": "NOASSERTION",
      "copyrightText": "NOASSERTION"
    }
  ],
  "relationships": [
    { "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-CloudHypervisor" },
    { "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-Virtiofsd" },
    { "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-Linux" },
    { "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-BuildTools" }
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
  virtiofsd \
  vmlinux.bin \
  kernel.config \
  rootfs.ext4 \
  awf-supervisor \
  SHA256SUMS \
  manifest.json \
  sbom.spdx.json
