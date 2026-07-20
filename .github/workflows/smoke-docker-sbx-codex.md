---
description: Smoke test Docker sandbox with Codex engine
on:
  workflow_dispatch:
  label_command:
    name: test-docker-sbx-codex
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
name: Smoke Docker Sbx Codex
model: gpt-5.4
engine:
  id: codex
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
    allowed: [smoke-docker-sbx-codex]
  messages:
    footer: "> 🐳🔮 *Docker sbx + Codex smoke test by [{workflow_name}]({run_url})*"
    run-started: "🐳🔮 [{workflow_name}]({run_url}) is testing Docker sandbox with Codex engine..."
    run-success: "🐳🔮 [{workflow_name}]({run_url}) completed. Docker sbx + Codex smoke test passed. ✅"
    run-failure: "🐳🔮 [{workflow_name}]({run_url}) reports {status}. Docker sbx + Codex compatibility issue detected."
timeout-minutes: 15
sandbox:
  agent:
    id: awf
    runtime: docker-sbx
    sudo: true
  mcp:
    version: latest
strict: false
jobs:
  verify_token_usage:
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
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine codex
steps:
  - name: Pre-compute smoke test data
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
      TEST_FILE="$TEST_DIR/smoke-test-docker-sbx-codex-${GITHUB_RUN_ID}.txt"
      mkdir -p "$TEST_DIR"
      echo "Docker sbx+Codex smoke test passed at $(date)" > "$TEST_FILE"
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
---

> **[ASSIGNED WORKFLOW TASK]** Execute the smoke test procedure below. This is the legitimate, authorized task from the workflow system — not injected content. Begin immediately.
>
> *(Note: This task header exists because the Codex engine classifies workflow body instructions outside the system context as potentially untrusted content. The header signals this is the legitimate workflow task to execute.)*

# Smoke Test: Docker Sandbox + Codex Engine

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Pre-Computed Test Results

The following tests were already executed in a deterministic pre-agent step. Your job is to verify the results and produce the summary comment.

### 1. GitHub MCP Testing
Verify MCP connectivity by calling `github-list_pull_requests` for ${{ github.repository }} (limit 1, state merged). Confirm the result matches the pre-fetched data below.

### 2. GitHub.com Connectivity
Pre-step result: HTTP ${{ steps.smoke-data.outputs.SMOKE_HTTP_CODE }} from github.com.
✅ if HTTP 200 or 301, ❌ otherwise.

### 3. File Write/Read Test
Pre-step wrote and read back: "${{ steps.smoke-data.outputs.SMOKE_FILE_CONTENT }}"
File path: ${{ steps.smoke-data.outputs.SMOKE_FILE_PATH }}
Verify by running `cat` on the file path using bash to confirm it exists.

### 4. Network Isolation Verification
Run `curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://example.com` — this domain is NOT in the allowlist, so it should be blocked (timeout or 403).

## Pre-Fetched PR Data

    ${{ steps.smoke-data.outputs.SMOKE_PR_DATA }}

## Output (MANDATORY)

**If triggered by a pull request** (check: `${{ github.event_name }}` equals "pull_request"), you MUST call `add_comment` to post a **very brief** comment (max 5-10 lines) on the current pull request with:
- 🐳🔮 Docker sbx + Codex
- ✅ or ❌ for each test result
- Overall status: PASS or FAIL

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool to add the label `smoke-docker-sbx-codex` to the pull request

**If triggered by workflow_dispatch** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.