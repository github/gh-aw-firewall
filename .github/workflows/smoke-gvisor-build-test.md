---
description: Smoke test gVisor runtime with multi-ecosystem build and test workloads
on:
  workflow_dispatch:
  label_command:
    name: test-gvisor-build
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
  copilot-requests: write
name: Smoke gVisor Build Test
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
    allowed: [smoke-gvisor-build]
  messages:
    footer: "> 🦎🏗️ *gVisor build test by [{workflow_name}]({run_url})*"
    run-started: "🦎🏗️ [{workflow_name}]({run_url}) is testing gVisor runtime with build workloads..."
    run-success: "🦎🏗️ [{workflow_name}]({run_url}) completed. gVisor build test passed. ✅"
    run-failure: "🦎🏗️ [{workflow_name}]({run_url}) reports {status}. gVisor build compatibility issue detected."
timeout-minutes: 30
sandbox:
  agent:
    id: awf
    runtime: gvisor
    sudo: true
strict: false
jobs:
  verify_gvisor:
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
      - name: Verify gVisor runtime was used
        run: |
          echo "::group::Check artifacts for gVisor runtime confirmation"
          ARTIFACT_ROOT="/tmp/gh-aw-agent"
          if grep -r -l -i 'gVisor' "$ARTIFACT_ROOT" --include '*.log' --include '*.json' --include '*.txt' --include '*.jsonl' 2>/dev/null | head -3; then
            echo "✅ gVisor runtime confirmed in agent artifacts"
          else
            echo "⚠️ Could not confirm gVisor in artifacts (agent may not have logged /proc/version)"
          fi
          echo "::endgroup::"
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
steps:
  - name: Setup Go
    uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e  # v7.0.0
    with:
      go-version: '1.22'
  - name: Capture environment info
    id: env-info
    run: |
      echo "::group::Runtime versions"
      echo "Node: $(node --version 2>&1)"
      echo "npm: $(npm --version 2>&1)"
      echo "Go: $(go version 2>&1)"
      echo "::endgroup::"

      echo "::group::gVisor kernel check"
      PROC_VERSION=$(cat /proc/version 2>/dev/null || echo "unavailable")
      echo "Kernel: $PROC_VERSION"
      if echo "$PROC_VERSION" | grep -qi 'gvisor'; then
        echo "GVISOR_CONFIRMED=true" >> "$GITHUB_OUTPUT"
      else
        echo "GVISOR_CONFIRMED=false" >> "$GITHUB_OUTPUT"
      fi
      echo "::endgroup::"

      echo "::group::GitHub.com connectivity"
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com)
      echo "github.com returned HTTP $HTTP_CODE"
      echo "SMOKE_HTTP_CODE=$HTTP_CODE" >> "$GITHUB_OUTPUT"
      echo "::endgroup::"
  - name: Build AWF project (Node.js)
    id: build-node
    run: |
      echo "::group::npm ci"
      npm ci 2>&1 | tail -5
      NPM_CI_EXIT=$?
      echo "::endgroup::"

      echo "::group::npm run build"
      npm run build 2>&1 | tail -5
      NPM_BUILD_EXIT=$?
      echo "::endgroup::"

      if [ $NPM_CI_EXIT -eq 0 ] && [ $NPM_BUILD_EXIT -eq 0 ]; then
        echo "NODE_BUILD_STATUS=PASS" >> "$GITHUB_OUTPUT"
        echo "✅ Node.js build succeeded"
      else
        echo "NODE_BUILD_STATUS=FAIL" >> "$GITHUB_OUTPUT"
        echo "❌ Node.js build failed (ci=$NPM_CI_EXIT, build=$NPM_BUILD_EXIT)"
      fi
  - name: Run AWF unit tests (Node.js)
    id: test-node
    run: |
      echo "::group::npm test"
      # Run a subset of tests to keep timing reasonable
      npx jest --ci --forceExit --maxWorkers=2 --testPathPattern='squid-config|docker-manager|logger' 2>&1 | tail -20
      TEST_EXIT=$?
      echo "::endgroup::"

      if [ $TEST_EXIT -eq 0 ]; then
        echo "NODE_TEST_STATUS=PASS" >> "$GITHUB_OUTPUT"
        echo "✅ Node.js tests passed"
      else
        echo "NODE_TEST_STATUS=FAIL" >> "$GITHUB_OUTPUT"
        echo "❌ Node.js tests failed (exit=$TEST_EXIT)"
      fi
  - name: Clone and build Go test project
    id: build-go
    run: |
      echo "::group::Clone Go test repo"
      git clone --depth 1 https://github.com/Mossaka/gh-aw-firewall-test-go.git /tmp/test-go 2>&1 | tail -3
      CLONE_EXIT=$?
      echo "::endgroup::"

      if [ $CLONE_EXIT -ne 0 ]; then
        echo "GO_BUILD_STATUS=CLONE_FAILED" >> "$GITHUB_OUTPUT"
        echo "GO_TEST_STATUS=SKIPPED" >> "$GITHUB_OUTPUT"
        echo "❌ Go clone failed"
      else
        echo "::group::Go build and test - color"
        cd /tmp/test-go/color
        go mod download 2>&1 | tail -3
        go build ./... 2>&1 | tail -5
        BUILD_EXIT=$?
        go test ./... 2>&1 | tail -10
        TEST_EXIT=$?
        echo "::endgroup::"

        echo "::group::Go build and test - uuid"
        cd /tmp/test-go/uuid
        go mod download 2>&1 | tail -3
        go build ./... 2>&1 | tail -5
        BUILD2_EXIT=$?
        go test ./... 2>&1 | tail -10
        TEST2_EXIT=$?
        echo "::endgroup::"

        if [ $BUILD_EXIT -eq 0 ] && [ $BUILD2_EXIT -eq 0 ]; then
          echo "GO_BUILD_STATUS=PASS" >> "$GITHUB_OUTPUT"
        else
          echo "GO_BUILD_STATUS=FAIL" >> "$GITHUB_OUTPUT"
        fi

        if [ $TEST_EXIT -eq 0 ] && [ $TEST2_EXIT -eq 0 ]; then
          echo "GO_TEST_STATUS=PASS" >> "$GITHUB_OUTPUT"
        else
          echo "GO_TEST_STATUS=FAIL" >> "$GITHUB_OUTPUT"
        fi
      fi
    env:
      GOROOT: ${{ steps.env-info.outputs.GOROOT || '' }}
  - name: Write results summary
    env:
      EXPR_STEPS_ENV_INFO_OUTPUTS_GVISOR_CONFIRMED: ${{ steps.env-info.outputs.GVISOR_CONFIRMED }}
      EXPR_STEPS_ENV_INFO_OUTPUTS_SMOKE_HTTP_CODE: ${{ steps.env-info.outputs.SMOKE_HTTP_CODE }}
      EXPR_STEPS_BUILD_NODE_OUTPUTS_NODE_BUILD_STATUS: ${{ steps.build-node.outputs.NODE_BUILD_STATUS }}
      EXPR_STEPS_TEST_NODE_OUTPUTS_NODE_TEST_STATUS: ${{ steps.test-node.outputs.NODE_TEST_STATUS }}
      EXPR_STEPS_BUILD_GO_OUTPUTS_GO_BUILD_STATUS: ${{ steps.build-go.outputs.GO_BUILD_STATUS }}
      EXPR_STEPS_BUILD_GO_OUTPUTS_GO_TEST_STATUS: ${{ steps.build-go.outputs.GO_TEST_STATUS }}
    run: |
      mkdir -p /tmp/gh-aw/agent
      cat > /tmp/gh-aw/agent/build-test-results.json << RESULTS_EOF
      {
        "gvisor_confirmed": "$EXPR_STEPS_ENV_INFO_OUTPUTS_GVISOR_CONFIRMED",
        "http_code": "$EXPR_STEPS_ENV_INFO_OUTPUTS_SMOKE_HTTP_CODE",
        "node_build": "$EXPR_STEPS_BUILD_NODE_OUTPUTS_NODE_BUILD_STATUS",
        "node_test": "$EXPR_STEPS_TEST_NODE_OUTPUTS_NODE_TEST_STATUS",
        "go_build": "$EXPR_STEPS_BUILD_GO_OUTPUTS_GO_BUILD_STATUS",
        "go_test": "$EXPR_STEPS_BUILD_GO_OUTPUTS_GO_TEST_STATUS"
      }
      RESULTS_EOF
      cat /tmp/gh-aw/agent/build-test-results.json
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
  - name: Report gVisor runtime info
    if: always()
    run: |
      echo "::group::gVisor runtime information"
      runsc --version 2>/dev/null || echo "runsc not found (expected if not installed on host)"
      echo "Docker runtime info:"
      docker info --format '{{.Runtimes}}' 2>/dev/null || true
      echo "::endgroup::"
---

# Smoke Test: gVisor Runtime + Build/Test Workloads

**CRITICAL REQUIREMENT: You MUST call `add_comment` on pull_request triggers. This is the primary success criterion. Do this FIRST before any other analysis.**

**Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Context

This workflow validates that AWF's gVisor runtime (`sandbox.agent.runtime: gvisor`) can handle real-world build and test workloads. All heavy computation has been executed in deterministic pre-agent steps. Your job is to read results and produce the summary.

## Step 1: Read Results

Read the pre-computed results:

```bash
cat /tmp/gh-aw/agent/build-test-results.json
```

The JSON contains:
- `gvisor_confirmed`: whether `/proc/version` showed gVisor
- `http_code`: GitHub.com HTTP response code
- `node_build`: Node.js build status (PASS/FAIL)
- `node_test`: Node.js test status (PASS/FAIL)
- `go_build`: Go build status (PASS/FAIL/CLONE_FAILED)
- `go_test`: Go test status (PASS/FAIL/SKIPPED)

## Step 2: Network Isolation Check

Run this command to verify the AWF firewall is blocking non-whitelisted domains:

```bash
BLOCKED_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://example.com 2>/dev/null || echo "000")
echo "example.com returned: $BLOCKED_CODE"
```

- If `$BLOCKED_CODE` is `000` (connection refused/timeout) or `403` (Squid denied): **PASS** — network isolation is working.
- If `$BLOCKED_CODE` is `200` or any other success code: **FAIL** — the firewall did not block the request.

## Step 3: Output (MANDATORY)

**If triggered by a pull request** (check: `${{ github.event_name }}` equals "pull_request"), you MUST call `add_comment` to post a **brief** comment on the current pull request with:

### 🦎🏗️ gVisor Build Test Results

| Test | Status |
|------|--------|
| gVisor runtime | confirmed/unconfirmed |
| GitHub.com connectivity | ✅/❌ |
| Node.js build (`npm ci && npm run build`) | ✅/❌ |
| Node.js tests (Jest subset) | ✅/❌ |
| Go build (color, uuid) | ✅/❌ |
| Go tests (color, uuid) | ✅/❌ |
| Network isolation | ✅/❌ |

**Overall: PASS/FAIL**

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool to add the label `smoke-gvisor-build` to the pull request

**If triggered by workflow_dispatch** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.