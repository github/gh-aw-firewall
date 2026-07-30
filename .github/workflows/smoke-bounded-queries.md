---
name: Smoke Bounded Queries
description: Smoke test for declarative bounded queries in agentic workflow frontmatter
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
      runtime: docker
      memory-limit: 2g
      interpreter: python3
sandbox:
  agent:
    id: awf
    version: v0.28.0
safe-outputs:
  threat-detection:
    enabled: false
timeout-minutes: 15
strict: false
concurrency:
  group: smoke-bounded-queries
  cancel-in-progress: false
jobs:
  verify_budget_matrix:
    name: Verify confidentiality budgets
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
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
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
      - name: Exercise confidentiality budgets
        env:
          GH_TOKEN: ${{ github.token }}
        run: scripts/ci/smoke-bounded-queries.sh
post-steps:
  - name: Validate bounded-query invocation
    if: always()
    env:
      AUDIT_LOG: /tmp/gh-aw/sandbox/firewall/audit/bounded-query.jsonl
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      node - "$AUDIT_LOG" "$OUTPUTS_FILE" <<'NODE'
      const fs = require("fs");
      const [auditPath, outputsPath] = process.argv.slice(2);
      const readJsonLines = (path) => fs.readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      const invocations = readJsonLines(auditPath).filter(
        (record) => record.kind === "invocation" &&
          record.repo === "github/gh-aw" &&
          record.sensitivity === "internal"
      );
      if (invocations.length !== 1) {
        throw new Error(`expected one successful bounded query, found ${invocations.length}`);
      }

      const outputs = fs.readFileSync(outputsPath, "utf8");
      if (!outputs.includes('"noop"') || !outputs.includes("PASS")) {
        throw new Error("agent did not report a bounded-query PASS through noop");
      }
      NODE
---

# Smoke Test: Bounded Queries

Use the generated `bounded-query` skill to answer exactly one finite question about
`github/gh-aw`: does the repository root contain a `go.mod` file?

The query must:

1. Use a boolean JSON schema.
2. Run a Python script inside the bounded-query environment that checks
   `/query/repo/go.mod`.
3. Return `true`.

No GitHub API tools are available to the agent. Do not use network requests or
the current checkout to answer the question. The test passes only when the
bounded query succeeds and returns `true`.

Call `noop` with a concise PASS result that includes the returned boolean only
when the query returns `true`. If the skill is unavailable, call
`safeoutputs-missing_tool`. If the query fails or returns anything other than
`true`, call `safeoutputs-missing_data`. Never report FAIL through `noop`.
