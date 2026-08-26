#!/bin/sh
# Builds the AWF Apple Container guest init shim.
#
# The output is a static, native arm64 Linux binary — Apple Container guests are
# arm64 and Rosetta translation is never used. The build is deterministic
# (`-trimpath`, no VCS stamping, no cgo) so the same source always produces the
# same bytes and the recorded digest is meaningful.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
GO_VERSION=go1.25.0
VERSION=${VERSION:-dev}
OUTPUT=${OUTPUT:-"$ROOT/awf-apple-guest-init"}

actual=$(go env GOVERSION)
if [ "$actual" != "$GO_VERSION" ]; then
  echo "required Go toolchain: $GO_VERSION (found $actual)" >&2
  exit 1
fi

GOARCH=${GOARCH:-arm64}
if [ "$GOARCH" != "arm64" ]; then
  echo "Apple Container guests are arm64 only; refusing GOARCH=$GOARCH" >&2
  exit 1
fi

cd "$ROOT"
CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" \
  go build -trimpath -buildvcs=false -ldflags="-s -w -X main.version=$VERSION" -o "$OUTPUT" .
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUTPUT" > "$OUTPUT.sha256"
else
  shasum -a 256 "$OUTPUT" > "$OUTPUT.sha256"
fi
