#!/bin/bash
# Reproduce microsoft/nvx#216: sandbox-mode NVX never mounts the --mount
# virtio-fs share inside the workload container.
#
# Runs OpenVMM the way AWF does (sandbox blocks + one-shot + workload identity)
# with an added --mount/--mount-deny, once with the stock initramfs and once
# with the patched one from build-patched-initramfs.sh.
#
# Requirements: x86_64 Linux with /dev/kvm, sudo, gh, erofs-utils, e2fsprogs,
# python3, curl, acl. Usage: ./repro.sh [nvx-release-tag]
# Set PATCHED_OPENVMM=/path/to/openvmm to also test --mount-owner caller.
set -euo pipefail

NVX_RELEASE=${1:-v0.1.0-dev.d561c4300ebe}
ALPINE_URL=https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.3-x86_64.tar.gz
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d /tmp/nvx-virtfs-repro.XXXXXX)
uid=1001
gid=1001
echo "work dir: $work"

gh release download "$NVX_RELEASE" -R microsoft/nvx -p 'nvx-*-linux-kvm.tar.gz' -D "$work"
tar -xzf "$work"/nvx-*-linux-kvm.tar.gz -C "$work"
pkg=$(find "$work" -maxdepth 1 -type d -name 'nvx-*-linux-kvm' | head -1)
openvmm=$pkg/bin/openvmm
patched_openvmm=${PATCHED_OPENVMM:-}
kernel=$pkg/guest/vmlinux
stock_initrd=$pkg/guest/initramfs.cpio.gz
patched_initrd=$work/initramfs-virtfs.cpio.gz
"$here/build-patched-initramfs.sh" "$stock_initrd" "$patched_initrd"

# Distro layer: Alpine minirootfs + workload user + probe entrypoint.
rootfs=$work/rootfs
mkdir -p "$rootfs"
curl -fsSL "$ALPINE_URL" | tar -xz -C "$rootfs"
echo "runner:x:$uid:$gid:runner:/home/runner:/bin/sh" >>"$rootfs/etc/passwd"
echo "runner:x:$gid:" >>"$rootfs/etc/group"
mkdir -p "$rootfs/home/runner"
cat >"$rootfs/usr/local/bin/virtfs-probe" <<'PROBE'
#!/bin/sh
# Args: <share dir> <rw|ro>
dir=$1
mode=$2
fail=0
check() { if eval "$2"; then echo "PROBE-PASS: $1"; else echo "PROBE-FAIL: $1"; fail=1; fi; }
echo "PROBE: id=$(id)"
grep -E " $dir " /proc/mounts | sed 's/^/PROBE-MOUNT: /' || echo "PROBE-MOUNT: none at $dir"
check "share is a virtiofs mount" "grep -q ' $dir virtiofs ' /proc/mounts"
check "host file visible" "[ \"\$(cat $dir/host.txt 2>/dev/null)\" = from-host ]"
check "denied path hidden" "[ ! -e $dir/secrets ]"
if [ "$mode" = rw ]; then
    check "guest write succeeds" "echo from-guest >$dir/guest.txt"
    check "guest mkdir succeeds" "mkdir $dir/guest-dir && echo nested >$dir/guest-dir/nested.txt"
    check "guest symlink succeeds" "ln -s guest.txt $dir/guest-link"
    if echo appended >>$dir/host.txt 2>/dev/null; then
        echo "PROBE-INFO: appending to existing host-owned file succeeded"
    else
        echo "PROBE-INFO: appending to existing host-owned file failed"
    fi
    # The host only writes host-edit.txt after it sees guest.txt, which proves
    # both directions are live while the VM is still running.
    i=0
    while [ ! -e "$dir/host-edit.txt" ] && [ $i -lt 60 ]; do sleep 1; i=$((i + 1)); done
    check "live host edit visible" "[ \"\$(cat $dir/host-edit.txt 2>/dev/null)\" = edited-live ]"
else
    check "read-only share rejects writes" "! (echo x >$dir/guest.txt) 2>/dev/null"
fi
echo "PROBE-RESULT: $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
PROBE
chmod 0755 "$rootfs/usr/local/bin/virtfs-probe"
distro_uuid=$(python3 -c 'import uuid; print(uuid.uuid4())')
mkfs.erofs --quiet --all-root -U "$distro_uuid" "$work/distro.erofs" "$rootfs"

run_case() {
    local name=$1 initrd=$2 mode=$3 vmm=${4:-$openvmm} owner=${5:-} runas=${6:-root}
    local share=$work/share-$name scratch=$work/scratch-$name.ext4 log=$work/$name.log
    mkdir -p "$share/secrets"
    echo from-host >"$share/host.txt"
    echo super-secret >"$share/secrets/token"
    sudo chown -R "$uid:$gid" "$share"
    truncate -s 256M "$scratch"
    mke2fs -t ext4 -F -q -m 0 -O ^has_journal \
        -E "root_owner=$uid:$gid" "$scratch"

    local cmdline="nvx_sandbox=1 nvx_layer=distro,0xd0003000,$distro_uuid"
    cmdline+=" nvx_scratch=0xd0006000,ext4 nvx_entrypoint=/usr/local/bin/virtfs-probe"
    cmdline+=" nvx_arg=/workspace nvx_arg=$mode nvx_hostname=virtfs-repro"

    local launcher=(sudo)
    if [ "$runas" != root ]; then
        # AWF-like: dedicated non-root VMM account; caps only as requested.
        local caps=${runas#*:}
        runas=${runas%%:*}
        sudo setfacl -m "u:$runas:rw" /dev/kvm
        sudo setfacl -R -m "u:$runas:rwX" "$work"
        # The share keeps plain DAC so the VMM gets no extra access to it.
        sudo setfacl -R -b "$share"
        sudo setfacl -m "u:$runas:rx" "$(dirname "$work")"
        launcher=(sudo setpriv --reuid "$runas" --regid "$runas" --clear-groups)
        if [ "$caps" != none ]; then
            launcher+=(--inh-caps "$caps" --ambient-caps "$caps" --bounding-set "-all,$caps")
        else
            launcher+=(--inh-caps -all --bounding-set -all)
        fi
        launcher+=(--)
        echo "VMM caps: $("${launcher[@]}" grep -E '^Cap(Eff|Amb)' /proc/self/status | tr '\n' ' ')"
    fi
    local extra=()
    [ -n "$owner" ] && extra+=(--mount-owner "$owner")
    echo "=== case $name (mode=$mode, initrd=$(basename "$initrd"), vmm=$(basename "$(dirname "$vmm")"), owner=${owner:-default}, runas=$runas) ==="
    "${launcher[@]}" "$vmm" --machine microvm \
        --microvm-sandbox-block "distro:file:$work/distro.erofs,ro" \
        --microvm-sandbox-block "scratch:file:$scratch" \
        --microvm-workload-identity "$uid:$gid" \
        --microvm-lifecycle one-shot \
        --single-process --hypervisor kvm --memory 512M \
        --kernel "$kernel" --initrd "$initrd" --cmdline "$cmdline" \
        --mount "/workspace,$share,$mode" \
        --mount-deny "$share/secrets" \
        "${extra[@]}" \
        --microvm-report "$work/$name.report.json" \
        >"$log" 2>&1 &
    local vm=$!

    if [ "$mode" = rw ]; then
        for _ in $(seq 60); do
            if sudo test -e "$share/guest.txt"; then
                echo "HOST: saw guest.txt while VM running: $(sudo cat "$share/guest.txt")"
                echo "HOST: owner $(sudo stat -c %u:%g "$share/guest.txt")"
                echo edited-live | sudo tee "$share/host-edit.txt" >/dev/null
                break
            fi
            kill -0 "$vm" 2>/dev/null || break
            sleep 1
        done
    fi
    local status=0
    wait "$vm" || status=$?
    echo "openvmm exit: $status"
    for f in guest.txt guest-dir guest-dir/nested.txt guest-link host.txt host-edit.txt; do
        sudo test -e "$share/$f" -o -L "$share/$f" &&
            echo "HOST-OWNER: $f $(sudo stat -c '%u:%g %A' "$share/$f")"
    done
    grep -E "PROBE|NVX-SANDBOX|virtfs|virtiofs" "$log" || true
    [ -f "$work/$name.report.json" ] && sudo cat "$work/$name.report.json" && echo
}

run_case stock-rw "$stock_initrd" rw || true
run_case patched-rw "$patched_initrd" rw || true
run_case patched-ro "$patched_initrd" ro || true
if [ -n "$patched_openvmm" ]; then
    id nvxvmm >/dev/null 2>&1 || sudo useradd --system --user-group --no-create-home nvxvmm
    run_case owner-caller-root "$patched_initrd" rw "$patched_openvmm" caller root || true
    run_case owner-default-root "$patched_initrd" rw "$patched_openvmm" "" root || true
    run_case owner-caller-nonroot-setid "$patched_initrd" rw "$patched_openvmm" caller "nvxvmm:+setuid,+setgid" || true
    run_case owner-caller-nonroot-nocaps "$patched_initrd" rw "$patched_openvmm" caller "nvxvmm:none" || true
fi
echo "logs in $work"
