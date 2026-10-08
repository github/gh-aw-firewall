---
description: Experimental end-to-end Cloud Hypervisor script enclave smoke test with real mcpg
on:
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: write
env:
  GH_TOKEN: ${{ github.token }}
name: Smoke Enclave Cloud Hypervisor (Experimental)
runs-on: ubuntu-24.04
engine:
  id: copilot
  version: 1.0.34
  args: ["--allow-tool", "awf-enclave(enclave_run_script)"]
network:
  allowed:
    - defaults
    - github
tools:
  github: false
enclaves:
  - script:
    runtime: cloud-hypervisor
    repos:
      - repo: github/gh-aw-firewall
        sensitivity: public
    timeout: 120
    max-invocations: 1
safe-outputs:
  threat-detection:
    enabled: false
  messages:
    footer: "> Experimental Cloud Hypervisor enclave test by [{workflow_name}]({run_url})"
    run-started: "[{workflow_name}]({run_url}) is testing a script enclave through real mcpg..."
    run-success: "[{workflow_name}]({run_url}) completed. Cloud Hypervisor script enclave passed."
    run-failure: "[{workflow_name}]({run_url}) reports {status}. Cloud Hypervisor script enclave failed."
timeout-minutes: 20
sandbox:
  agent:
    id: awf
    version: v0.28.49
    runtime: docker
strict: false
concurrency:
  group: smoke-enclave-cloud-hypervisor
  cancel-in-progress: false
post-steps:
  - name: Validate enclave invocation and result
    if: always()
    env:
      AUDIT_LOG: /tmp/gh-aw/sandbox/firewall/audit/enclave.jsonl
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      node - "$AUDIT_LOG" "$OUTPUTS_FILE" <<'NODE'
      const fs = require("fs");
      const [auditPath, outputsPath] = process.argv.slice(2);
      const readRecords = file => fs.readFileSync(file, "utf8")
        .split("\n").filter(Boolean).map(line => JSON.parse(line));
      const auditRecords = readRecords(auditPath);
      const failures = auditRecords.filter(record => record.kind === "failure");
      if (failures.length !== 0) {
        throw new Error(`expected no failed enclave attempts, found ${failures.length}`);
      }
      const invocations = auditRecords.filter(record =>
        record.kind === "invocation" &&
        record.repo === "github/gh-aw-firewall" &&
        record.sensitivity === "public");
      if (invocations.length !== 1) {
        throw new Error(`expected one successful enclave invocation, found ${invocations.length}`);
      }
      const expected = 'ENCLAVE_CLOUD_HYPERVISOR_PASS {"package_json":true,"src":true}';
      if (!readRecords(outputsPath).some(record =>
        record.type === "noop" && record.message === expected)) {
        throw new Error("agent did not report the exact enclave result through noop");
      }
      NODE
---

# Experimental Cloud Hypervisor Script Enclave Smoke Test

This manual-only preview tests the real compiler-launched MCP Gateway and the
AWF-owned Cloud Hypervisor script executor. The primary agent runs on Docker.
Unsupported hosts fail closed; no Docker enclave fallback is permitted.
The published AWF binary and release-attested artifacts are pinned together.

Use `enclave_run_script` exactly once for `github/gh-aw-firewall`.
Do not use the current checkout, bash, GitHub tools, or network requests to answer.

The `schema` argument uses AWF's finite-disclosure schema algebra, not JSON
Schema. Pass exactly:

```json
{
  "type": "object",
  "fields": {
    "package_json": { "type": "boolean" },
    "src": { "type": "boolean" }
  }
}
```

Run this Python script inside the enclave:

```python
import json
import pathlib

root = pathlib.Path("/query/repo")
result = {
    "package_json": (root / "package.json").is_file(),
    "src": (root / "src").is_dir(),
}
pathlib.Path("/query/out").write_text(json.dumps(result), encoding="utf-8")
```

Only if both returned booleans are `true`, call `noop` with exactly:

```text
ENCLAVE_CLOUD_HYPERVISOR_PASS {"package_json":true,"src":true}
```

On any failure, call `safeoutputs missing_data`; never report failure via `noop`.

## Usage

Dispatch with `gh aw run smoke-enclave-cloud-hypervisor --ref <published-ref>`.
The runner must be GitHub-hosted Ubuntu x86_64 with KVM. Use the real mcpg and
AWF artifacts captured by the compiled workflow to investigate failures; this
test does not use the standalone probe's mock gateway.
