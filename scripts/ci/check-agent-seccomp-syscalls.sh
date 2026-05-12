#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <agent-image>" >&2
  exit 1
fi

IMAGE="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SECCOMP_PROFILE="$REPO_ROOT/containers/agent/seccomp-profile.json"

if [ -n "${GITHUB_WORKSPACE:-}" ] && [ -f "${GITHUB_WORKSPACE}/containers/agent/seccomp-profile.json" ]; then
  SECCOMP_PROFILE="${GITHUB_WORKSPACE}/containers/agent/seccomp-profile.json"
fi

if [ ! -f "$SECCOMP_PROFILE" ]; then
  echo "Seccomp profile not found: $SECCOMP_PROFILE" >&2
  exit 1
fi

echo "Verifying seccomp blocks name_to_handle_at/open_by_handle_at for image: $IMAGE"

if ! docker run --rm --entrypoint sh "$IMAGE" -c 'command -v python3 >/dev/null 2>&1'; then
  echo "Image does not contain python3, cannot run seccomp syscall regression check: $IMAGE" >&2
  exit 1
fi

docker run --rm -i \
  --entrypoint python3 \
  --security-opt "seccomp=$SECCOMP_PROFILE" \
  "$IMAGE" - <<'PY'
import ctypes
import ctypes.util
import errno
import platform

arch = platform.machine().lower()
if arch not in {"x86_64", "amd64"}:
    raise SystemExit(
        f"Unsupported architecture for syscall number regression check: {arch}. "
        "This check currently validates x86_64 syscall numbers only."
    )

libc_path = ctypes.util.find_library("c")
if not libc_path:
    raise SystemExit("Unable to locate libc via ctypes.util.find_library('c')")
try:
    libc = ctypes.CDLL(libc_path, use_errno=True)
except OSError as exc:
    raise SystemExit(f"Unable to load libc ({libc_path}): {exc}") from exc

# x86_64 syscall numbers.
SYS_NAME_TO_HANDLE_AT = 303
SYS_OPEN_BY_HANDLE_AT = 304
AT_FDCWD = -100
MAX_HANDLE_SZ = 128


class FileHandle(ctypes.Structure):
    _fields_ = [
        ("handle_bytes", ctypes.c_uint),
        ("handle_type", ctypes.c_int),
        ("f_handle", ctypes.c_ubyte * MAX_HANDLE_SZ),
    ]


handle = FileHandle()
handle.handle_bytes = MAX_HANDLE_SZ
mount_id = ctypes.c_int(0)


def expect_eperm(name, syscall_nr, *args):
    ctypes.set_errno(0)
    rc = libc.syscall(syscall_nr, *args)
    err = ctypes.get_errno()
    if rc != -1 or err != errno.EPERM:
        raise SystemExit(f"{name} (nr={syscall_nr}) expected EPERM from seccomp, got rc={rc}, errno={err}")

expect_eperm(
    "name_to_handle_at",
    SYS_NAME_TO_HANDLE_AT,
    AT_FDCWD,
    ctypes.c_char_p(b"/etc/passwd"),
    ctypes.byref(handle),
    ctypes.byref(mount_id),
    0,
)
expect_eperm("open_by_handle_at", SYS_OPEN_BY_HANDLE_AT, -1, ctypes.byref(handle), 0)

print("Seccomp regression check passed: NR 303/304 denied with EPERM")
PY
