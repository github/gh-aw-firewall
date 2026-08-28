---
description: Smoke test read-only GitHub Issues access from an agent enclave
on:
  schedule: every 12h
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: write
env:
  GH_TOKEN: ${{ github.token }}
name: Smoke Enclave Issues Read
engine:
  id: copilot
  version: 1.0.80
network:
  allowed:
    - defaults
    - github
tools:
  github:
    toolsets: [context]
    allowed: []
enclaves:
  - agent:
      model: claude-sonnet-5
      github:
        cli: issues-read-v1
    repos:
      - repo: github/gh-aw
        sensitivity: internal
    timeout: 180
safe-outputs:
  threat-detection:
    enabled: false
  messages:
    footer: "> 🔐📖 *Enclave Issues read test by [{workflow_name}]({run_url})*"
    run-started: "🔐📖 [{workflow_name}]({run_url}) is testing read-only GitHub Issues access from an enclave..."
    run-success: "🔐📖 [{workflow_name}]({run_url}) completed. Enclave Issues read test passed. ✅"
    run-failure: "🔐📖 [{workflow_name}]({run_url}) reports {status}. Enclave Issues read compatibility issue detected."
timeout-minutes: 20
sandbox:
  agent:
    id: awf
    version: v0.28.9
  mcp:
    version: v0.4.13
strict: false
concurrency:
  group: smoke-enclave-issues-read
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
  - name: Validate read-only enclave invocation
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
      const expected = "ENCLAVE_ISSUES_READ_PASS "
        + '{"list_read":true,"issue_read":true,"comments_read":true}';
      const outputs = fs.readFileSync(outputsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (!outputs.some((record) => record.type === "noop" && record.message === expected)) {
        throw new Error("agent did not report the exact enclave Issues read result through noop");
      }
      NODE
---

# Smoke Test: Read-Only GitHub Issues from an Agent Enclave

Use `enclave_run_agent` exactly once for the assigned `github/gh-aw`
repository. Do not use GitHub tools, network requests, or the current checkout
to answer.

Pass this exact finite-disclosure schema:

```json
{
  "type": "object",
  "fields": {
    "list_read": { "type": "boolean" },
    "issue_read": { "type": "boolean" },
    "comments_read": { "type": "boolean" }
  }
}
```

Give the enclave agent this task:

```text
Use only the narrow gh wrapper and run each command exactly once:

1. gh api --method GET 'repos/github/gh-aw/issues?per_page=1'
2. gh api --method GET 'repos/github/gh-aw/issues/50920'
3. gh api --method GET 'repos/github/gh-aw/issues/50920/comments?per_page=1'

Return exactly:
{"list_read":true,"issue_read":true,"comments_read":true}

Set a value to false if its command fails, the list or comments response is not
a JSON array, or the issue response does not contain number 50920. Do not use
stock gh issue commands, GraphQL, search, writes, or any other GitHub endpoint.
```

The test passes only when all three returned booleans are `true`.

Call `noop` with exactly this message when the test passes:

```text
ENCLAVE_ISSUES_READ_PASS {"list_read":true,"issue_read":true,"comments_read":true}
```

For any failure, call `safeoutputs missing_data`; never report a failure through
`noop`.
