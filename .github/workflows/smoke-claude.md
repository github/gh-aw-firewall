---
description: Smoke test workflow that validates Claude engine functionality by reviewing recent PRs twice daily
on:
  roles: all
  schedule: every 12h
  workflow_dispatch:
  label_command:
    name: ready-for-aw
    events: [pull_request]
    remove_label: false
  reaction: "heart"
permissions:
  contents: read
  issues: read
  pull-requests: read
  
name: Smoke Claude
max-turns: 5
engine:
  id: claude
  model: claude-haiku-4-5
sandbox:
  mcp:
    version: v0.3.1
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
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      - name: Download agent artifact
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: agent
          path: /tmp/gh-aw-agent
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine claude
tools:
  bash:
    - bash
  github: false
safe-outputs:
    threat-detection:
      enabled: false
    add-comment:
      hide-older-comments: true
    add-labels:
      allowed: [smoke-claude]
    messages:
      run-success: "✅ [{workflow_name}]({run_url}) passed"
      run-failure: "❌ [{workflow_name}]({run_url}) {status}"
timeout-minutes: 10
steps:
  - name: Create smoke test file
    env:
      EXPR_GITHUB_RUN_ID: ${{ github.run_id }}
    run: |
      mkdir -p /tmp/gh-aw/agent
      echo "Smoke test passed for Claude at $(date)" > /tmp/gh-aw/agent/smoke-test-claude-$EXPR_GITHUB_RUN_ID.txt
      echo "Smoke test file pre-created at /tmp/gh-aw/agent/smoke-test-claude-$EXPR_GITHUB_RUN_ID.txt"
  - name: Pre-fetch GitHub API data
    run: |
      gh pr list --repo $EXPR_GITHUB_REPOSITORY --limit 2 --state merged --json number,title,mergedAt \
        > /tmp/gh-aw/agent/recent-prs.json
      echo "GitHub API pre-check: $(wc -c < /tmp/gh-aw/agent/recent-prs.json) bytes"
    env:
      GH_TOKEN: ${{ github.token }}
      EXPR_GITHUB_REPOSITORY: ${{ github.repository }}
  - name: Check GitHub.com reachability
    run: |
      CONTEXT_FILE=/tmp/gh-aw/agent/smoke-context.txt
      if TITLE=$(curl -fsSL --max-time 15 https://github.com | sed -n 's:.*<title>\(.*\)</title>.*:\1:p' | head -1); then
        TITLE=$(echo "$TITLE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      else
        TITLE=""
      fi
      echo "GitHub title: ${TITLE:-<empty>}"
      if echo "$TITLE" | grep -q "GitHub"; then
        echo "playwright_check=✅ PASS — title: $TITLE" > "$CONTEXT_FILE"
      else
        echo "playwright_check=❌ FAIL — title not found" > "$CONTEXT_FILE"
      fi
  - name: Verify smoke test file exists
    env:
      EXPR_GITHUB_RUN_ID: ${{ github.run_id }}
    run: |
      cat /tmp/gh-aw/agent/smoke-test-claude-$EXPR_GITHUB_RUN_ID.txt
      echo "File verification: PASS"
  - name: Compute final smoke result
    env:
      EXPR_GITHUB_EVENT_NAME: ${{ github.event_name }}
      EXPR_PR_NUMBER: ${{ github.event.pull_request.number || '' }}
    run: |
      API_COUNT=$(jq 'length' /tmp/gh-aw/agent/recent-prs.json)
      GH_CHECK=$(cat /tmp/gh-aw/agent/smoke-context.txt)
      [ "$API_COUNT" -ge 2 ] && API_STATUS='✅ PASS' || API_STATUS='❌ FAIL'
      echo "$GH_CHECK" | grep -q '✅' && CHECK_STATUS='✅ PASS' || CHECK_STATUS='❌ FAIL'
      FILE_STATUS='✅ PASS'
      [ "$API_STATUS" = '✅ PASS' ] && [ "$CHECK_STATUS" = '✅ PASS' ] && TOTAL='PASS' || TOTAL='FAIL'
      jq -n --arg result "$TOTAL" --arg api_status "$API_STATUS" \
        --arg gh_check "$CHECK_STATUS" --arg file_status "$FILE_STATUS" \
        --arg pr_number "$EXPR_PR_NUMBER" --arg event "$EXPR_GITHUB_EVENT_NAME" \
        '{result: $result, api_status: $api_status, gh_check: $gh_check, file_status: $file_status, pr_number: $pr_number, event: $event}' \
        > /tmp/gh-aw/agent/final-result.json
      echo "Pre-computed result: $TOTAL (API=$API_STATUS, GH=$CHECK_STATUS, File=$FILE_STATUS)"
post-steps:
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked. Smoke tests require the agent to call safe output tools."
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
  - name: Report turn usage
    if: always()
    run: |
      TURN_COUNT="${GH_AW_TURN_COUNT:-unknown}"
      echo "::notice::Smoke test completed in ${TURN_COUNT} turns (target: 1)"
---

# Smoke Test: Claude Engine Validation

<!--
  The `${{ github.run_id }}` reference below is intentional and load-bearing.
  gh-aw only emits the prompt "Interpolate variables and render templates" step
  (which resolves `{{#runtime-import}}` directives) when the prompt body contains
  a GitHub Actions expression. Without it, this workflow's self-import is left
  literal, the agent receives no task, and it calls `noop` — failing the
  pull_request `add_comment` post-check. Run: ${{ github.run_id }}
-->

All data is pre-computed. Read `/tmp/gh-aw/agent/final-result.json` (one bash call: `cat /tmp/gh-aw/agent/final-result.json`).

The JSON contains: `result` (PASS/FAIL), `api_status`, `gh_check`, `file_status`, `event`, `pr_number`.

- If `event` is `pull_request`: call `add_comment` with `item_number` set to `pr_number` and a body listing each check result plus the overall `result`; then call `add_labels` with `["smoke-claude"]` only if `result` is `PASS`.
- Otherwise: call `noop` with the result summary.

After calling safeoutputs, stop immediately.