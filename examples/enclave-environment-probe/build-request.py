"""Generate tools/call parameters locally; this does not dispatch an enclave."""

import json
from pathlib import Path

import probe

source = Path(__file__).with_name("probe.py").read_text(encoding="ascii")
if len(source.encode("utf8")) > 16384:
    raise SystemExit("probe source exceeded bound")
print(json.dumps({
    "name": "enclave_run_script",
    "arguments": {
        "privateRepo": "github/gh-aw-firewall",
        "schema": probe.schema(),
        "script": source,
    },
}, sort_keys=True, separators=(",", ":")))
