---
name: Smoke Bounded Agents
description: End-to-end smoke test for finite-schema Docker bounded-agent enclaves
on:
  schedule: every 12h
  workflow_dispatch:
permissions:
  contents: read
  copilot-requests: write
env:
  GH_TOKEN: ${{ github.token }}
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
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
      node <<'NODE'
      const fs = require("fs");
      const file = `${process.env.RUNNER_TEMP}/gh-aw/awf-config.json`;
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.apiProxy = { ...(config.apiProxy || {}), targets: { openai: {} } };
      config.boundedAgents = {
        enabled: true,
        privateRepos: [{ repo: "github/gh-aw", sensitivity: "internal" }],
        runtime: "docker",
        profile: "openai",
        model: "gpt-4o-mini",
        memoryLimit: "512m"
      };
      fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      NODE
safe-outputs:
  threat-detection:
    enabled: false
timeout-minutes: 20
strict: false
concurrency:
  group: smoke-bounded-agents
  cancel-in-progress: false
post-steps:
  - name: Validate bounded-agent invocation
    if: always()
    env:
      AUDIT_LOG: /tmp/gh-aw/sandbox/firewall/audit/bounded-agent.jsonl
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      node - "$AUDIT_LOG" "$OUTPUTS_FILE" <<'NODE'
      const fs = require("fs");
      const [auditPath, outputsPath] = process.argv.slice(2);
      const records = fs.readFileSync(auditPath, "utf8").trim().split("\n")
        .filter(Boolean).map((line) => JSON.parse(line));
      const invocations = records.filter((record) =>
        record.kind === "invocation" && record.sensitivity === "internal");
      if (invocations.length !== 1 || invocations[0].outcome !== "ok") {
        throw new Error(`expected one successful bounded-agent invocation, found ${invocations.length}`);
      }
      const serialized = JSON.stringify(records);
      if (serialized.includes("github/gh-aw") || serialized.includes("SECURITY.md")) {
        throw new Error("protected audit disclosed repository-derived content");
      }
      const outputs = fs.readFileSync(outputsPath, "utf8");
      if (!outputs.includes('"noop"') || !outputs.includes("PASS")) {
        throw new Error("agent did not report PASS through noop");
      }
      NODE
---

# Smoke Test: Docker Bounded Agent

Use the generated `bounded-agent` skill exactly once to answer this boolean
question about `github/gh-aw`: does the repository root contain a `go.mod`
file?

Use a boolean schema. Do not use GitHub tools, network requests, shell commands,
or the current checkout to answer. The test passes only when the bounded agent
returns `true`.

Call `noop` with `PASS true` only when the result is true. Otherwise call
`safeoutputs-missing_data`. Never report failure through `noop`.
