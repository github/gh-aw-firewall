---
description: Smoke test workflow that validates OpenCode engine functionality by testing AWF firewall capabilities
on: 
  roles: all
  schedule: every 12h
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
  reaction: "rocket"
permissions:
  contents: read
  issues: read
  pull-requests: read
  discussions: read
name: Smoke OpenCode
engine: opencode
features:
  cli-proxy: true
strict: true
imports:
  - shared/gh.md
  - shared/reporting.md
network:
  allowed:
    - defaults
    - github
tools:
  cache-memory: true
  github:
    toolsets: [repos, pull_requests]
  edit:
  bash:
    - "*"
safe-outputs:
    threat-detection:
      enabled: false
    add-comment:
      hide-older-comments: true
      max: 2
    create-issue:
      expires: 2h
      close-older-issues: true
    add-labels:
      allowed: [smoke-opencode]
    hide-comment:
    messages:
      footer: "> 🌐 *Transmitted by [{workflow_name}]({run_url})*"
      run-started: "🌐 [{workflow_name}]({run_url}) is initializing on this {event_type}..."
      run-success: "✅ [{workflow_name}]({run_url}) completed successfully. All systems nominal. 🚀"
      run-failure: "❌ [{workflow_name}]({run_url}) {status}. Investigation required..."
timeout-minutes: 15
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
---

# Smoke Test: OpenCode Engine Validation

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Test Requirements

1. **GitHub MCP Testing**: Review the last 2 merged pull requests in `__GH_AW_GITHUB_REPOSITORY__`
2. **File Writing Testing**: Create a test file `/tmp/gh-aw/agent/smoke-test-opencode-${{ github.run_id }}.txt` with content "Smoke test passed for OpenCode at $(date)" (create the directory if it doesn't exist)
3. **Bash Tool Testing**: Execute bash commands to verify file creation was successful (use `cat` to read the file back)
4. **Build AWF**: Run `npm ci && npm run build` to verify the agent can successfully build the AWF project. If the command fails, mark this test as ❌ and report the failure.
5. **Add Comment**: Use the `add_comment` tool to post a brief summary comment on the current pull request

## Output

**REQUIRED**: Call `add_comment` to post a brief comment (max 5-10 lines) on the current pull request (this is validated by the post-step check) containing:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Overall status: PASS or FAIL

If all tests pass:
- Use the `add_labels` safe-output tool to add the label `smoke-opencode` to the pull request
