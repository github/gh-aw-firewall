---
description: Smoke test for Copilot CLI in offline BYOK mode — validates COPILOT_OFFLINE path through the api-proxy sidecar
on:
  roles: all
  schedule: every 12h
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
  reaction: "rocket"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
name: Smoke Copilot BYOK
engine: copilot
network:
  allowed:
    - defaults
    - github
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
    allowed: [smoke-copilot-byok]
  messages:
    footer: "> 🔑 *BYOK report filed by [{workflow_name}]({run_url})*"
    run-started: "🔑 [{workflow_name}]({run_url}) is testing offline BYOK mode on this {event_type}..."
    run-success: "✅ [{workflow_name}]({run_url}) completed. Copilot BYOK mode operational. 🔓"
    run-failure: "❌ [{workflow_name}]({run_url}) reports {status}. BYOK mode investigation needed..."
timeout-minutes: 5
env:
  COPILOT_API_KEY: dummy-byok-key-for-offline-mode
  COPILOT_MODEL: gpt-4.1
features:
  cli-proxy: true
strict: true
steps:
  - name: Pre-compute BYOK smoke test data
    id: smoke-data
    run: |
      echo "::group::Verify BYOK configuration"
      echo "COPILOT_API_KEY=${COPILOT_API_KEY:+set (${#COPILOT_API_KEY} chars)}"
      echo "COPILOT_API_TARGET=${COPILOT_API_TARGET:-api.githubcopilot.com (default)}"
      echo "::endgroup::"

      echo "::group::File write/read test"
      TEST_DIR="/tmp/gh-aw/agent"
      TEST_FILE="$TEST_DIR/smoke-test-copilot-byok-${GITHUB_RUN_ID}.txt"
      mkdir -p "$TEST_DIR"
      echo "BYOK smoke test passed at $(date)" > "$TEST_FILE"
      FILE_CONTENT=$(cat "$TEST_FILE")
      echo "Wrote and read back: $FILE_CONTENT"
      echo "::endgroup::"

      {
        echo "SMOKE_FILE_CONTENT=$FILE_CONTENT"
        echo "SMOKE_FILE_PATH=$TEST_FILE"
      } >> "$GITHUB_OUTPUT"
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
  - name: Verify BYOK mode was active
    run: |
      LOGS_DIR="/tmp/gh-aw/sandbox/firewall/logs"
      if [ -d "$LOGS_DIR" ]; then
        echo "::group::Checking firewall logs for offline BYOK traffic"
        if find "$LOGS_DIR" -name '*.log' -exec grep -l "api.githubcopilot.com" {} + 2>/dev/null; then
          echo "✅ Detected traffic to api.githubcopilot.com via api-proxy (BYOK offline mode)"
        else
          echo "::warning::No traffic to api.githubcopilot.com found in firewall logs"
        fi
        echo "::endgroup::"
      fi
---

# Smoke Test: Copilot BYOK (Offline) Mode

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Purpose

This smoke test validates that Copilot CLI runs in **offline BYOK mode** — with `COPILOT_OFFLINE=true` set by AWF because `COPILOT_API_KEY` is present. Inference requests are routed through the api-proxy sidecar to `api.githubcopilot.com`, authenticated with `COPILOT_GITHUB_TOKEN` (the real credential held by the sidecar). The agent only sees a dummy `COPILOT_API_KEY` placeholder.

## Pre-Computed Test Results

### 1. File Write/Read Test
Pre-step wrote and read back: "${{ steps.smoke-data.outputs.SMOKE_FILE_CONTENT }}"
File path: ${{ steps.smoke-data.outputs.SMOKE_FILE_PATH }}
Verify by running `cat` on the file path using bash to confirm it exists.

### 2. GitHub MCP Testing
Verify MCP connectivity by calling `github-list_pull_requests` for ${{ github.repository }} (limit 1, state merged). Confirm the result returns data.

### 3. BYOK Inference Test
You are running in offline BYOK mode right now. The fact that you can read this prompt and respond means the BYOK inference path (agent → api-proxy sidecar → api.githubcopilot.com) is working. Confirm ✅.

## Output

Add a **very brief** comment (max 5-10 lines) to the current pull request with:
- ✅ or ❌ for each test result (file I/O, MCP, inference)
- Note: "Running in BYOK offline mode (COPILOT_OFFLINE=true) via api-proxy → api.githubcopilot.com"
- Overall status: PASS or FAIL
- Mention the pull request author and any assignees

If all tests pass, add the label `smoke-copilot-byok` to the pull request.
