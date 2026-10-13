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
sandbox:
  agent:
    id: awf
    version: v0.28.56
    runtime: cloud-hypervisor
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

This manual-only preview tests a Cloud Hypervisor primary and a separate,
single-use Cloud Hypervisor script enclave through the real compiler-launched
MCP Gateway. The primary and every enclave invocation must use separate VMs;
no Docker enclave fallback is permitted.

The v0.28.56 published AWF release includes bounded enclave MCP startup
diagnostics (#9898) and the narrowly scoped official-main and tagged-workflow
acceptance paths. The binary, Docker images, and release-attested primary and
script enclave artifacts all select that release. This workflow is compiled
with gh-aw v0.91.9 and does not publish a release or authorize a live run.

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
printf '%s\n' '{"message":"ENCLAVE_CLOUD_HYPERVISOR_PASS {\"package_json\":true,\"src\":true}"}' | safeoutputs noop .
```

On any failure, including an unavailable enclave command or a failed invocation,
run this final command once instead; never report failure via `noop`:

```bash
printf '%s\n' '{"data_type":"Cloud Hypervisor enclave result","reason":"The enclave invocation failed or did not return both required booleans as true."}' | safeoutputs missing_data .
```

Do not use safe outputs for discovery, probing, or placeholder calls.

Automatic failure issues are disabled so the ordinary safe-output issue remains
the only issue-creation path, capped at one per run. Failures remain visible in
the workflow status, step summaries, logs, and uploaded artifacts.

## Usage

After this update merges to `main`, the reviewed official workflow can manually
test the independently pinned published v0.28.56 release. That release contains
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
and attested artifacts are pinned to the policy-containing published v0.28.56.
Only after both prerequisites are satisfied, dispatch with:

```bash
gh aw run smoke-enclave-cloud-hypervisor --ref main
```

Do not retag v0.28.56 or bypass the acceptance gate. The runner must be
GitHub-hosted Ubuntu x86_64 with KVM. Use the real mcpg and AWF artifacts
captured by the compiled workflow to investigate failures; this test does not
use the standalone probe's mock gateway.
