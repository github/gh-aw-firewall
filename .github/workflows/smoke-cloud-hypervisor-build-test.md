---
description: Smoke test Cloud Hypervisor sandbox with multi-ecosystem build and test workloads
on:
  workflow_dispatch:
  label_command:
    name: test-cloud-hypervisor-build
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
  copilot-requests: write
name: Smoke Cloud Hypervisor Build Test
concurrency:
  job-discriminator: ${{ github.run_id }}
engine:
  id: copilot
  args:
    - --allow-url=https://github.com
    - --allow-url=https://example.com
runtimes:
  node:
    version: "20"
  go:
    version: "1.22"
network:
  allowed:
    - defaults
    - github
    - node
    - go
    - ms-feed-2.pkgs.visualstudio.com
    - ms-feed-12.pkgs.visualstudio.com
    - ms-feed-17.pkgs.visualstudio.com
    - ms-feed-25.pkgs.visualstudio.com
    - "*.vsblob.vsassets.io"
tools:
  bash:
    - "*"
  github:
    toolsets: [pull_requests]
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [smoke-cloud-hypervisor-build]
  messages:
    footer: "> ☁️🏗️ *Cloud Hypervisor build test by [{workflow_name}]({run_url})*"
    run-started: "☁️🏗️ [{workflow_name}]({run_url}) is testing Cloud Hypervisor with build workloads..."
    run-success: "☁️🏗️ [{workflow_name}]({run_url}) completed. Cloud Hypervisor build test passed. ✅"
    run-failure: "☁️🏗️ [{workflow_name}]({run_url}) reports {status}. Cloud Hypervisor compatibility issue detected."
timeout-minutes: 60
sandbox:
  agent:
    id: awf
    version: v0.28.31
    runtime: cloud-hypervisor
    config:
      filesystem:
        allow-write:
          - /tmp/gh-aw/aw_info.json
strict: false
jobs:
  verify_build:
    needs: agent
    if: always() && needs.agent.result != 'skipped' && needs.agent.result != 'cancelled'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1
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
  - name: Validate safe outputs were invoked
    env:
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked. Smoke tests require the agent to call safe output tools."
        echo "Checked path: $OUTPUTS_FILE"
        exit 1
      fi
      echo "Safe output entries found: $(wc -l < "$OUTPUTS_FILE")"
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
        if ! grep -q '"add_comment"' "$OUTPUTS_FILE"; then
          echo "::error::Agent did not call add_comment on a pull_request trigger."
          exit 1
        fi
        echo "add_comment verified for PR trigger"
      fi
      echo "Safe output validation passed"
  - name: Validate build test results
    run: |
      node <<'NODE'
      const fs = require("fs");
      const resultsPath = "/tmp/gh-aw/agent/build-test-results.json";
      if (!fs.existsSync(resultsPath)) {
        throw new Error(`Build test results not found: ${resultsPath}`);
      }
      const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
      const expected = {
        node_build: "PASS",
        node_test: "PASS",
        go_build: "PASS",
        go_test: "PASS",
        network_isolation: "PASS",
      };
      const failures = Object.entries(expected)
        .filter(([key, value]) => results[key] !== value)
        .map(([key, value]) => `${key}: expected ${value}, received ${results[key] ?? "missing"}`);
      if (results.http_code !== "200") {
        failures.push(`http_code: expected 200, received ${results.http_code ?? "missing"}`);
      }
      if (failures.length > 0) {
        throw new Error(`Cloud Hypervisor build test failed:\n${failures.join("\n")}`);
      }
      console.log("Cloud Hypervisor build test results passed");
      NODE
  - name: Upload build test diagnostics
    if: always()
    uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
    with:
      name: cloud-hypervisor-build-test-diagnostics
      path: |
        /tmp/gh-aw/agent/build-test-results.json
        /tmp/gh-aw/agent/build-test-jest-results.json
        /tmp/gh-aw/agent/build-test-*.log
      if-no-files-found: warn
      retention-days: ${{ vars.GH_AW_DEFAULT_ARTIFACT_RETENTION_DAYS || '7' }}
---

# Smoke Test: Cloud Hypervisor + Build/Test Workloads

**CRITICAL REQUIREMENT: Run the checked-in workload script inside the Cloud Hypervisor sandbox, then call `add_comment` on pull_request triggers.**

**Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Context

This workflow validates that the Cloud Hypervisor sandbox can handle real-world build and test workloads. Execute the checked-in script, read its recorded results, and produce the summary.

## Step 1: Run Workload

Run this exact command once. Do not reproduce, shorten, split, or rewrite the
script's commands. The script records every component's status and writes
`/tmp/gh-aw/agent/build-test-results.json` even when a component fails:

The CLI URL approvals let the two `curl` probes execute without interactive
permission prompts. They do not change AWF's network allowlist: `example.com`
must still be blocked by Squid.

```bash
bash scripts/ci/run-cloud-hypervisor-build-smoke.sh
```

After the command finishes, read `build-test-results.json` even if the command
returned nonzero. Never synthesize or edit the results file. For a Jest failure,
read `build-test-jest-results.json` and report the failing test name and assertion;
do not rerun or omit tests to turn a failure into a pass. Full per-component logs
and Jest results are uploaded as `cloud-hypervisor-build-test-diagnostics`,
using the repository's artifact-retention policy (seven days by default).

The generated JSON contains:
- `http_code`: GitHub.com HTTP response code
- `node_build`: Node.js build status (PASS/FAIL)
- `node_test`: Node.js test status (PASS/FAIL)
- `go_build`: Go build status (PASS/FAIL/CLONE_FAILED)
- `go_test`: Go test status (PASS/FAIL/SKIPPED)
- `network_isolation`: Firewall isolation status (PASS/FAIL)

## Step 2: Output (MANDATORY)

**If triggered by a pull request** (check: `${{ github.event_name }}` equals "pull_request"), you MUST call `add_comment` to post a **brief** comment on the current pull request with:

### ☁️🏗️ Cloud Hypervisor Build Test Results

| Test | Status |
|------|--------|
| GitHub.com connectivity | ✅/❌ |
| Node.js build (`npm ci && npm run build`) | ✅/❌ |
| Node.js tests (Jest subset) | ✅/❌ |
| Go build (color, uuid) | ✅/❌ |
| Go tests (color, uuid) | ✅/❌ |
| Network isolation | ✅/❌ |

**Overall: PASS/FAIL**

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool to add the label `smoke-cloud-hypervisor-build` to the pull request

**If triggered by workflow_dispatch** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.