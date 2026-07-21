---
description: Smoke gVisor
on:
  workflow_dispatch:
  label_command:
    name: test-gvisor
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
  copilot-requests: write
name: Smoke gVisor
engine:
  id: copilot
  version: 1.0.34
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
    allowed: [smoke-gvisor]
  messages:
    footer: "> 🦎 *gVisor smoke test by [{workflow_name}]({run_url})*"
    run-started: "🦎 [{workflow_name}]({run_url}) is testing gVisor runtime compatibility..."
    run-success: "🦎 [{workflow_name}]({run_url}) completed. gVisor smoke test passed. ✅"
    run-failure: "🦎 [{workflow_name}]({run_url}) reports {status}. gVisor compatibility issue detected."
timeout-minutes: 15
sandbox:
  agent:
    id: awf
    runtime: gvisor
    sudo: true
  mcp:
    version: v0.3.32
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
          # Search all text artifacts for gVisor kernel signature or confirmation
          if grep -r -l -i 'gVisor' "$ARTIFACT_ROOT" --include '*.log' --include '*.json' --include '*.txt' --include '*.jsonl' 2>/dev/null | head -3; then
            echo "✅ gVisor runtime confirmed in agent artifacts"
          else
            echo "⚠️ Could not confirm gVisor in artifacts (agent may not have logged /proc/version)"
          fi
          echo "::endgroup::"
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
steps:
  - name: Smoke test data
    id: smoke-data
    run: |
      echo "::group::Fetching last 2 merged PRs"
      PR_DATA=$(gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 2 \
        --json number,title,author,mergedAt \
        --jq '.[] | "PR #\(.number): \(.title) (by @\(.author.login), merged \(.mergedAt))"')
      echo "$PR_DATA"
      echo "::endgroup::"

      echo "::group::GitHub.com connectivity check"
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com)
      echo "github.com returned HTTP $HTTP_CODE"
      echo "::endgroup::"

      echo "::group::File write/read test"
      TEST_DIR="/tmp/gh-aw/agent"
      TEST_FILE="$TEST_DIR/smoke-test-gvisor-${GITHUB_RUN_ID}.txt"
      mkdir -p "$TEST_DIR"
      echo "gVisor smoke test passed at $(date)" > "$TEST_FILE"
      FILE_CONTENT=$(cat "$TEST_FILE")
      echo "Wrote and read back: $FILE_CONTENT"
      echo "::endgroup::"

      {
        echo "SMOKE_PR_DATA<<SMOKE_EOF"
        echo "$PR_DATA"
        echo "SMOKE_EOF"
        echo "SMOKE_HTTP_CODE=$HTTP_CODE"
        echo "SMOKE_FILE_CONTENT=$FILE_CONTENT"
        echo "SMOKE_FILE_PATH=$TEST_FILE"
      } >> "$GITHUB_OUTPUT"
    env:
      GH_TOKEN: ${{ github.token }}
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

# Smoke Test: gVisor Runtime Compatibility

**CRITICAL REQUIREMENT: You MUST call `add_comment` on pull_request triggers. This is the primary success criterion. Do this FIRST before any other analysis.**

**Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Context

This workflow validates that AWF's network-isolation mode works correctly when the agent container runs under gVisor (`runsc`) instead of the default `runc` runtime. The pre-agent step installed gVisor and registered it as a Docker runtime.

## Pre-Computed Test Results

The following tests were already executed in a deterministic pre-agent step. Your job is to verify the results and produce the summary comment.

### 1. gVisor Runtime Verification (best-effort)
For now, the agent container is expected to be running under the default runtime (`runc`). Run the commands below and report **confirmed** only if you see a gVisor-specific kernel string; otherwise report **unconfirmed** (do not fail the run on this check until runtime plumbing is added).

    cat /proc/version 2>/dev/null || echo "Cannot read /proc/version"
    dmesg 2>/dev/null | head -5 || echo "dmesg not available (may occur under gVisor)"

If `/proc/version` contains `gVisor`, mark runtime as confirmed; otherwise mark it as unconfirmed.

### 2. GitHub MCP Testing
Verify MCP connectivity by calling `github-list_pull_requests` for ${{ github.repository }} (limit 1, state merged). Confirm the result matches the pre-fetched data below.

### 3. GitHub.com Connectivity
Pre-step result: HTTP ${{ steps.smoke-data.outputs.SMOKE_HTTP_CODE }} from github.com.
✅ if HTTP 200 or 301, ❌ otherwise.

### 4. File Write/Read Test
Pre-step wrote and read back: "${{ steps.smoke-data.outputs.SMOKE_FILE_CONTENT }}"
File path: ${{ steps.smoke-data.outputs.SMOKE_FILE_PATH }}
Verify by running `cat` on the file path using bash to confirm it exists.

### 5. Network Isolation Verification
Run `curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://example.com` — this domain is NOT in the allowlist, so it should be blocked (timeout or 403).

## Pre-Fetched PR Data

    ${{ steps.smoke-data.outputs.SMOKE_PR_DATA }}

## Output (MANDATORY)

**If triggered by a pull request** (check: `${{ github.event_name }}` equals "pull_request"), you MUST call `add_comment` to post a **very brief** comment (max 5-10 lines) on the current pull request with:
- 🦎 gVisor runtime: confirmed/unconfirmed
- ✅ or ❌ for each test result
- Overall status: PASS or FAIL
- Mention the pull request author and any assignees

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool to add the label `smoke-gvisor` to the pull request

**If triggered by workflow_dispatch** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.
