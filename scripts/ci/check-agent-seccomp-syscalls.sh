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

docker run --rm -i \
  --entrypoint python3 \
  --security-opt "seccomp=$SECCOMP_PROFILE" \
  "$IMAGE" - <<'PY'
import ctypes
import errno

libc = ctypes.CDLL(None, use_errno=True)
targets = {
    303: "name_to_handle_at",
    304: "open_by_handle_at",
}

for nr, name in targets.items():
    ctypes.set_errno(0)
    rc = libc.syscall(nr, -100, 0, 0, 0, 0)
    err = ctypes.get_errno()
    if rc != -1 or err != errno.EPERM:
        raise SystemExit(f"{name} (nr={nr}) expected EPERM from seccomp, got rc={rc}, errno={err}")

print("Seccomp regression check passed: NR 303/304 blocked with EPERM")
PY
