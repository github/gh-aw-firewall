---
description: Smoke test enclave access to the gh-aw build surface
on:
  schedule: every 12h
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: write
env:
  GH_TOKEN: ${{ github.token }}
name: Smoke Enclave Build Test
engine:
  id: copilot
  version: 1.0.34
network:
  allowed:
    - defaults
    - github
tools:
  github:
    toolsets: [context]
    allowed: []
enclaves:
  - script:
    repos:
      - repo: github/gh-aw
        sensitivity: internal
    memory-limit: 2g
    tmpfs-limit: 1g
    timeout: 45
safe-outputs:
  threat-detection:
    enabled: false
  messages:
    footer: "> 🔐🏗️ *Enclave build test by [{workflow_name}]({run_url})*"
    run-started: "🔐🏗️ [{workflow_name}]({run_url}) is checking the gh-aw build surface through an enclave..."
    run-success: "🔐🏗️ [{workflow_name}]({run_url}) completed. Enclave build test passed. ✅"
    run-failure: "🔐🏗️ [{workflow_name}]({run_url}) reports {status}. Enclave build compatibility issue detected."
timeout-minutes: 20
sandbox:
  agent:
    id: awf
    version: v0.28.1
strict: false
concurrency:
  group: smoke-enclave-build-test
  cancel-in-progress: false
jobs:
  verify_enclave:
    needs: agent
    if: always() && needs.agent.result != 'skipped' && needs.agent.result != 'cancelled'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Download agent artifact
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: agent
          path: /tmp/gh-aw-agent
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
post-steps:
  - name: Validate enclave invocation
    if: always()
    env:
      AUDIT_LOG: /tmp/gh-aw/sandbox/firewall/audit/enclave.jsonl
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      node - "$AUDIT_LOG" "$OUTPUTS_FILE" <<'NODE'
      const fs = require("fs");
      const [auditPath, outputsPath] = process.argv.slice(2);
      const records = fs.readFileSync(auditPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const invocations = records.filter((record) =>
        record.kind === "invocation" &&
        record.repo === "github/gh-aw" &&
        record.sensitivity === "internal");
      if (invocations.length !== 1) {
        throw new Error(`expected one successful enclave invocation, found ${invocations.length}`);
      }
      const expected = 'ENCLAVE_BUILD_PASS {"module":"github.com/github/gh-aw",'
        + '"go_mod":true,"makefile":true,"cli_entrypoint":true,"workflow_package":true}';
      const outputs = fs.readFileSync(outputsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (!outputs.some((record) => record.type === "noop" && record.message === expected)) {
        throw new Error("agent did not report the exact enclave build result through noop");
      }
      NODE
---

# Smoke Test: Enclave Build Surface

Use `enclave_run_script` exactly once to inspect the pseudo-private
`github/gh-aw` repository. Do not use GitHub tools, network requests, or the
current checkout to answer.

The `schema` argument uses AWF's finite-disclosure schema algebra, not JSON
Schema. For an object, provide exactly `type` and `fields`; `fields` maps every
required output field to its finite schema. Do not use `properties`, `required`,
or `additionalProperties`. Use `{"type":"enum","values":[...]}` for a bounded
string value and `{"type":"boolean"}` for a boolean.

Pass this exact finite-disclosure schema:

```json
{
  "type": "object",
  "fields": {
    "module": { "type": "enum", "values": ["github.com/github/gh-aw"] },
    "go_mod": { "type": "boolean" },
    "makefile": { "type": "boolean" },
    "cli_entrypoint": { "type": "boolean" },
    "workflow_package": { "type": "boolean" }
  }
}
```

Run this Python script in the enclave:

```python
import json
import pathlib

root = pathlib.Path("/query/repo")
go_mod = root / "go.mod"
module = ""
if go_mod.is_file():
    for line in go_mod.read_text(encoding="utf-8").splitlines():
        if line.startswith("module "):
            module = line.removeprefix("module ").strip()
            break

result = {
    "module": module,
    "go_mod": go_mod.is_file(),
    "makefile": (root / "Makefile").is_file(),
    "cli_entrypoint": (root / "cmd/gh-aw/main.go").is_file(),
    "workflow_package": (root / "pkg/workflow").is_dir(),
}
pathlib.Path("/query/out").write_text(json.dumps(result), encoding="utf-8")
```

The test passes only when the returned object has module
`github.com/github/gh-aw` and every boolean is `true`.

Call `noop` with exactly this message when the test passes:

```text
ENCLAVE_BUILD_PASS {"module":"github.com/github/gh-aw","go_mod":true,"makefile":true,"cli_entrypoint":true,"workflow_package":true}
```

For any failure, call `safeoutputs missing_data`; never report a failure through
`noop`.