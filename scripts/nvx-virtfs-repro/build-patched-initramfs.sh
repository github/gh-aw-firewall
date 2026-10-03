#!/bin/sh
# Usage: build-patched-initramfs.sh <input initramfs.cpio.gz> <output initramfs.cpio.gz>
# Appends a root-owned cpio member that overrides /sbin/nvx-init-agent; the
# kernel unpacks concatenated initramfs archives in order, so the base image is
# left byte-for-byte intact.
set -eu
in=$1
out=$2
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/sbin"
gzip -dc "$in" | (cd "$work" && cpio -id --quiet sbin/nvx-init-agent)
python3 "$here/apply-patch.py" "$work/sbin/nvx-init-agent"
sh -n "$work/sbin/nvx-init-agent"
chmod 0755 "$work/sbin/nvx-init-agent"
{
    cat "$in"
    (cd "$work" && printf 'sbin/nvx-init-agent\n' | cpio -o -H newc -R 0:0 --quiet) | gzip -9 -n
} >"$out.tmp"
mv "$out.tmp" "$out"
echo "patched initramfs: $out ($(wc -c <"$out") bytes)"
