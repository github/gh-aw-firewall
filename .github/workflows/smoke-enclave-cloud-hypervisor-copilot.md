---
description: Experimental Copilot execution inside a single-use Cloud Hypervisor agent enclave
on:
  workflow_dispatch:
if: github.repository == 'github/gh-aw-firewall'
permissions:
  contents: read
  copilot-requests: write
name: Smoke Enclave Cloud Hypervisor Copilot (Experimental)
runs-on: ubuntu-24.04
engine:
  id: copilot
  version: 1.0.96
  env:
    GH_TOKEN: ${{ github.token }}
    GH_AW_HARNESS_STARTUP_RETRIES: "0"
    GH_AW_HARNESS_MAX_RETRIES: "0"
  args: ["--allow-tool", "awf-enclave(enclave_run_agent)"]
network:
  allowed:
    - defaults
    - github
tools:
  github: false
enclaves:
  - agent:
      engine: copilot
      model: claude-sonnet-5
      max-task-bytes: 4096
      max-model-requests: 8
      max-model-tokens: 2048
    runtime: cloud-hypervisor
    repos:
      - repo: github/gh-aw-firewall
        sensitivity: public
    timeout: 90
    max-output-bytes: 256
    max-invocations: 1
safe-outputs:
  github-token: ${{ secrets.GITHUB_TOKEN }}
  report-failed-jobs: false
  jobs:
    report-smoke-result:
      description: "Record the successful Copilot enclave smoke result in the Actions summary."
      runs-on: ubuntu-slim
      if: needs.agent.result == 'success'
      output: "Copilot enclave smoke result recorded."
      inputs:
        result:
          description: "The exact successful enclave result."
          required: true
          type: string
      steps:
        - name: Record enclave result
          run: printf '%s\n' 'ENCLAVE_COPILOT_PASS {"package_json":true,"src":true}' >> "$GITHUB_STEP_SUMMARY"
  report-failure-as-issue: false
  report-incomplete:
    create-issue: false
  missing-tool:
    create-issue: false
  threat-detection:
    enabled: false
  messages:
    footer: "> Experimental Cloud Hypervisor Copilot enclave test by [{workflow_name}]({run_url})"
    run-started: "[{workflow_name}]({run_url}) is testing Copilot inside an agent enclave..."
    run-success: "[{workflow_name}]({run_url}) completed. Copilot agent enclave passed."
    run-failure: "[{workflow_name}]({run_url}) reports {status}. Copilot agent enclave failed."
  timeout-minutes: 20
timeout-minutes: 20
sandbox:
  agent:
    id: awf
    version: v0.28.62
strict: false
concurrency:
  group: smoke-enclave-cloud-hypervisor-copilot
  cancel-in-progress: false
jobs:
  agent:
    timeout-minutes: 20
steps:
  - name: Prepare host-only enclave debug collection
    env:
      DEBUG_RUN_KEY: ${{ github.run_id }}-${{ github.run_attempt }}
    run: |
      sudo install -d -m 0711 -o root -g root /var/lib/awf-enclave-smoke-export
      sudo install -m 0600 -o root -g root scripts/ci/collect-enclave-smoke-debug.cjs /var/lib/awf-enclave-smoke-export/collector.cjs
      sudo node /var/lib/awf-enclave-smoke-export/collector.cjs prepare "$DEBUG_RUN_KEY"
post-steps:
  - name: Collect host-only public enclave debug evidence
    id: collect-enclave-debug
    if: always()
    env:
      DEBUG_RUN_KEY: ${{ github.run_id }}-${{ github.run_attempt }}
    run: |
      sudo node /var/lib/awf-enclave-smoke-export/collector.cjs collect "$DEBUG_RUN_KEY" "$(id -u)" "$(id -g)"
  - name: Upload public enclave debug evidence
    if: always() && steps.collect-enclave-debug.outcome == 'success'
    uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9
    with:
      name: public-enclave-debug-${{ github.run_id }}-${{ github.run_attempt }}
      path: /var/lib/awf-enclave-smoke-export/${{ github.run_id }}-${{ github.run_attempt }}/upload/
      retention-days: 1
      if-no-files-found: error
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
      const invocations = auditRecords.filter(record => record.kind === "invocation");
      if (invocations.length !== 1 ||
          invocations[0].repo !== "github/gh-aw-firewall" ||
          invocations[0].sensitivity !== "public") {
        throw new Error(`expected one successful agent enclave invocation, found ${invocations.length}`);
      }
      const expected = 'ENCLAVE_COPILOT_PASS {"package_json":true,"src":true}';
      const outputs = readRecords(outputsPath);
      const diagnostics = outputs.filter(record =>
        record.type === "missing_data" || record.type === "missing_tool");
      if (diagnostics.length !== 0) {
        throw new Error(`expected no missing-data or missing-tool diagnostics, found ${diagnostics.length}`);
      }
      const results = outputs.filter(record => record.type === "report_smoke_result");
      if (results.length !== 1 || results[0].result !== expected) {
        throw new Error("primary did not report the exact Copilot enclave result");
      }
      NODE
---

# Experimental Cloud Hypervisor Copilot Agent Enclave Smoke

Test a real Copilot CLI inside a fresh Cloud Hypervisor **agent** enclave,
not a Python script enclave. The primary Copilot requests exactly one
`enclave_run_agent` invocation through the compiler-launched MCP Gateway.
Only the enclave agent may inspect the repository seed.

Run exactly this command using the shell tool:

```bash
awf-enclave enclave_run_agent . <<'JSON'
{
  "repo": "github/gh-aw-firewall",
  "schema": {
    "type": "object",
    "fields": {
      "package_json": { "type": "boolean" },
      "src": { "type": "boolean" }
    }
  },
  "prompt": "Inspect the read-only repository seed at /awf/seed, your working directory. Use your shell or file tools to check whether /awf/seed/package.json is a regular file and /awf/seed/src is a directory. Do not infer these answers from this prompt. Do not modify repository files, install packages, access GitHub, or use network tools. Return exactly one JSON object with boolean fields package_json and src reflecting those checks, with no extra fields or prose."
}
JSON
```

Require `status: ok` and both booleans exactly `true`. Only then report through
the safe-output CLI:

```bash
printf '%s\n' '{"result":"ENCLAVE_COPILOT_PASS {\"package_json\":true,\"src\":true}"}' | safeoutputs report_smoke_result .
```

On an error, missing tool, timeout, or false boolean, do not retry, do not inspect
the primary checkout as a substitute, and do not report a passing result.
Use `safeoutputs noop` to record the failure. Host post-validation rejects
failures, absent invocations, contradictory diagnostics and missing pass output.

## Trust and iteration boundaries

This manual-only public-fixture preview preserves the script smoke separately.
The primary uses the normal Docker sandbox; the separate agent enclave selects
Cloud Hypervisor with no Docker enclave fallback. The pinned official compiler
does not support an agent enclave with a Cloud Hypervisor primary.
The enclave's only network peer is its dedicated credential-injecting
API proxy; no GitHub MCP access, direct model credentials, primary workspace,
or safe-output tools are granted to it. The two-boolean finite schema, one-call
limit and model/task/output budgets bound disclosure and inference.

AWF and guest assets remain pinned to verified v0.28.62, with the official
gh-aw v0.92.3 compiler/setup, mcpg v0.4.33 and primary Copilot 1.0.96.
The guest Copilot CLI is the version baked into the attested agent rootfs,
not installed or upgraded by this workflow.
Manual non-main branch runs build source host/infra code and use the checked-in
v0.28.62 guest compatibility pin. They include the merged bounded-verification
storage and unprivileged enclave vsock-port fixes; main/tag published v0.28.62
host runs do not yet contain those fixes and are not equivalent.
No local or unattested guest replacement is permitted.

The existing host-only collector exports only allowlisted, bounded diagnostics
for this static public repository. Public fixture logs are intentionally visible
to Actions artifact readers, retained for one day, and never contain intentionally
injected secrets or environment dumps. Raw capture is not enabled for private
repositories or arbitrary tasks.

The separate compiler/client 120-second HTTP timeout remains unresolved.
The 90-second execution budget can still pad a slow operation to a 120-second
bucket plus wake tolerance and jitter; this workflow does not override that
deadline. A successful local compile or regression test is not evidence of
successful Copilot enclave inference. Creating this workflow does not dispatch
it or authorize a release.
