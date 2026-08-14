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
engine:
  id: copilot
  version: 1.0.34
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
    version: v0.28.0
    runtime: cloud-hypervisor
    sudo: true
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
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: agent
          path: /tmp/gh-aw-agent
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
post-steps:
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
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
---

# Smoke Test: Cloud Hypervisor + Build/Test Workloads

**CRITICAL REQUIREMENT: You MUST run the workload below inside the Cloud Hypervisor sandbox, then call `add_comment` on pull_request triggers.**

**Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Context

This workflow validates that the Cloud Hypervisor sandbox can handle real-world build and test workloads. Run the deterministic workload below through `bash`, read its results, and produce the summary.

## Step 1: Run Workload

Run this entire script in one Bash invocation. It intentionally records each result instead of exiting on the first failure.

```bash
mkdir -p /tmp/gh-aw/agent

echo "::group::Runtime versions"
echo "Node: $(node --version 2>&1)"
echo "npm: $(npm --version 2>&1)"
echo "Go: $(go version 2>&1)"
echo "::endgroup::"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com || true)
HTTP_CODE=${HTTP_CODE:-000}

echo "::group::npm ci"
npm ci 2>&1 | tail -5
NPM_CI_EXIT=${PIPESTATUS[0]}
echo "::endgroup::"

echo "::group::npm run build"
npm run build 2>&1 | tail -5
NPM_BUILD_EXIT=${PIPESTATUS[0]}
echo "::endgroup::"

if [ "$NPM_CI_EXIT" -eq 0 ] && [ "$NPM_BUILD_EXIT" -eq 0 ]; then
  NODE_BUILD_STATUS=PASS
else
  NODE_BUILD_STATUS=FAIL
fi

echo "::group::npm test"
npx jest --ci --forceExit --maxWorkers=2 --testPathPattern='squid-config|docker-manager|logger' 2>&1 | tail -20
NODE_TEST_EXIT=${PIPESTATUS[0]}
echo "::endgroup::"

if [ "$NODE_TEST_EXIT" -eq 0 ]; then
  NODE_TEST_STATUS=PASS
else
  NODE_TEST_STATUS=FAIL
fi

GO_TEST_DIR=/tmp/gh-aw/agent/go-fixture
rm -rf "$GO_TEST_DIR"
git init -q "$GO_TEST_DIR"
git -C "$GO_TEST_DIR" remote add origin https://github.com/Mossaka/gh-aw-firewall-test-go.git
git -C "$GO_TEST_DIR" fetch --depth 1 origin c3e84fc697814119dba3b0ad82566dc2b2bbb880 2>&1 | tail -3
GO_FETCH_EXIT=${PIPESTATUS[0]}

if [ "$GO_FETCH_EXIT" -ne 0 ]; then
  GO_BUILD_STATUS=CLONE_FAILED
  GO_TEST_STATUS=SKIPPED
else
  git -C "$GO_TEST_DIR" checkout --detach FETCH_HEAD

  cd "$GO_TEST_DIR/color"
  go mod download 2>&1 | tail -3
  go build ./... 2>&1 | tail -5
  GO_COLOR_BUILD_EXIT=${PIPESTATUS[0]}
  go test ./... 2>&1 | tail -10
  GO_COLOR_TEST_EXIT=${PIPESTATUS[0]}

  cd "$GO_TEST_DIR/uuid"
  go mod download 2>&1 | tail -3
  go build ./... 2>&1 | tail -5
  GO_UUID_BUILD_EXIT=${PIPESTATUS[0]}
  go test ./... 2>&1 | tail -10
  GO_UUID_TEST_EXIT=${PIPESTATUS[0]}

  if [ "$GO_COLOR_BUILD_EXIT" -eq 0 ] && [ "$GO_UUID_BUILD_EXIT" -eq 0 ]; then
    GO_BUILD_STATUS=PASS
  else
    GO_BUILD_STATUS=FAIL
  fi

  if [ "$GO_COLOR_TEST_EXIT" -eq 0 ] && [ "$GO_UUID_TEST_EXIT" -eq 0 ]; then
    GO_TEST_STATUS=PASS
  else
    GO_TEST_STATUS=FAIL
  fi
fi

BLOCKED_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://example.com 2>/dev/null || true)
BLOCKED_CODE=${BLOCKED_CODE:-000}
if [ "$BLOCKED_CODE" = "000" ] || [ "$BLOCKED_CODE" = "403" ]; then
  NETWORK_ISOLATION_STATUS=PASS
else
  NETWORK_ISOLATION_STATUS=FAIL
fi

cat > /tmp/gh-aw/agent/build-test-results.json << RESULTS_EOF
{
  "http_code": "$HTTP_CODE",
  "node_build": "$NODE_BUILD_STATUS",
  "node_test": "$NODE_TEST_STATUS",
  "go_build": "$GO_BUILD_STATUS",
  "go_test": "$GO_TEST_STATUS",
  "network_isolation": "$NETWORK_ISOLATION_STATUS"
}
RESULTS_EOF
cat /tmp/gh-aw/agent/build-test-results.json
```

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
