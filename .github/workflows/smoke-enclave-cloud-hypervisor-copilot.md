---
description: Experimental Copilot execution with a Cloud Hypervisor primary and single-use Cloud Hypervisor agent enclave
on:
  workflow_dispatch:
if: github.repository == 'github/gh-aw-firewall' && github.ref_type == 'branch'
permissions:
  contents: read
  copilot-requests: write
name: Smoke Enclave Cloud Hypervisor Copilot (Experimental)
runs-on: ubuntu-24.04
features:
  cloud-hypervisor-agent-acceptance: true
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
    version: v0.28.64
    runtime: cloud-hypervisor
    config:
      filesystem:
        allow-write:
          - /tmp/gh-aw/aw_info.json
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
        record.type === "missing_data" || record.type === "missing_tool" ||
        record.type === "noop" || record.type === "report_incomplete");
      if (diagnostics.length !== 0) {
        throw new Error(`expected no contradictory failure outputs, found ${diagnostics.length}`);
      }
      const results = outputs.filter(record => record.type === "report_smoke_result");
      if (results.length !== 1 || results[0].result !== expected) {
        throw new Error("primary did not report the exact Copilot enclave result");
      }
      NODE
---

# Experimental Cloud Hypervisor Copilot Agent Enclave Smoke

Test a real Copilot CLI inside a fresh Cloud Hypervisor **agent** enclave,
not a Python script enclave. The primary Copilot also runs in a separate
Cloud Hypervisor VM and requests exactly one
`enclave_run_agent` invocation through the compiler-launched MCP Gateway.
Only the enclave agent may inspect the repository seed.

Run exactly this command using the shell tool:

```bash
awf-enclave enclave_run_agent . <<'JSON'
{
  "privateRepo": "github/gh-aw-firewall",
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

This manual-only public-fixture acceptance test preserves the script smoke
separately. Both primary and enclave select Cloud Hypervisor; mixed backends and
Docker enclave fallback are prohibited. AWF admits this exact workflow identity,
static public repository and single-use Copilot policy through a narrow
acceptance gate, not general production support. The enclave's only network
peer is its dedicated credential-injecting
API proxy; no GitHub MCP access, direct model credentials, primary workspace,
or safe-output tools are granted to it. The finite result schema, one-invocation
limit, task/output sizes and execution timeout are enforced independently of the
model settings. The eight-request and 2,048-token settings are **advisory only**:
the pinned guest validates positivity but does not apply these limits to Copilot.
The dedicated API proxy inherits general proxy limits (including `maxRuns: 500`),
not those per-enclave settings. This workflow does not claim an enforced
eight-request or 2,048-token inference ceiling.

AWF and guest assets remain pinned to verified v0.28.64, with the official
gh-aw v0.92.3 setup, mcpg v0.4.33 and primary Copilot 1.0.96.
The guest Copilot CLI is the version baked into the attested agent rootfs,
not installed or upgraded by this workflow.
Manual branch runs, including main, build source host/infra code and use the
checked-in v0.28.64 guest artifact pin, including the merged bounded-verification
storage and unprivileged enclave vsock-port fixes (#10181).
Tag runs are not admitted.
Compilation additionally requires the companion compiler agent-acceptance
support; unmodified v0.92.3 rejects this topology. Generated compiler provenance
must identify that support rather than claim an unchanged official compiler.
No local or unattested guest replacement is permitted.

The v0.28.64 release pins in the lock were manually updated under an explicit
pins-only exception, not regenerated with an official compiler. The recorded
development compiler identifies the original generation only; its exact binary
is not available as a verified official download. Source hashes are refreshed
without changing compiler provenance. Both that compiler's acceptance gate and
the current AWF host gate still require v0.28.62 for this agent fixture.
The v0.28.64 pin therefore remains blocked by host acceptance; this update does
not widen that gate or claim the PR branch can successfully execute the enclave.

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
