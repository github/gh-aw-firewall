#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR=${1:?usage: verify-test-artifacts.sh ARTIFACT_DIR}

for file in \
  cloud-hypervisor \
  virtiofsd \
  vmlinux.bin \
  kernel.config \
  rootfs.ext4 \
  enclave-script-rootfs.ext4 \
  enclave-agent-rootfs.ext4 \
  awf-supervisor \
  SHA256SUMS \
  enclave-rootfs.SHA256SUMS \
  manifest.json \
  enclave-manifest.json \
  sbom.spdx.json \
  enclave-script-rootfs.sbom.spdx.json \
  enclave-agent-rootfs.sbom.spdx.json \
  awf-cloud-hypervisor-enclave-rootfs-x86_64.tar.gz; do
  test -f "$ARTIFACT_DIR/$file" || {
    echo "missing Cloud Hypervisor artifact: $file" >&2
    exit 1
  }
done

(
  cd "$ARTIFACT_DIR"
  sha256sum --check SHA256SUMS
  sha256sum --check enclave-rootfs.SHA256SUMS
)

"$ARTIFACT_DIR/cloud-hypervisor" --version | grep -F '53.0'
"$ARTIFACT_DIR/virtiofsd" --version 2>&1 | grep -E '(^| )1\.10\.0($| )'
grep -Fx 'CONFIG_VIRTIO_FS=y' "$ARTIFACT_DIR/kernel.config"
file "$ARTIFACT_DIR/vmlinux.bin" | grep -E 'Linux kernel|boot executable'
e2fsck -f -n "$ARTIFACT_DIR/rootfs.ext4"
debugfs -R 'stat /usr/sbin/awf-supervisor' "$ARTIFACT_DIR/rootfs.ext4" 2>&1 \
  | grep -F 'Type: regular'
home_stat=$(debugfs -R 'stat /home/awf' "$ARTIFACT_DIR/rootfs.ext4" 2>&1)
printf '%s\n' "$home_stat" | grep -E 'Mode:[[:space:]]+0755'
printf '%s\n' "$home_stat" | grep -E 'User:[[:space:]]+1000[[:space:]]+Group:[[:space:]]+1000'
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
test "$(jq -r '.release.repository' "$ARTIFACT_DIR/manifest.json")" = 'github/gh-aw-firewall'
test "$(jq -r '.release.workflow' "$ARTIFACT_DIR/manifest.json")" = \
  'github/gh-aw-firewall/.github/workflows/release.yml'
for entry in \
  'cloudHypervisor:cloud-hypervisor' \
  'virtiofsd:virtiofsd' \
  'kernel:vmlinux.bin' \
  'rootfs:rootfs.ext4' \
  'supervisor:awf-supervisor'; do
  key=${entry%%:*}
  file=${entry#*:}
  test "$(jq -r ".artifacts.${key}.file" "$ARTIFACT_DIR/manifest.json")" = "$file"
  test "$(jq -r ".artifacts.${key}.sha256" "$ARTIFACT_DIR/manifest.json")" = \
    "$(sha256sum "$ARTIFACT_DIR/$file" | awk '{print $1}')"
done
grep -F '"configOverlay": "scripts/config --enable FUSE_FS --enable VIRTIO_FS followed by olddefconfig"' \
  "$ARTIFACT_DIR/manifest.json"
grep -F '"spdxVersion": "SPDX-2.3"' "$ARTIFACT_DIR/sbom.spdx.json"

test "$(jq -r '.artifactType' "$ARTIFACT_DIR/enclave-manifest.json")" = \
  'awf-cloud-hypervisor-enclave-rootfs-set'
test "$(jq -r '.architecture' "$ARTIFACT_DIR/enclave-manifest.json")" = x86_64
test "$(jq -r '.release.repository' "$ARTIFACT_DIR/enclave-manifest.json")" = \
  'github/gh-aw-firewall'
test "$(jq -r '.release.workflow' "$ARTIFACT_DIR/enclave-manifest.json")" = \
  'github/gh-aw-firewall/.github/workflows/release.yml'
test "$(jq -r '.compatibility.cloudHypervisorVersion' "$ARTIFACT_DIR/enclave-manifest.json")" = 53.0
test "$(jq -r '.compatibility.kernelVersion' "$ARTIFACT_DIR/enclave-manifest.json")" = 6.1.141

verify_enclave_rootfs() {
  local role=$1
  local entrypoint=$2
  local file="enclave-${role}-rootfs.ext4"
  local image="$ARTIFACT_DIR/$file"
  local manifest=".rootfs.${role}"

  test "$(jq -r "${manifest}.role" "$ARTIFACT_DIR/enclave-manifest.json")" = "$role"
  test "$(jq -r "${manifest}.file" "$ARTIFACT_DIR/enclave-manifest.json")" = "$file"
  test "$(jq -r "${manifest}.sha256" "$ARTIFACT_DIR/enclave-manifest.json")" = \
    "$(sha256sum "$image" | awk '{print $1}')"
  test "$(jq -r "${manifest}.sizeBytes" "$ARTIFACT_DIR/enclave-manifest.json")" = \
    "$(stat -c '%s' "$image")"
  test "$(jq -r "${manifest}.uid" "$ARTIFACT_DIR/enclave-manifest.json")" = 65534
  test "$(jq -r "${manifest}.gid" "$ARTIFACT_DIR/enclave-manifest.json")" = 65534
  test "$(jq -r "${manifest}.entrypoint" "$ARTIFACT_DIR/enclave-manifest.json")" = "$entrypoint"
  test "$(jq -r "${manifest}.sourceImageDigest" "$ARTIFACT_DIR/enclave-manifest.json")" \
    != null
  test "$(jq -r "${manifest}.sourceImageDigest" "$ARTIFACT_DIR/enclave-manifest.json")" \
    != ''

  local sbom
  sbom=$(jq -r "${manifest}.sbom.file" "$ARTIFACT_DIR/enclave-manifest.json")
  test "$sbom" = "enclave-${role}-rootfs.sbom.spdx.json"
  test "$(jq -r "${manifest}.sbom.sha256" "$ARTIFACT_DIR/enclave-manifest.json")" = \
    "$(sha256sum "$ARTIFACT_DIR/$sbom" | awk '{print $1}')"
  grep -F '"spdxVersion": "SPDX-2.3"' "$ARTIFACT_DIR/$sbom"

  e2fsck -f -n "$image"
  debugfs -R "stat $entrypoint" "$image" 2>&1 | grep -F 'Type: regular'
  debugfs -R 'stat /usr/sbin/awf-supervisor' "$image" 2>&1 | grep -F 'Type: regular'
  device_listing=$(debugfs -R 'ls -p /dev' "$image" 2>/dev/null)
  # debugfs `ls -p` emits `/inode/mode/uid/gid/name/size/`. Permit only the
  # directory's mandatory `.` and `..` entries; any other name, regardless of
  # inode type, means the immutable image embeds a device-directory entry.
  if printf '%s\n' "$device_listing" \
    | awk -F/ 'NF > 0 && (NF < 7 || ($6 != "." && $6 != "..")) { print; found=1 } END { exit found ? 0 : 1 }'
  then
    echo "unexpected embedded device found in $role enclave rootfs" >&2
    return 1
  fi
  role_metadata=$(debugfs -R 'cat /etc/awf/enclave-role.json' "$image" 2>/dev/null)
  test "$(printf '%s' "$role_metadata" | jq -r '.role')" = "$role"
  test "$(printf '%s' "$role_metadata" | jq -r '.uid')" = 65534
  test "$(printf '%s' "$role_metadata" | jq -r '.gid')" = 65534
  test "$(printf '%s' "$role_metadata" | jq -r '.entrypoint')" = "$entrypoint"
  debugfs -R 'cat /etc/passwd' "$image" 2>/dev/null \
    | grep -Eq '^[^:]+:x:65534:65534:'

  for forbidden in \
    /sbin/apk \
    /usr/bin/apt \
    /usr/bin/apt-get \
    /usr/bin/dpkg \
    /usr/local/bin/pip \
    /etc/shadow \
    /etc/gshadow \
    /root/.git-credentials \
    /root/.netrc; do
    if debugfs -R "stat $forbidden" "$image" 2>&1 | grep -Fq 'Inode:'; then
      echo "forbidden enclave rootfs path present for $role: $forbidden" >&2
      return 1
    fi
  done

  seed_listing=$(debugfs -R 'ls -p /awf/seed' "$image" 2>/dev/null)
  if printf '%s\n' "$seed_listing" | grep -Ev '^$|^\s*/[0-9]+/[0-9]+/0/0/\.$|^\s*/[0-9]+/[0-9]+/0/0/\.\.$' | grep -q .; then
    echo "embedded repository seed found in $role enclave rootfs" >&2
    return 1
  fi
}

verify_enclave_rootfs script /usr/local/bin/run-enclave-script
verify_enclave_rootfs agent /usr/local/bin/run-enclave-agent

tar -tzf "$ARTIFACT_DIR/awf-cloud-hypervisor-enclave-rootfs-x86_64.tar.gz" \
  | sort \
  | diff -u - <(printf '%s\n' \
      enclave-agent-rootfs.ext4 \
      enclave-agent-rootfs.sbom.spdx.json \
      enclave-manifest.json \
      enclave-rootfs.SHA256SUMS \
      enclave-script-rootfs.ext4 \
      enclave-script-rootfs.sbom.spdx.json)
