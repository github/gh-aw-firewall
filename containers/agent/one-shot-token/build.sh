#!/bin/bash
# Build the one-shot-token LD_PRELOAD library (C source, gcc)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_FILE="${SCRIPT_DIR}/one-shot-token.c"
OUTPUT_FILE="${SCRIPT_DIR}/one-shot-token.so"

echo "[build] Building one-shot-token..."

# Compile as a shared library with hardened build flags:
# -shared: create a shared library
# -fPIC: position-independent code (required for shared libs)
# -fvisibility=hidden: hide all symbols by default (only getenv/secure_getenv
#   are exported via __attribute__((visibility("default"))))
# -ldl: link with libdl for dlsym
# -lpthread: link with pthread for mutex
# -O2: optimize for performance
# -Wall -Wextra: enable warnings
# -s: strip symbol table and relocation info at link time
# -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0: disable glibc fortification macros
#   (e.g. __fprintf_chk) so the .so loads on musl-based hosts (Alpine/ARC runners)
gcc -shared -fPIC \
    -fvisibility=hidden \
    -O2 -Wall -Wextra -s \
    -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 \
    -o "${OUTPUT_FILE}" \
    "${SOURCE_FILE}" \
    -ldl -lpthread

# Remove remaining unneeded symbols (debug sections, build metadata)
strip --strip-unneeded "${OUTPUT_FILE}"

echo "[build] Successfully built: ${OUTPUT_FILE}"

# Verify it's a valid shared library
if file "${OUTPUT_FILE}" | grep -qE "shared object|dynamically linked"; then
    echo "[build] Verified: valid shared library"
else
    echo "[build] ERROR: Output is not a valid shared library"
    exit 1
fi

# Verify hardening: token names should NOT appear in binary
if strings -a "${OUTPUT_FILE}" | grep -qE '(COPILOT_GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)'; then
    echo "[build] WARNING: Cleartext token names still present in binary"
    exit 1
else
    echo "[build] Verified: no cleartext token names in binary"
fi
