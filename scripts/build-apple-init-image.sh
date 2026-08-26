#!/usr/bin/env bash
# Builds the AWF Apple Container init image (linux/arm64).
#
# The image is Apple's own `vminit` with `/sbin/vminitd` relocated to
# `/sbin/vminitd.apple` and the AWF capability-relay shim installed in its
# place. See containers/apple-init/Dockerfile for why that is the only safe
# transformation and why the base must be digest-pinned.
#
# Usage:
#   AWF_VMINIT_IMAGE=ghcr.io/apple/containerization/vminit:X.Y.Z@sha256:<64-hex> \
#     scripts/build-apple-init-image.sh [tag ...]
#
# Environment:
#   AWF_VMINIT_IMAGE  (required) digest-pinned Apple vminit reference
#   PUSH              set to "true" to push the built tags
#   PLATFORM          override the build platform (default linux/arm64)
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PLATFORM=${PLATFORM:-linux/arm64}

if [ -z "${AWF_VMINIT_IMAGE:-}" ]; then
  echo "AWF_VMINIT_IMAGE is required (digest-pinned Apple vminit reference)" >&2
  exit 1
fi

# Refused here as well as inside the Dockerfile so a mistake is caught before a
# build starts, and so the failure names the variable the operator controls.
case "$AWF_VMINIT_IMAGE" in
  *@sha256:*) : ;;
  *)
    echo "AWF_VMINIT_IMAGE must be digest-pinned: got '$AWF_VMINIT_IMAGE'" >&2
    echo "A floating tag would let Apple's init move underneath a shim that" >&2
    echo "hard-codes where that init lives." >&2
    exit 1
    ;;
esac

if [ "$PLATFORM" != "linux/arm64" ]; then
  echo "Apple Container guests are native arm64 only; refusing PLATFORM=$PLATFORM" >&2
  exit 1
fi

# Keep the CLI range in the image labels in sync with the compiled-in host half,
# so a drift is a build failure rather than an unbootable guest.
read_ts_const() {
  local name="$1"
  sed -n "s/^export const ${name} = '\\([^']*\\)';\$/\\1/p" \
    "$ROOT/src/apple-container/transport-capabilities.ts" | head -n 1
}
CLI_MIN=$(read_ts_const APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION)
CLI_MAX=$(read_ts_const APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE)
CONTRACT_VERSION=$(sed -n \
  's/^export const APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION = \([0-9]*\);$/\1/p' \
  "$ROOT/src/apple-container/transport-capabilities.ts" | head -n 1)

if [ -z "$CLI_MIN" ] || [ -z "$CLI_MAX" ] || [ -z "$CONTRACT_VERSION" ]; then
  echo "Could not read the transport contract constants from" >&2
  echo "src/apple-container/transport-capabilities.ts" >&2
  exit 1
fi

TAGS=("$@")
if [ ${#TAGS[@]} -eq 0 ]; then
  TAGS=("awf-apple-init:dev")
fi

ARGS=(
  buildx build
  --platform "$PLATFORM"
  --file "$ROOT/containers/apple-init/Dockerfile"
  --build-arg "AWF_VMINIT_IMAGE=$AWF_VMINIT_IMAGE"
  --build-arg "AWF_CLI_MIN_VERSION=$CLI_MIN"
  --build-arg "AWF_CLI_MAX_VERSION_EXCLUSIVE=$CLI_MAX"
  --build-arg "AWF_TRANSPORT_CONTRACT_VERSION=$CONTRACT_VERSION"
)
for tag in "${TAGS[@]}"; do
  ARGS+=(--tag "$tag")
done
if [ "${PUSH:-}" = "true" ]; then
  ARGS+=(--push)
else
  ARGS+=(--load)
fi
ARGS+=("$ROOT")

echo "Building AWF Apple init image from $AWF_VMINIT_IMAGE"
echo "  contract=v$CONTRACT_VERSION cli>=$CLI_MIN <$CLI_MAX platform=$PLATFORM"
exec docker "${ARGS[@]}"
