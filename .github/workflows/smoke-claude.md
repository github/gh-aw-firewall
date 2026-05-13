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
  max-turns: 12
sandbox:
  agent:
    version: v0.25.29
  mcp:
    version: v0.3.1
strict: false
network:
  allowed:
    - github
    - playwright
tools:
  github:
    mode: gh-proxy
    toolsets: [pull_requests]
  playwright:
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
  - name: Ensure playwright log directory is writable
    run: |
      mkdir -p /tmp/gh-aw/mcp-logs/playwright
      chmod 777 /tmp/gh-aw/mcp-logs/playwright
  - name: Create smoke test file
    run: |
      mkdir -p /tmp/gh-aw/agent
      echo "Smoke test passed for Claude at $(date)" > /tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt
      echo "Smoke test file pre-created: $(cat /tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt)"
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

Smoke test (keep all output to 1 line per test):
1. **GitHub API**: List last 2 merged PRs in ${{ github.repository }} (perPage: 2)
2. **Playwright**: Navigate to https://github.com, confirm title contains "GitHub"
3. **File verify**: `cat /tmp/gh-aw/agent/smoke-test-claude-${{ github.run_id }}.txt`

**If triggered by pull request**: add a brief comment (✅/❌ per test, PASS/FAIL total) and add label `smoke-claude` if all pass.
**If not triggered by pull request**: use noop to report results.