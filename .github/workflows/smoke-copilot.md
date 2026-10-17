---
description: Smoke Copilot
on:
  roles: all
  schedule: every 12h
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
name: Smoke Copilot
engine:
  id: copilot
network:
  allowed:
    - defaults
    - github
tools:
  github:
    toolsets: [pull_requests]
    allowed: [list_pull_requests]
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [smoke-copilot]
  messages:
    footer: "> 📰 *BREAKING: Report filed by [{workflow_name}]({run_url})*"
    run-started: "📰 BREAKING: [{workflow_name}]({run_url}) is now investigating this {event_type}. Sources say the story is developing..."
    run-success: "📰 VERDICT: [{workflow_name}]({run_url}) has concluded. All systems operational. This is a developing story. 🎤"
    run-failure: "📰 DEVELOPING STORY: [{workflow_name}]({run_url}) reports {status}. Our correspondents are investigating the incident..."
timeout-minutes: 15
strict: false
jobs:
  verify_token_usage:
    needs: agent
    if: needs.agent.result == 'success'
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
steps:
  - name: Pre-compute smoke test data
    id: smoke
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

      PR_AUTHOR=""
      PR_ASSIGNEES=""
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
        PR_AUTHOR=$(jq -r '.pull_request.user.login // ""' "$GITHUB_EVENT_PATH")
        PR_ASSIGNEES=$(jq -r '[.pull_request.assignees[]?.login] | join(", ")' "$GITHUB_EVENT_PATH")
      fi

      DELIMITER="gh_aw_smoke_pr_data_${GITHUB_RUN_ID}_${RANDOM}"
      while grep -Fqx "$DELIMITER" <<< "$PR_DATA"; do
        DELIMITER="gh_aw_smoke_pr_data_${GITHUB_RUN_ID}_${RANDOM}"
      done

      {
        echo "http_code=$HTTP_CODE"
        echo "file_content=$FILE_CONTENT"
        echo "pr_author=$PR_AUTHOR"
        echo "pr_assignees=$PR_ASSIGNEES"
        echo "pr_data<<$DELIMITER"
        printf '%s\n' "$PR_DATA"
        echo "$DELIMITER"
      } >> "$GITHUB_OUTPUT"
    env:
      GH_TOKEN: ${{ github.token }}
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
---

# Smoke Test: Copilot Engine Validation

**CRITICAL: On pull_request triggers, call `add_comment` first. Keep all outputs extremely short, using single lines where possible.**

## Tests

### 1. GitHub MCP
Make exactly one GitHub MCP call: `github-list_pull_requests` for the run-specific repository below, with `perPage: 1` and `fields: [number, title]`. Do not call `pull_request_read` or any other GitHub MCP tool. A successful response confirms MCP connectivity.

### 2. GitHub.com Connectivity
✅ if the pre-computed HTTP status is 200 or 301, ❌ otherwise.

### 3. File Write/Read
The pre-step confirmed the test file was written and read back successfully.

## Output (MANDATORY)

If triggered by a pull request, call `add_comment` to post a very brief comment (max 5–10 lines) on the current pull request with:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Overall status: PASS or FAIL
- Mention the current pull request author and any assignees listed below

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool to add the label `smoke-copilot` to the pull request

If triggered by workflow_dispatch or schedule, call `noop` with a concise PASS/FAIL summary instead. Do not attempt pull request comments or labels when there is no pull request.

## Run-specific data

- Repository: ${{ github.repository }}
- Trigger: ${{ github.event_name }}
- GitHub.com HTTP status: ${{ steps.smoke.outputs.http_code }}
- File write/read content: ${{ steps.smoke.outputs.file_content }}
- Current pull request author: ${{ steps.smoke.outputs.pr_author }}
- Current pull request assignees: ${{ steps.smoke.outputs.pr_assignees }}
- Pre-fetched merged PRs:
${{ steps.smoke.outputs.pr_data }}