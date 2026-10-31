#!/usr/bin/python3
"""Materialize the assigned seed into bounded tmpfs, then run the script."""

import os
import errno
import json
import runpy
import shutil
import stat
import sys
import time
from pathlib import Path

SEED = Path("/awf/seed")
REPO = Path("/query/repo")
SCRIPT = "/awf/query-script.py"
OUTPUT = Path("/awf/out")

def enable_public_capture():
    if os.environ.get("AWF_ENCLAVE_DEBUG_PUBLIC") != "true":
        return None
    from public_debug_capture import PublicDebugCapture
    return PublicDebugCapture()

def make_repository_writable():
    for root, directories, files in os.walk(REPO, followlinks=False):
        for name in [".", *directories, *files]:
            target = Path(root) if name == "." else Path(root) / name
            mode = target.lstat().st_mode
            if stat.S_ISREG(mode) or stat.S_ISDIR(mode):
                target.chmod(stat.S_IMODE(mode) | stat.S_IWUSR)

def main():
    started = time.monotonic()
    phase = "startup"

    def diagnostic(status, **fields):
        # stderr is discarded by default; public-fixture debug captures it
        # outside the guest. Never copy script, environment or exception text.
        print(json.dumps({
            "component": "enclave-script",
            "phase": phase,
            "status": status,
            "elapsedMs": max(0, round((time.monotonic() - started) * 1000)),
            **fields,
        }, separators=(",", ":")), file=sys.stderr, flush=True)

    try:
        diagnostic("started", uid=os.getuid(), gid=os.getgid())
        phase = "seed-copy"
        diagnostic("started")
        shutil.copytree(SEED, REPO, symlinks=True)
        make_repository_writable()
        diagnostic("passed")
        phase = "output-link"
        diagnostic("started")
        Path("/query/out").symlink_to(OUTPUT)
        diagnostic("passed")
        phase = "working-directory"
        diagnostic("started")
        os.chdir("/query")
        diagnostic("passed")
        phase = "script-execute"
        diagnostic("started")
        if os.environ.get("AWF_ENCLAVE_DEBUG_PUBLIC") == "true" \
                or os.environ.get("AWF_ENCLAVE_SCRIPT_DEBUG_PROGRESS") == "true":
            print('{"event":"progress","stage":"runtime-paths-ready"}', file=sys.stderr, flush=True)
        runpy.run_path(SCRIPT, run_name="__main__")
        diagnostic("passed")
    except BaseException as error:
        error_type = type(error).__name__
        diagnostic(
            "passed" if isinstance(error, SystemExit) and error.code in (None, 0) else "failed",
            errorType=error_type if error_type in (
                "OSError", "PermissionError", "FileNotFoundError", "FileExistsError",
                "SyntaxError", "ValueError", "TypeError", "RuntimeError",
                "SystemExit", "KeyboardInterrupt", "MemoryError",
            ) else "unknown",
            code=errno.errorcode.get(error.errno, "unknown") if isinstance(error, OSError) else "none",
        )
        raise


if __name__ == "__main__":
    capture = enable_public_capture()
    try:
        main()
    except BaseException as error:
        if capture and not isinstance(error, SystemExit):
            import traceback
            traceback.print_exc()
        raise
    finally:
        if capture:
            capture.close()
