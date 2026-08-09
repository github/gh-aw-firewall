#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
GO_VERSION=go1.25.0
VERSION=${VERSION:-dev}
OUTPUT=${OUTPUT:-"$ROOT/firecracker-supervisor"}

actual=$(go env GOVERSION)
if [ "$actual" != "$GO_VERSION" ]; then
  echo "required Go toolchain: $GO_VERSION (found $actual)" >&2
  exit 1
fi

cd "$ROOT"
CGO_ENABLED=0 GOOS=linux GOARCH="${GOARCH:-amd64}" \
  go build -trimpath -buildvcs=false -ldflags="-s -w -X main.version=$VERSION" -o "$OUTPUT" .
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUTPUT" > "$OUTPUT.sha256"
else
  shasum -a 256 "$OUTPUT" > "$OUTPUT.sha256"
fi
