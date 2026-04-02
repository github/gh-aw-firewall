---
description: Smoke Copilot
on:
  roles: all
  schedule: every 12h
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
name: Smoke Copilot
engine: copilot
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - "*"
  github:
    toolsets: [repos, pull_requests]
safe-outputs:
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [smoke-copilot]
  messages:
    footer: "> 📰 *BREAKING: Report filed by [{workflow_name}]({run_url})*"
    run-started: "📰 BREAKING: [{workflow_name}]({run_url}) is now investigating this {event_type}. Sources say the story is developing..."
    run-success: "📰 VERDICT: [{workflow_name}]({run_url}) has concluded. All systems operational. This is a developing story. 🎤"
    run-failure: "📰 DEVELOPING STORY: [{workflow_name}]({run_url}) reports {status}. Our correspondents are investigating the incident..."
timeout-minutes: 5
strict: true
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
      TEST_FILE="$TEST_DIR/smoke-test-copilot-${GITHUB_RUN_ID}.txt"
      mkdir -p "$TEST_DIR"
      echo "Smoke test passed for Copilot at $(date)" > "$TEST_FILE"
      FILE_CONTENT=$(cat "$TEST_FILE")
      echo "Wrote and read back: $FILE_CONTENT"
      echo "::endgroup::"

      # Export results for agent context
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

# Smoke Test: Copilot Engine Validation

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Pre-Computed Test Results

The following tests were already executed in a deterministic pre-agent step. Your job is to verify the results and produce the summary comment.

### 1. GitHub MCP Testing
The last 2 merged pull requests have been fetched. Verify MCP connectivity by calling `github-list_pull_requests` for ${{ github.repository }} (limit 1, state merged) and confirm data is returned.

### 2. GitHub.com Connectivity
Pre-step result: HTTP ${{ steps.smoke-data.outputs.SMOKE_HTTP_CODE }} from github.com.
✅ if HTTP 200 or 301, ❌ otherwise.

### 3. File Write/Read Test
Pre-step wrote and read back: "${{ steps.smoke-data.outputs.SMOKE_FILE_CONTENT }}"
File path: ${{ steps.smoke-data.outputs.SMOKE_FILE_PATH }}
Verify by running `cat` on the file path using bash to confirm it exists.

### 4. Bash Tool Testing
Run a simple bash command (e.g., `echo "bash works"`) to verify the bash tool is functional.

## Pre-Fetched PR Data

```
${{ steps.smoke-data.outputs.SMOKE_PR_DATA }}
```

## Output

Add a **very brief** comment (max 5-10 lines) to the current pull request with:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Overall status: PASS or FAIL
- Mention the pull request author and any assignees

If all tests pass, add the label `smoke-copilot` to the pull request.