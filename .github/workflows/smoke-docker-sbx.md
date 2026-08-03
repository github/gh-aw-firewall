---
description: Smoke Docker Sbx
on:
  roles: all
  workflow_dispatch:
  label_command:
    name: ready-for-aw
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
  copilot-requests: write
name: Smoke Docker Sbx
engine:
  id: copilot
  version: 1.0.34
model: claude-sonnet-5
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
    allowed: [smoke-docker-sbx]
  messages:
    footer: "> 📰 *BREAKING: Report filed by [{workflow_name}]({run_url})*"
    run-started: "📰 BREAKING: [{workflow_name}]({run_url}) is now investigating this {event_type}. Sources say the story is developing..."
    run-success: "📰 VERDICT: [{workflow_name}]({run_url}) has concluded. All systems operational. This is a developing story. 🎤"
    run-failure: "📰 DEVELOPING STORY: [{workflow_name}]({run_url}) reports {status}. Our correspondents are investigating the incident..."
timeout-minutes: 15
sandbox:
  agent:
    id: awf
    runtime: docker-sbx
    sudo: true
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
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
steps:
  - name: Pre-compute smoke test data
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
      TEST_FILE="$TEST_DIR/smoke-test-docker-sbx-${GITHUB_RUN_ID}.txt"
      mkdir -p "$TEST_DIR"
      echo "Smoke test passed for Docker Sbx at $(date)" > "$TEST_FILE"
      FILE_CONTENT=$(cat "$TEST_FILE")
      echo "Wrote and read back: $FILE_CONTENT"
      echo "::endgroup::"

      # Write results to files for agent context
      mkdir -p /tmp/gh-aw/agent
      echo "$HTTP_CODE" > /tmp/gh-aw/agent/smoke-http-code.txt
      echo "$FILE_CONTENT" > /tmp/gh-aw/agent/smoke-file-content.txt
      echo "$TEST_FILE" > /tmp/gh-aw/agent/smoke-file-path.txt
      echo "$PR_DATA" > /tmp/gh-aw/agent/smoke-pr-data.txt
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

# Smoke Test: Docker Sbx Validation

**CRITICAL REQUIREMENT: You MUST call `add_comment` on pull_request triggers. This is the primary success criterion. Do this FIRST before any other analysis.**

**Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Pre-Computed Test Results

The following tests were already executed in a deterministic pre-agent step. Your job is to verify the results and produce the summary comment.

### 1. GitHub MCP Testing
Verify MCP connectivity by calling `github-list_pull_requests` for ${{ github.repository }} (limit 2, state merged). Confirm the result matches the pre-fetched data below.
### 2. GitHub.com Connectivity
Pre-step result: HTTP (see `/tmp/gh-aw/agent/smoke-http-code.txt`) from github.com.
✅ if HTTP 200 or 301, ❌ otherwise.

### 3. File Write/Read Test
Pre-step wrote and read back: "(see `/tmp/gh-aw/agent/smoke-file-content.txt`)"
File path: (see `/tmp/gh-aw/agent/smoke-file-path.txt`)
Verify by running `cat` on the file path using bash to confirm it exists.

## Pre-Fetched PR Data

    (see `/tmp/gh-aw/agent/smoke-pr-data.txt`)

## Output (MANDATORY)

**If triggered by a pull request** (check: `${{ github.event_name }}` equals "pull_request"), you MUST call `add_comment` with `item_number: ${{ github.event.pull_request.number }}` to post a **very brief** comment (max 5-10 lines) on the current pull request. Do not rely on implicit triggering context, because Docker sbx may not propagate the event name into the safe-outputs gateway. Include:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Overall status: PASS or FAIL
- Mention the pull request author and any assignees

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool with `item_number: ${{ github.event.pull_request.number }}` to add the label `smoke-docker-sbx` to the pull request

**If triggered by workflow_dispatch or schedule** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.