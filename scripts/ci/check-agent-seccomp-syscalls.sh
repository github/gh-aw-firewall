#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <agent-image> [docker-platform]" >&2
  exit 1
fi

IMAGE="$1"
PLATFORM="${2:-}"
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

if ! grep -q '"name_to_handle_at"' "$SECCOMP_PROFILE" || ! grep -q '"open_by_handle_at"' "$SECCOMP_PROFILE"; then
  echo "Seccomp profile must explicitly deny name_to_handle_at and open_by_handle_at: $SECCOMP_PROFILE" >&2
  exit 1
fi

DOCKER_PLATFORM_ARGS=()
if [ -n "$PLATFORM" ]; then
  DOCKER_PLATFORM_ARGS=(--platform "$PLATFORM")
fi

echo "Verifying seccomp denies name_to_handle_at/open_by_handle_at for image: $IMAGE ${PLATFORM:+($PLATFORM)}"

set +e
docker run --rm "${DOCKER_PLATFORM_ARGS[@]}" --entrypoint sh "$IMAGE" -c 'command -v python3 >/dev/null 2>&1 || exit 42'
python_check_status=$?
set -e
if [ "$python_check_status" -eq 42 ]; then
  echo "Image does not contain python3, cannot run seccomp syscall regression check: $IMAGE" >&2
  exit 1
fi
if [ "$python_check_status" -ne 0 ]; then
  echo "Unable to execute preflight command in image: $IMAGE ${PLATFORM:+($PLATFORM)}" >&2
  exit "$python_check_status"
fi

run_probe() {
  local mode="$1"
  local seccomp_args=()
  if [ "$mode" = "seccomp" ]; then
    seccomp_args=(--security-opt "seccomp=$SECCOMP_PROFILE")
  fi

  docker run --rm -i \
    "${DOCKER_PLATFORM_ARGS[@]}" \
    "${seccomp_args[@]}" \
    --entrypoint python3 \
    "$IMAGE" - "$mode" <<'PY'
import ctypes
import errno
import platform
import sys

mode = sys.argv[1]

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long

arch = platform.machine().lower()
syscall_map = {
    "x86_64": (303, 304),
    "amd64": (303, 304),
    "aarch64": (264, 265),
    "arm64": (264, 265),
}
if arch not in syscall_map:
    raise SystemExit(f"Unsupported architecture for syscall regression check: {arch}")

SYS_NAME_TO_HANDLE_AT, SYS_OPEN_BY_HANDLE_AT = syscall_map[arch]
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

def call_syscall(syscall_nr, *args):
    ctypes.set_errno(0)
    rc = int(libc.syscall(syscall_nr, *args))
    return rc, ctypes.get_errno()

name_rc, name_err = call_syscall(
    SYS_NAME_TO_HANDLE_AT,
    AT_FDCWD,
    ctypes.c_char_p(b"/etc/passwd"),
    ctypes.byref(handle),
    ctypes.byref(mount_id),
    0,
)
open_rc, open_err = call_syscall(SYS_OPEN_BY_HANDLE_AT, -1, ctypes.byref(handle), 0)

if mode == "control":
    if name_rc == -1 and name_err == errno.EPERM:
        raise SystemExit(
            f"name_to_handle_at (nr={SYS_NAME_TO_HANDLE_AT}) returned EPERM without seccomp; "
            "cannot attribute denial to seccomp"
        )
    print(
        "Control probe (no seccomp): "
        f"name_to_handle_at rc={name_rc} errno={name_err}; "
        f"open_by_handle_at rc={open_rc} errno={open_err}"
    )
else:
    if name_rc != -1 or name_err != errno.EPERM:
        raise SystemExit(
            f"name_to_handle_at (nr={SYS_NAME_TO_HANDLE_AT}) expected EPERM with seccomp, "
            f"got rc={name_rc} errno={name_err}"
        )
    if open_rc != -1 or open_err != errno.EPERM:
        raise SystemExit(
            f"open_by_handle_at (nr={SYS_OPEN_BY_HANDLE_AT}) expected EPERM with seccomp, "
            f"got rc={open_rc} errno={open_err}"
        )
    print("Seccomp probe: NR name_to_handle_at/open_by_handle_at denied with EPERM")
PY
}

run_probe control
run_probe seccomp
