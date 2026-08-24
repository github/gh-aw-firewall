#!/usr/bin/env python3
"""Forward the enclave's narrow gh surface to the PAT-free AWF CLI proxy."""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

MAX_RESPONSE_BYTES = 10 * 1024 * 1024


def fail(message: str) -> int:
    print(f"gh: {message}", file=sys.stderr)
    return 1


def main() -> int:
    if os.environ.get("AWF_ENCLAVE_AGENT_GITHUB_PROFILE") != "issues-read-v1":
        return fail("GitHub CLI access is not enabled")
    proxy_url = os.environ.get("AWF_ENCLAVE_AGENT_GITHUB_PROXY_URL", "")
    capability_path = Path("/run/awf-enclave-github/capability")
    if proxy_url != "http://172.31.0.40:11000":
        return fail("GitHub CLI proxy configuration is invalid")
    try:
        capability = capability_path.read_text(encoding="ascii").strip()
    except OSError:
        return fail("GitHub CLI capability is unavailable")
    if not capability.startswith("awf-egh1.") or len(capability) > 4096:
        return fail("GitHub CLI capability is invalid")

    payload = json.dumps(
        {"args": sys.argv[1:], "stdin": None},
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{proxy_url}/exec",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {capability}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read(4096).decode("utf-8")).get("error")
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            detail = None
        return fail(detail or f"CLI proxy returned HTTP {error.code}")
    except (OSError, urllib.error.URLError):
        return fail("CLI proxy unavailable")
    if len(body) > MAX_RESPONSE_BYTES:
        return fail("CLI proxy response exceeded its bound")
    try:
        result = json.loads(body.decode("utf-8"))
        stdout = result.get("stdout", "")
        stderr = result.get("stderr", "")
        exit_code = result.get("exitCode", 1)
        if not isinstance(stdout, str) or not isinstance(stderr, str) or not isinstance(exit_code, int):
            raise ValueError
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, AttributeError):
        return fail("CLI proxy returned an invalid response")
    sys.stdout.write(stdout)
    sys.stderr.write(stderr)
    return exit_code if 0 <= exit_code <= 255 else 1


if __name__ == "__main__":
    raise SystemExit(main())
