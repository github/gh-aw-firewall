---
description: Experimental end-to-end Cloud Hypervisor script enclave smoke test with real mcpg
on:
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: write
name: Smoke Enclave Cloud Hypervisor (Experimental)
runs-on: ubuntu-24.04
engine:
  id: copilot
  version: 1.0.34
  env:
    GH_TOKEN: ${{ github.token }}
    GH_AW_HARNESS_STARTUP_RETRIES: "0"
    GH_AW_HARNESS_MAX_RETRIES: "0"
  args: ["--allow-tool", "awf-enclave(enclave_run_script)"]
network:
  allowed:
    - defaults
    - github
tools:
  github: false
enclaves:
  - script: {}
    runtime: cloud-hypervisor
    repos:
      - repo: github/gh-aw-firewall
        sensitivity: public
    timeout: 120
    max-invocations: 1
safe-outputs:
  github-token: ${{ secrets.GITHUB_TOKEN }}
  report-failed-jobs: false
  jobs:
    report-smoke-result:
      description: "Record the successful enclave smoke result in the Actions summary."
      runs-on: ubuntu-slim
      if: needs.agent.result == 'success'
      output: "Smoke result recorded."
      inputs:
        result:
          description: "The exact successful enclave result."
          required: true
          type: string
      steps:
        - name: Record enclave result
          run: printf '%s\n' 'ENCLAVE_CLOUD_HYPERVISOR_PASS {"package_json":true,"src":true}' >> "$GITHUB_STEP_SUMMARY"
  report-failure-as-issue: false
  report-incomplete:
    create-issue: false
  missing-tool:
    create-issue: false
  threat-detection:
    enabled: false
  messages:
    footer: "> Experimental Cloud Hypervisor enclave test by [{workflow_name}]({run_url})"
    run-started: "[{workflow_name}]({run_url}) is testing a script enclave through real mcpg..."
    run-success: "[{workflow_name}]({run_url}) completed. Cloud Hypervisor script enclave passed."
    run-failure: "[{workflow_name}]({run_url}) reports {status}. Cloud Hypervisor script enclave failed."
  timeout-minutes: 20
timeout-minutes: 20
sandbox:
  agent:
    id: awf
    version: v0.28.58
    runtime: cloud-hypervisor
strict: false
concurrency:
  group: smoke-enclave-cloud-hypervisor
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
        throw new Error(`expected one successful enclave invocation, found ${invocations.length}`);
      }
      const expected = 'ENCLAVE_CLOUD_HYPERVISOR_PASS {"package_json":true,"src":true}';
      const outputs = readRecords(outputsPath);
      const diagnostics = outputs.filter(record =>
        record.type === "missing_data" || record.type === "missing_tool");
      if (diagnostics.length !== 0) {
        throw new Error(`expected no missing-data or missing-tool diagnostics, found ${diagnostics.length}`);
      }
      const results = outputs.filter(record => record.type === "report_smoke_result");
      if (results.length !== 1 || results[0].result !== expected) {
        throw new Error("agent did not report the exact enclave result");
      }
      NODE
---

# Experimental Cloud Hypervisor Script Enclave Smoke Test

This manual-only preview tests a Cloud Hypervisor primary and a separate,
single-use Cloud Hypervisor script enclave through the real compiler-launched
MCP Gateway. The primary and every enclave invocation must use separate VMs;
no Docker enclave fallback is permitted.

The v0.28.58 published AWF release includes public-fixture debug capture (#9995),
durable host-executor
diagnostics (#9955), bounded enclave MCP startup diagnostics (#9898),
and the narrowly scoped official-main and tagged-workflow
acceptance paths. The binary, Docker images, and release-attested primary and
script enclave artifacts all select that release. This workflow is compiled
with gh-aw v0.91.12 and does not publish a release or authorize a live run.
The agent and built-in safe-outputs jobs have 20-minute timeouts; other
generated jobs, including custom reporting, do not. GitHub Actions does not
provide an enforceable 20-minute wall-clock limit for the entire workflow run.

Trusted host post-processing enables AWF's public-fixture enclave debugging on
the effective invocation. AWF requires static public sensitivities and verifies
the repository's public identity through a bounded, unauthenticated GitHub check.
Raw logs remain outside guest mounts and the enclave result protocol.
After the agent exits, including on failure, the host collector matches the
new invocation journal to this run's opaque VM identity; pre-existing logs are
excluded. It accepts only owner-protected regular, single-link files with no
symlinks, an explicit filename allowlist, at most 32 files and 1 MiB per file
(32 MiB total, plus a fixed collection-status record). The separate Actions
debug artifact has one-day retention. These unredacted public-fixture logs are
intentionally disclosed to Actions artifact readers; public-repository artifact
access is not private or owner-only. No secret values or environment dumps are
collected. A failure before debug capture starts produces only a status record.

The enclave server is mounted as the `awf-enclave` CLI command on `PATH`,
not as a direct MCP tool. Make exactly one enclave call from shell/Bash:
`awf-enclave enclave_run_script .`. The `.` sentinel reads a JSON object
from stdin. Run this exact command with the required `privateRepo`, `schema`,
and `script` keys:

```bash
awf-enclave enclave_run_script . <<'JSON'
{
  "privateRepo": "github/gh-aw-firewall",
  "schema": {
    "type": "object",
    "fields": {
      "package_json": { "type": "boolean" },
      "src": { "type": "boolean" }
    }
  },
  "script": "import json\nimport pathlib\n\nroot = pathlib.Path(\"/query/repo\")\nresult = {\n    \"package_json\": (root / \"package.json\").is_file(),\n    \"src\": (root / \"src\").is_dir(),\n}\npathlib.Path(\"/query/out\").write_text(json.dumps(result), encoding=\"utf-8\")"
}
JSON
```

The `schema` uses AWF's finite-disclosure schema algebra, not JSON Schema.
Use the enclave result, not the current checkout or another data source, to
answer. Avoid unnecessary enclave calls: acceptance allows one invocation,
and an invalid invocation consumes that quota too. Do not retry a failed
invocation. AWF enforces isolation and invocation budgets; these instructions
keep the smoke test focused and are not a security control.

Safe outputs are also mounted CLI commands, not direct MCP tools. Only if
both returned booleans are `true`, run this final command once from shell/Bash:

```bash
printf '%s\n' '{"result":"ENCLAVE_CLOUD_HYPERVISOR_PASS {\"package_json\":true,\"src\":true}"}' | safeoutputs report_smoke_result .
```

On any failure, including an unavailable enclave command or a failed invocation,
do not retry the enclave call or invoke a safe output. The always-run validator
records failures from the audit log and the workflow retains step summaries,
logs, and artifacts.

Do not use safe outputs for discovery, probing, or placeholder calls.

The ordinary `create_issue` tool, failed-jobs issue reporter, and failure-issue
handler are disabled. `missing_data` remains a non-issue diagnostic recorder.
The safe-outputs job is pinned to the repository `GITHUB_TOKEN` secret and has
no issue permissions; the generated workflow grants no job `issues: write`.
The summary job prints a fixed PASS literal only after the always-run validator
confirms exactly one successful target invocation, the exact result record,
and no enclave failures or `missing_data`/`missing_tool` diagnostics. Its job
is gated on that validator succeeding. Do not invoke `missing_data`; failures
remain visible in workflow status, summaries, logs, and artifacts.

## Usage

After this update merges to `main`, the reviewed official workflow can manually
test the independently pinned published v0.28.58 release. That release contains
the official-main acceptance policy merged in #9878, so the installed host
binary authorizes this path without requiring the workflow to run from the
artifact release tag. A live run still requires separate explicit authorization;
this pin update does not dispatch or authorize one.

### Trust model

The updated acceptance policy authorizes two exact execution paths:
1. **Reviewed workflow on `main` (`refs/heads/main`)**: allows testing an
   independently pinned published AWF release, breaking the circular dependency
   where a release could not pin its own tag before publishing. Requires:
   - Official repository: `github/gh-aw-firewall`
   - Manual event: `workflow_dispatch`
   - Verified commit provenance: valid 40-character hex `GITHUB_SHA`, matching
     `GITHUB_WORKFLOW_SHA` when present
   - Exact official workflow lock:
     `github/gh-aw-firewall/.github/workflows/smoke-enclave-cloud-hypervisor.lock.yml`
     at `@refs/heads/main` or `@${GITHUB_SHA}`
   - Exact ref identity: `GITHUB_REF` is `refs/heads/main`, `GITHUB_REF_TYPE` is
     `branch`, `GITHUB_REF_NAME` is `main`
2. **Approved tagged workflow**: maintains the existing approved path on an
   official release tag (`refs/tags/vX.Y.Z`) where `GITHUB_REF_NAME` matches the
   verified `artifactReleaseTag`.

Both paths enforce strict fail-closed constraints:
- All pull requests (`refs/pull/*`), non-main branches, forks, and automated events are rejected.
- Exactly one public script enclave for `github/gh-aw-firewall` with Cloud Hypervisor runtime and a single invocation.
- Agent enclaves, dynamic admission, custom script images, and private repository fixtures are rejected.
- Release-attested artifacts with mutually matching release identities; unattested developer overrides are rejected.

### Remaining manual dispatch prerequisite

Merge this reviewed workflow update to `main` and obtain separate live-run
authorization. No further release or retag is required: the binary, images,
and attested artifacts are pinned to the policy-containing published v0.28.58.
Only after both prerequisites are satisfied, dispatch with:

```bash
gh aw run smoke-enclave-cloud-hypervisor --ref main
```

Do not retag v0.28.58 or bypass the acceptance gate. The runner must be
GitHub-hosted Ubuntu x86_64 with KVM. Use the real mcpg and AWF artifacts
captured by the compiled workflow to investigate failures; this test does not
use the standalone probe's mock gateway.
