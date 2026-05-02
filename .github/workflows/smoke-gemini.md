---
description: Smoke test workflow that validates Gemini engine functionality
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
name: Smoke Gemini
engine: gemini
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
    allowed: [smoke-gemini]
  messages:
    footer: "> 💎 *Faceted by [{workflow_name}]({run_url})*"
    run-started: "💎 [{workflow_name}]({run_url}) is crystallizing results on this {event_type}..."
    run-success: "✅ [{workflow_name}]({run_url}) completed. All facets verified. 💎"
    run-failure: "❌ [{workflow_name}]({run_url}) reports {status}. Facets need polishing..."
secrets:
  GEMINI_API_KEY:
    value: ${{ secrets.GEMINI_API_KEY }}
    description: "Google Gemini API key for inference"
timeout-minutes: 5
sandbox:
  agent:
    version: v0.25.29
strict: true
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

# Smoke Test: Gemini Engine Validation

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

> Use `perPage: 2` when listing PRs.

## Test Requirements

1. **GitHub MCP Testing**: Review the last 2 merged pull requests in ${{ github.repository }}
2. **GitHub.com Connectivity**: Use bash to run `curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com` and verify the HTTP status is 200 or 301
3. **File Writing Testing**: Create a test file `/tmp/gh-aw/agent/smoke-test-gemini-${{ github.run_id }}.txt` with content "Smoke test passed for Gemini at $(date)" (create the directory if it doesn't exist)
4. **Bash Tool Testing**: Execute bash commands to verify file creation was successful (use `cat` to read the file back)

## Output

**If triggered by a pull request**, add a **very brief** comment (max 5-10 lines) to the current pull request with:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Overall status: PASS or FAIL

If all tests pass, add the label `smoke-gemini` to the pull request.

**If triggered by workflow_dispatch or schedule** (no PR context), use a noop safe output to report the test results summary instead. Do NOT attempt to add comments or labels when there is no pull request.
