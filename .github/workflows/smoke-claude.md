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
engine:
  id: claude
  model: claude-haiku-4-5
  max-turns: 5
sandbox:
  agent:
    version: v0.25.29
  mcp:
    version: v0.3.1
strict: false
tools:
  bash:
    - "*"
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
    run: |
      mkdir -p /tmp/gh-aw/agent
      echo "Smoke test passed for Claude at $(date)" > /tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt
      echo "Smoke test file pre-created at /tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt"
  - name: Pre-fetch GitHub API data
    run: |
      gh pr list --repo ${{ github.repository }} --limit 2 --state merged --json number,title,mergedAt \
        > /tmp/gh-aw/agent/recent-prs.json
      echo "GitHub API pre-check: $(wc -c < /tmp/gh-aw/agent/recent-prs.json) bytes"
    env:
      GH_TOKEN: ${{ github.token }}
  - name: Check GitHub.com reachability
    run: |
      TITLE=$(curl -s --max-time 15 https://github.com | grep -oP '(?<=<title>)[^<]+' | head -1)
      echo "GitHub title: $TITLE"
      if echo "$TITLE" | grep -q "GitHub"; then
        echo "playwright_check=✅ PASS — title: $TITLE" >> /tmp/gh-aw/agent/smoke-context.txt
      else
        echo "playwright_check=❌ FAIL — title not found" >> /tmp/gh-aw/agent/smoke-context.txt
      fi
  - name: Verify smoke test file exists
    run: |
      cat /tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt
      echo "File verification: PASS"
post-steps:
  - name: Show final Claude Code config
    if: always()
    run: |
      echo "=== Final Claude Code Config ==="
      if [ -f ~/.claude.json ]; then
        echo "File: ~/.claude.json"
        cat ~/.claude.json
      else
        echo "~/.claude.json not found"
      fi
      if [ -f ~/.claude/config.json ]; then
        echo ""
        echo "File: ~/.claude/config.json (legacy)"
        cat ~/.claude/config.json
      else
        echo "~/.claude/config.json not found"
      fi
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
---

# Smoke Test: Claude Engine Validation

Pre-computed data is available:
- **GitHub API**: Recent PRs in `/tmp/gh-aw/agent/recent-prs.json` (already fetched)
- **GitHub check**: Already verified in pre-step — read result from `/tmp/gh-aw/agent/smoke-context.txt`
- **File verify**: `/tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt` (already verified in pre-step)

**IMPORTANT — Complete in 1 pass:**
All data is pre-loaded. Do NOT make additional reads or explorations.
1. `cat /tmp/gh-aw/agent/recent-prs.json` → confirm 2 entries
2. `cat /tmp/gh-aw/agent/smoke-context.txt` → confirm `playwright_check` is `✅ PASS`
3. `cat /tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt` → confirm exists

Your tasks (1 line per result):
1. **GitHub API**: Read `/tmp/gh-aw/agent/recent-prs.json` and confirm 2 PR entries exist
2. **GitHub check**: Read `/tmp/gh-aw/agent/smoke-context.txt` and confirm `playwright_check=✅ PASS`
3. **File verify**: Confirm file exists at `/tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt`

Call safe-outputs immediately after these 3 reads.

**If triggered by pull request**: add a brief comment (✅/❌ per test, PASS/FAIL total) and add label `smoke-claude` if all pass.
**If not triggered by pull request**: use noop to report results.
