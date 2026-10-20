#!/bin/sh
set -eu
policy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
staging=$(mktemp -d /run/awf-ca-store.XXXXXX)
trap 'rm -rf "$staging"' EXIT HUP INT TERM
sh "$policy_dir/filter-ca-store.sh" "$staging" /etc/ssl/certs
# This script is for image-local stores only. Host mounts are handled by the
# agent entrypoint with private, read-only mount overlays instead.
find /etc/ssl/certs -maxdepth 1 \( -type f -o -type l \) -delete
cp -a "$staging/certs/." /etc/ssl/certs/
cp "$staging/ca-certificates.crt" /etc/ssl/certs/ca-certificates.crt
