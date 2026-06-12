---
description: Smoke test workflow that validates Claude engine functionality by reviewing recent PRs twice daily
on:
  roles: all
  schedule: every 12h
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
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
tools:
  bash:
    - "*"
  github: false
safe-outputs:
    threat-detection:
      enabled: false
    add-comment:
      hide-older-comments: true
    add-labels:
      allowed: [smoke-claude]
    messages:
      footer: "> 💥 *[THE END] — Illustrated by [{workflow_name}]({run_url})*"
      run-started: "💥 **WHOOSH!** [{workflow_name}]({run_url}) springs into action on this {event_type}! *[Panel 1 begins...]*"
      run-success: "🎬 **THE END** — [{workflow_name}]({run_url}) **MISSION: ACCOMPLISHED!** The hero saves the day! ✨"
      run-failure: "💫 **TO BE CONTINUED...** [{workflow_name}]({run_url}) {status}! Our hero faces unexpected challenges..."
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
  - name: Export workflow context
    env:
      EXPR_GITHUB_EVENT_NAME: ${{ github.event_name }}
      EXPR_GITHUB_RUN_ID: ${{ github.run_id }}
      EXPR_b14517fc: ${{ github.event.pull_request.number || '' }}
    run: |
      cat > /tmp/gh-aw/agent/workflow-context.env << ENVEOF
      export GITHUB_EVENT_NAME="$EXPR_GITHUB_EVENT_NAME"
      export GITHUB_RUN_ID="$EXPR_GITHUB_RUN_ID"
      export PR_NUMBER="$EXPR_b14517fc"
      ENVEOF
      echo "Context exported to /tmp/gh-aw/agent/workflow-context.env"
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
      echo "::notice::Smoke test completed in ${TURN_COUNT} turns (target: 1, hard cap: 2)"
---

# Smoke Test: Claude Engine Validation

Pre-computed data is available:
- **GitHub API**: Recent PRs in `/tmp/gh-aw/agent/recent-prs.json` (already fetched)
- **GitHub check**: Already verified in pre-step — read result from `/tmp/gh-aw/agent/smoke-context.txt`
- **File verify**: `/tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt` (already verified in pre-step)
- **Workflow context**: Source `/tmp/gh-aw/agent/workflow-context.env` for trigger/run variables

**CRITICAL — Single Response Execution:**
This workflow should complete in exactly 1 LLM turn (your first response); `max-turns: 2` is a hard cap for safety.
All required data exists in pre-created files. There is nothing to explore, investigate, or validate beyond reading the 3 files listed below.

Steps:
1. Make ONE bash tool call containing all commands shown below
2. End your response — task complete

If you find yourself thinking "I should check..." or "Let me verify..." — STOP. The pre-steps already verified everything.

## Expected Commands

Execute these commands in a single bash response:

```bash
source /tmp/gh-aw/agent/workflow-context.env
API_COUNT=$(jq 'length' /tmp/gh-aw/agent/recent-prs.json)
GH_CHECK=$(cat /tmp/gh-aw/agent/smoke-context.txt)
cat /tmp/gh-aw/agent/smoke-test-claude-${GITHUB_RUN_ID}.txt

[ "$API_COUNT" -ge 2 ] && API_STATUS='✅ PASS' || API_STATUS='❌ FAIL'
echo "$GH_CHECK" | grep -q '✅' && CHECK_STATUS='✅ PASS' || CHECK_STATUS='❌ FAIL'
FILE_STATUS='✅ PASS'
[ "$API_STATUS" = '✅ PASS' ] && [ "$CHECK_STATUS" = '✅ PASS' ] && TOTAL='PASS' || TOTAL='FAIL'

if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
  printf '{"issue_number":%s,"body":"GitHub API: %s\nGitHub check: %s\nFile verify: %s\n\n**Total: %s**"}' \
    "$PR_NUMBER" "$API_STATUS" "$CHECK_STATUS" "$FILE_STATUS" "$TOTAL" \
    > /tmp/gh-aw/agent/result.json
  safeoutputs add_comment . < /tmp/gh-aw/agent/result.json
  if [ "$TOTAL" = "PASS" ]; then
    printf '{"issue_number":%s,"labels":["smoke-claude"]}' "$PR_NUMBER" \
      > /tmp/gh-aw/agent/labels.json
    safeoutputs add_labels . < /tmp/gh-aw/agent/labels.json
  fi
else
  safeoutputs noop --message "Smoke test: $TOTAL"
fi
```

Do not explore, validate, or make additional checks. All data is pre-verified.

Your tasks (1 line per result):
1. **GitHub API**: Count entries in `/tmp/gh-aw/agent/recent-prs.json` (PASS if ≥ 2)
2. **GitHub check**: Read `/tmp/gh-aw/agent/smoke-context.txt` and report actual `playwright_check` result (PASS if ✅, FAIL if ❌)
3. **File verify**: Confirm file exists at `/tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt`

Call safe-outputs immediately after these 3 reads.
- Use the `safeoutputs` CLI (`add_comment`, `add_labels`, `noop`) with real arguments.
- Do NOT call the `mcp__safeoutputs` MCP tools directly — use only the bash `safeoutputs` CLI command.
- Do not use pipe-to-stdin for safeoutputs JSON payloads. Write JSON to `/tmp/gh-aw/agent/*.json` and pass it with input redirection (`safeoutputs <tool> . < /tmp/gh-aw/agent/<file>.json`).
- Never call `add_comment` or `add_labels` with empty arguments. If you're not ready to send final output, call `noop` with a short message.

**If triggered by pull request**: add a comment with actual ✅/❌ per test and PASS/FAIL total; only add label `smoke-claude` when all checks pass.
**If not triggered by pull request**: use noop to report results.

After calling safeoutputs, stop immediately. Do NOT produce a text summary turn.