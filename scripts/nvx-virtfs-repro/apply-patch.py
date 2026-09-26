#!/usr/bin/env python3
"""Mount the microVM virtio-fs share inside the sandbox container rootfs."""
import sys

MOUNT = r'''
virtfs_target=
virtfs_tag=$(cmdline_value virtfs_tag || true)
if [ -n "$virtfs_tag" ]; then
    [ "$virtfs_tag" = microvm ] || fatal "unexpected virtio-fs tag: $virtfs_tag"
    virtfs_dir=$(cmdline_value virtfs_dir || true)
    virtfs_mode=$(cmdline_value virtfs_mode || true)
    case "$virtfs_mode" in ro | rw) ;; *) fatal "invalid virtio-fs mode" ;; esac
    case "$virtfs_dir" in
        /*) ;;
        *) fatal "virtio-fs target must be absolute" ;;
    esac
    case "$virtfs_dir" in
        / | /proc | /proc/* | /sys | /sys/* | /dev | /dev/* | /.nvx-agent | /.nvx-agent/* | *//* | */./* | */../* | */. | */..)
            fatal "virtio-fs target is not permitted: $virtfs_dir" ;;
    esac
    virtfs_target=$rootfs$virtfs_dir
    [ ! -L "$virtfs_target" ] || fatal "virtio-fs target is a symlink"
    mkdir -p "$virtfs_target" || fatal "failed to create virtio-fs target"
    mount -t virtiofs -o "$virtfs_mode,nosuid,nodev" "$virtfs_tag" "$virtfs_target" ||
        fatal "failed to mount virtio-fs share at $virtfs_dir"
    echo "NVX-SANDBOX-VIRTFS: mounted $virtfs_tag at $virtfs_dir ($virtfs_mode)"
fi
'''

UMOUNT = r'''if [ -n "$virtfs_target" ] && ! umount "$virtfs_target"; then
    echo "NVX-SANDBOX-ERROR: failed to unmount the virtio-fs share" >&2
    status=1
fi
'''

MOUNT_ANCHOR = '    "$rootfs" || fatal "failed to assemble the container overlay"\n'
UMOUNT_ANCHOR = 'if ! umount "$rootfs"; then\n'

path = sys.argv[1]
text = open(path).read()
for anchor in (MOUNT_ANCHOR, UMOUNT_ANCHOR):
    if text.count(anchor) != 1:
        sys.exit(f"anchor not found exactly once: {anchor!r}")
if "NVX-SANDBOX-VIRTFS" in text:
    sys.exit("already patched")
text = text.replace(MOUNT_ANCHOR, MOUNT_ANCHOR + MOUNT)
text = text.replace(UMOUNT_ANCHOR, UMOUNT + UMOUNT_ANCHOR)
open(path, "w").write(text)
print(f"patched {path}")
