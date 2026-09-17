#!/usr/bin/env bash
set -euo pipefail

umask 077

RELEASE_TAG=${1:?usage: setup-enclave-artifacts.sh RELEASE_TAG [CACHE_ROOT]}
CACHE_ROOT=${2:-${RUNNER_TOOL_CACHE:-${HOME:?HOME is required}/.cache}/awf-cloud-hypervisor}
REPOSITORY=github/gh-aw-firewall
SIGNER_WORKFLOW=github/gh-aw-firewall/.github/workflows/release.yml
ARCHITECTURE=x86_64

[[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || {
  echo "invalid AWF release tag: $RELEASE_TAG" >&2
  exit 1
}
[[ "$CACHE_ROOT" = /* ]] || {
  echo "Cloud Hypervisor enclave cache root must be absolute: $CACHE_ROOT" >&2
  exit 1
}

for tool in gh jq sha256sum stat flock mktemp; do
  command -v "$tool" >/dev/null || {
    echo "required setup tool not found: $tool" >&2
    exit 1
  }
done

cache_parent="$CACHE_ROOT/$RELEASE_TAG"
cache_dir="$cache_parent/$ARCHITECTURE"
lock_file="$cache_parent/.setup.lock"
mkdir -p "$cache_parent"
chmod 0700 "$CACHE_ROOT" "$cache_parent"
exec 9>"$lock_file"
flock 9

manifest_name=cloud-hypervisor-enclave-rootfs-x86_64.manifest.json
manifest_bundle_name=cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl

assert_trusted_file() {
  local file=$1
  local label=$2
  [ -f "$file" ] && [ ! -L "$file" ] || {
    echo "$label must be a regular file and not a symbolic link: $file" >&2
    return 1
  }
  local mode
  mode=$(stat -c '%a' "$file")
  (( (8#$mode & 8#022) == 0 )) || {
    echo "$label must not be group- or world-writable: $file" >&2
    return 1
  }
}

verify_attestation() {
  local subject=$1
  local bundle=$2
  gh attestation verify "$subject" \
    --repo "$REPOSITORY" \
    --bundle "$bundle" \
    --signer-workflow "$SIGNER_WORKFLOW" \
    --deny-self-hosted-runners >/dev/null
}

verify_cache() {
  local directory=$1
  local manifest="$directory/$manifest_name"
  local manifest_bundle="$directory/$manifest_bundle_name"

  assert_trusted_file "$manifest" "enclave artifact manifest"
  assert_trusted_file "$manifest_bundle" "enclave artifact manifest bundle"
  verify_attestation "$manifest" "$manifest_bundle"

  [ "$(jq -r '.schemaVersion' "$manifest")" = 1 ] \
    || { echo "unsupported enclave artifact manifest schema" >&2; return 1; }
  [ "$(jq -r '.artifactType' "$manifest")" = \
      awf-cloud-hypervisor-enclave-rootfs-set ] \
    || { echo "unexpected enclave artifact manifest type" >&2; return 1; }
  [ "$(jq -r '.architecture' "$manifest")" = "$ARCHITECTURE" ] \
    || { echo "enclave artifact architecture mismatch" >&2; return 1; }
  [ "$(jq -r '.release.repository' "$manifest")" = "$REPOSITORY" ] \
    || { echo "enclave artifact repository mismatch" >&2; return 1; }
  [ "$(jq -r '.release.workflow' "$manifest")" = "$SIGNER_WORKFLOW" ] \
    || { echo "enclave artifact signer workflow mismatch" >&2; return 1; }
  [ "$(jq -r '.release.tag' "$manifest")" = "$RELEASE_TAG" ] \
    || { echo "enclave artifact release mismatch" >&2; return 1; }
  [ "$(jq -r '.compatibility.cloudHypervisorVersion' "$manifest")" = 53.0 ] \
    || { echo "enclave artifact Cloud Hypervisor compatibility mismatch" >&2; return 1; }
  [ "$(jq -r '.compatibility.kernelVersion' "$manifest")" = 6.1.141 ] \
    || { echo "enclave artifact kernel compatibility mismatch" >&2; return 1; }
  [ "$(jq -r '.compatibility.supervisorVersion' "$manifest")" = "$RELEASE_TAG" ] \
    || { echo "enclave artifact supervisor compatibility mismatch" >&2; return 1; }

  local role
  for role in script agent; do
    local rootfs_name="enclave-${role}-rootfs.ext4"
    local rootfs="$directory/$rootfs_name"
    local provenance="$directory/enclave-${role}-rootfs.provenance.sigstore.jsonl"
    local sbom_name="enclave-${role}-rootfs.sbom.spdx.json"
    local sbom="$directory/$sbom_name"
    local selector=".rootfs.${role}"

    assert_trusted_file "$rootfs" "$role enclave rootfs"
    assert_trusted_file "$provenance" "$role enclave rootfs provenance"
    assert_trusted_file "$sbom" "$role enclave rootfs SBOM"
    verify_attestation "$rootfs" "$provenance"
    [ "$(jq -r "${selector}.role" "$manifest")" = "$role" ] \
      || { echo "$role enclave rootfs role mismatch" >&2; return 1; }
    [ "$(jq -r "${selector}.file" "$manifest")" = "$rootfs_name" ] \
      || { echo "$role enclave rootfs filename mismatch" >&2; return 1; }
    [ "$(jq -r "${selector}.version" "$manifest")" = "$RELEASE_TAG" ] \
      || { echo "$role enclave rootfs version mismatch" >&2; return 1; }
    [ "$(jq -r "${selector}.uid" "$manifest")" = 65534 ] \
      && [ "$(jq -r "${selector}.gid" "$manifest")" = 65534 ] \
      || { echo "$role enclave rootfs uid/gid mismatch" >&2; return 1; }
    [ "$(jq -r "${selector}.entrypoint" "$manifest")" = \
        "/usr/local/bin/run-enclave-${role}" ] \
      || { echo "$role enclave rootfs entrypoint mismatch" >&2; return 1; }
    jq -e "${selector}.sourceImageDigest | test(\"^[a-f0-9]{64}$\")" "$manifest" \
      >/dev/null \
      || { echo "$role enclave rootfs source image digest is invalid" >&2; return 1; }
    jq -e "${selector}.sourceImage | test(\"^ghcr.io/github/gh-aw-firewall/enclave-${role}@sha256:[a-f0-9]{64}$\")" \
      "$manifest" >/dev/null \
      || { echo "$role enclave rootfs source image is not release-pinned" >&2; return 1; }
    [ "$(jq -r "${selector}.sha256" "$manifest")" = \
        "$(sha256sum "$rootfs" | awk '{print $1}')" ] \
      || { echo "$role enclave rootfs digest mismatch" >&2; return 1; }
    [ "$(jq -r "${selector}.sizeBytes" "$manifest")" = "$(stat -c '%s' "$rootfs")" ] \
      || { echo "$role enclave rootfs size mismatch" >&2; return 1; }
    [ "$(jq -r "${selector}.sbom.file" "$manifest")" = "$sbom_name" ] \
      || { echo "$role enclave rootfs SBOM filename mismatch" >&2; return 1; }
    [ "$(jq -r "${selector}.sbom.sha256" "$manifest")" = \
        "$(sha256sum "$sbom" | awk '{print $1}')" ] \
      || { echo "$role enclave rootfs SBOM digest mismatch" >&2; return 1; }
  done
}

if [ -e "$cache_dir" ]; then
  if ! verify_cache "$cache_dir"; then
    echo "existing Cloud Hypervisor enclave cache is untrusted; refusing to reuse or replace it: $cache_dir" >&2
    exit 1
  fi
else
  staging=$(mktemp -d "$cache_parent/.staging.XXXXXXXX")
  cleanup() {
    rm -rf -- "$staging"
  }
  trap cleanup EXIT
  gh release download "$RELEASE_TAG" \
    --repo "$REPOSITORY" \
    --dir "$staging" \
    --pattern "$manifest_name" \
    --pattern "$manifest_bundle_name" \
    --pattern 'enclave-script-rootfs.ext4' \
    --pattern 'enclave-agent-rootfs.ext4' \
    --pattern 'enclave-script-rootfs.sbom.spdx.json' \
    --pattern 'enclave-agent-rootfs.sbom.spdx.json' \
    --pattern 'enclave-script-rootfs.provenance.sigstore.jsonl' \
    --pattern 'enclave-agent-rootfs.provenance.sigstore.jsonl'
  find "$staging" -type f -exec chmod 0400 {} +
  verify_cache "$staging"
  mv "$staging" "$cache_dir"
  trap - EXIT
fi

script_rootfs="$cache_dir/enclave-script-rootfs.ext4"
agent_rootfs="$cache_dir/enclave-agent-rootfs.ext4"
manifest="$cache_dir/$manifest_name"
manifest_bundle="$cache_dir/$manifest_bundle_name"

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    printf 'AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS=%s\n' "$script_rootfs"
    printf 'AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS=%s\n' "$agent_rootfs"
    printf 'AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST=%s\n' "$manifest"
    printf 'AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE=%s\n' "$manifest_bundle"
  } >>"$GITHUB_ENV"
else
  printf 'export AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS=%q\n' "$script_rootfs"
  printf 'export AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS=%q\n' "$agent_rootfs"
  printf 'export AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST=%q\n' "$manifest"
  printf 'export AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE=%q\n' "$manifest_bundle"
fi
