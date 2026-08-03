---
name: Smoke Bounded Queries sbx
description: End-to-end smoke test for the fail-closed sbx bounded-query capability gate
on:
  schedule: every 12h
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: write
env:
  GH_TOKEN: ${{ github.token }}
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
    bounded-queries:
      private-repos:
        - repo: github/gh-aw
          sensitivity: internal
      # The live agent remains a Docker control because sbx query execution is
      # intentionally blocked before agent startup on every currently audited host.
      runtime: docker
      memory-limit: 2g
      interpreter: python3
sandbox:
  agent:
    id: awf
    version: v0.28.0
    args:
      - --build-local
steps:
  - name: Build unreleased AWF
    run: |
      npm ci
      npm run build
pre-agent-steps:
  - name: Replace release bootstrap with current AWF build
    run: |
      mkdir -p "$HOME/.local/bin"
      printf '#!/bin/bash\nexec "%s" "%s/dist/cli.js" "$@"\n' \
        "$(command -v node)" "$GITHUB_WORKSPACE" > "$HOME/.local/bin/awf"
      chmod +x "$HOME/.local/bin/awf"
safe-outputs:
  threat-detection:
    enabled: false
timeout-minutes: 15
strict: false
concurrency:
  group: smoke-bounded-queries-sbx
  cancel-in-progress: false
jobs:
  verify_sbx_gate:
    name: Verify sbx fails closed
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Setup Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "24"
          package-manager-cache: false
      - name: Build AWF
        run: |
          npm ci
          npm run build
          sudo tee /usr/local/bin/awf > /dev/null <<EOF
          #!/bin/bash
          exec "$(command -v node)" "${GITHUB_WORKSPACE}/dist/cli.js" "\$@"
          EOF
          sudo chmod +x /usr/local/bin/awf
      - name: Exercise sbx fail-closed preflight
        env:
          GH_TOKEN: ${{ github.token }}
          SMOKE_EXPECT_BLOCKED: "true"
          SMOKE_QUERY_RUNTIME: sbx
        run: scripts/ci/smoke-bounded-queries.sh
post-steps:
  - name: Validate Docker control invocation
    if: always()
    env:
      AUDIT_LOG: /tmp/gh-aw/sandbox/firewall/audit/bounded-query.jsonl
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      node - "$AUDIT_LOG" "$OUTPUTS_FILE" <<'NODE'
      const fs = require("fs");
      const [auditPath, outputsPath] = process.argv.slice(2);
      const invocations = fs.readFileSync(auditPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.kind === "invocation" &&
          record.repo === "github/gh-aw" &&
          record.sensitivity === "internal");
      if (invocations.length !== 1) {
        throw new Error(`expected one successful Docker control query, found ${invocations.length}`);
      }

      const outputs = fs.readFileSync(outputsPath, "utf8");
      if (!outputs.includes('"noop"') || !outputs.includes("PASS")) {
        throw new Error("agent did not report a bounded-query PASS through noop");
      }
      NODE
---

# Smoke Test: sbx Bounded-Query Security Gate

The deterministic `verify_sbx_gate` job verifies that AWF rejects sbx bounded
queries before staging or agent startup while the audited sbx runtime lacks the
mandatory pinned template, no-network, PID, disk, file-size, and guest
mount-target controls. It also verifies that no Docker or gVisor fallback is
attempted.

For the agent path, use the generated `bounded-query` skill once as a Docker
control. Ask whether `/query/repo/go.mod` exists in `github/gh-aw` with a
boolean schema and return `true`.

Call `noop` with a concise PASS result that includes the returned boolean only
when the control query returns `true`. If the skill is unavailable, call
`safeoutputs-missing_tool`. If the query fails or returns anything other than
`true`, call `safeoutputs-missing_data`. Never report FAIL through `noop`.
