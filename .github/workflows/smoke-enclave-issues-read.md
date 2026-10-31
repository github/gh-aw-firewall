---
description: Smoke test enclave-only GitHub Issues access with no primary-agent GitHub data path
on:
  schedule: every 12h
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: write
name: Smoke Enclave Issues Read
engine:
  id: copilot
  version: 1.0.80
  checksums-sha256: 243949dfde6b9c0d5852c4bc430f46ddcaacdfc74353bd1b1d2bccce3b789a48
  args: ["--allow-tool", "awf-enclave(enclave_run_agent)"]
network:
  allowed: []
tools:
  github: false
enclaves:
  - agent:
      model: auto
      github:
        cli: issues-read-v1
    repos:
      - repo: github/gh-aw
        sensitivity: internal
    max-invocations: 1
    max-output-bytes: 1024
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
runtimes:
  node:
    version: "24"
sandbox:
  agent:
    id: awf
    version: v0.28.13
    command: 'sudo --preserve-env=AWF_REFLECT_ENABLED,COPILOT_AGENT_RUNNER_TYPE,COPILOT_DUMMY_BYOK,COPILOT_GITHUB_TOKEN,COPILOT_MODEL,GH_AW_LLM_PROVIDER,GH_AW_MAX_AI_CREDITS,GH_AW_MAX_TURNS,GH_AW_PHASE,GH_AW_PROMPT,GH_AW_SAFE_OUTPUTS,GH_AW_TIMEOUT_MINUTES,GH_AW_VERSION,GITHUB_API_URL,GITHUB_AW,GITHUB_COPILOT_INTEGRATION_ID,GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS,GITHUB_HEAD_REF,GITHUB_REF_NAME,GITHUB_SERVER_URL,GITHUB_STEP_SUMMARY,GITHUB_WORKSPACE,GIT_AUTHOR_EMAIL,GIT_AUTHOR_NAME,GIT_COMMITTER_EMAIL,GIT_COMMITTER_NAME,MCP_GATEWAY_API_KEY,GH_TOKEN,RUNNER_TEMP,RUNNER_TOOL_CACHE,S2STOKENS,TRACEPARENT,AWF_ENCLAVE_MCP_CAPABILITY,GH_AW_AWF_EXECUTION_COMPONENT,GH_AW_AWF_EXECUTION_EVIDENCE_FILE,GH_AW_AWF_ENGINE_NAME,GH_AW_AWF_HARNESS_MARKER,GH_AW_AWF_LOG_FILE,GH_AW_AWF_ATTEMPT_LOG_NAME,GH_AW_NODE_BIN /usr/local/bin/awf'
strict: false
steps:
  - name: Install AWF dependencies
    run: npm ci
  - name: Build AWF
    run: npm run build
  - name: Install local AWF binary
    run: |
      sudo tee /usr/local/bin/awf > /dev/null <<EOF
      #!/bin/bash
      exec "$(command -v node)" "${GITHUB_WORKSPACE}/dist/cli.js" "\$@"
      EOF
      sudo chmod +x /usr/local/bin/awf
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
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333  # v8.0.2
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
      const outputs = fs.readFileSync(outputsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const prefix = "ENCLAVE_ISSUES_READ_PASS ";
      const result = outputs.find((record) =>
        record.type === "noop" &&
        typeof record.message === "string" &&
        record.message.startsWith(prefix));
      if (!result) {
        throw new Error("agent did not report the enclave Issues read result through noop");
      }
      const payload = JSON.parse(result.message.slice(prefix.length));
      const expectedKeys = ["comments_read", "issue_number", "issue_read", "list_read"];
      if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys) ||
          payload.list_read !== true ||
          payload.issue_read !== true ||
          payload.comments_read !== true ||
          !Number.isInteger(payload.issue_number) ||
          payload.issue_number <= 0) {
        throw new Error("agent reported an invalid enclave Issues read result");
      }
      NODE
---

# Smoke Test: Read-Only GitHub Issues from an Agent Enclave

The postprocessor pins this smoke's GitHub MCP server to the last-green
`v1.12.2` image for the flat issue object and comments array expected by the
gateway guard, not the `issue_read` envelopes introduced in GitHub MCP server
v2. The postprocessor also pins MCP Gateway `v0.4.36`, which supports the immutable
`@sha256` image reference; older gateways reject it during configuration validation.
The gateway implementation pin stays out of workflow frontmatter so strict
validation remains supported. Keep
`tools.github: false` and the enclave's `approved` integrity policy intact.

The primary agent has no GitHub MCP tools, GitHub credentials, or external
network access. Use `enclave_run_agent` exactly once for the assigned
`github/gh-aw` repository. Do not attempt GitHub access, network requests, shell
commands, or current-checkout inspection from the primary agent.

Pass this exact finite-disclosure schema:

```json
{
  "type": "object",
  "fields": {
    "list_read": { "type": "boolean" },
    "issue_read": { "type": "boolean" },
    "comments_read": { "type": "boolean" },
    "issue_number": { "type": "integer", "minimum": 0, "maximum": 1000000 }
  }
}
```

Give the enclave agent this task:

```text
Use only the `github` MCP server and call each tool exactly once:

1. `list_issues` with `owner: "github"`, `repo: "gh-aw"`, `state: "OPEN"`,
   and `perPage: 1`
2. Read the first returned issue number. If no issue is returned, set
   `issue_number` to `0` and all booleans to `false`.
3. `issue_read` with `owner: "github"`, `repo: "gh-aw"`, `method: "get"`, and
   `issue_number` set to the discovered issue number as a JSON number.
4. `issue_read` with `owner: "github"`, `repo: "gh-aw"`,
   `method: "get_comments"`, `issue_number` set to that same JSON number,
   and `perPage: 1`.

Return exactly one object matching the schema. Set `issue_number` to the number
from the first entry in the `list_issues` response's `issues` array. Set a
boolean to `false` if its corresponding tool call fails, the `issues` field or
comments response is not a JSON array, or the issue response does not contain
the discovered issue number.

Do not use GitHub CLI, GraphQL, search, writes, or any other GitHub tool.
```

The test passes only when all three returned booleans are `true`.

When all booleans are `true` and `issue_number` is positive, call `noop` with
this prefix followed immediately by the enclave result's compact JSON:

```text
ENCLAVE_ISSUES_READ_PASS {"list_read":true,"issue_read":true,"comments_read":true,"issue_number":<discovered number>}
```

For any failure, call `safeoutputs missing_data`; never report a failure through
`noop`.
