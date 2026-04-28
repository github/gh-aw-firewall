---
description: Smoke test workflow that validates Codex engine functionality by testing AWF firewall capabilities
on: 
  roles: all
  schedule: every 12h
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
  reaction: "hooray"
permissions:
  contents: read
  issues: read
  pull-requests: read
  discussions: read
name: Smoke Codex
engine: codex
sandbox:
  agent:
    version: v0.25.29
  mcp:
    version: v0.3.1
strict: false
imports:
  - shared/gh.md
  - shared/mcp/tavily.md
  - shared/reporting.md
  - shared/github-queries-safe-input.md
network:
  allowed:
    - defaults
    - chatgpt.com
    - github
    - playwright
tools:
  cache-memory: true
  github:
    mode: gh-proxy
  playwright:
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
      allowed: [smoke-codex]
    hide-comment:
    messages:
      footer: "> 🔮 *The oracle has spoken through [{workflow_name}]({run_url})*"
      run-started: "🔮 The ancient spirits stir... [{workflow_name}]({run_url}) awakens to divine this {event_type}..."
      run-success: "✨ The prophecy is fulfilled... [{workflow_name}]({run_url}) has completed its mystical journey. The stars align. 🌟"
      run-failure: "🌑 The shadows whisper... [{workflow_name}]({run_url}) {status}. The oracle requires further meditation..."
timeout-minutes: 15
post-steps:
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"

      # Detect permission-blocked writes (PR runs with read-only permissions)
      PERMISSION_BLOCKED=false
      for LOG_FILE in "/tmp/gh-aw/agent-stdio.log" "${RUNNER_TEMP}/gh-aw/agent-stdio.log"; do
        if [ -f "$LOG_FILE" ] && grep -qE 'blocked by permissions in this environment|GraphQL operation denied' "$LOG_FILE"; then
          PERMISSION_BLOCKED=true
          echo "::warning::Detected permission-blocked write actions in agent output; relaxing safe-output checks."
          break
        fi
      done

      if [ ! -s "$OUTPUTS_FILE" ]; then
        if [ "$PERMISSION_BLOCKED" = true ]; then
          echo "Safe outputs empty but permissions were blocked — skipping validation."
          exit 0
        fi
        echo "::error::No safe outputs were invoked. Smoke tests require the agent to call safe output tools."
        exit 1
      fi
      echo "Safe output entries found: $(wc -l < "$OUTPUTS_FILE")"
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
        if ! grep -q '"add_comment"' "$OUTPUTS_FILE"; then
          if [ "$PERMISSION_BLOCKED" = true ]; then
            echo "add_comment missing but permissions were blocked — skipping."
            exit 0
          fi
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

# Smoke Test: Codex Engine Validation

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Test Requirements

1. **GitHub MCP Testing**: Review the last 2 merged pull requests in `__GH_AW_GITHUB_REPOSITORY__`
2. **Safe Inputs GH CLI Testing**: Use the `safeinputs-gh` tool to query 2 pull requests from `__GH_AW_GITHUB_REPOSITORY__` (use args: `pr list --repo __GH_AW_GITHUB_REPOSITORY__ --limit 2 --json number,title,author`)
3. **Playwright Testing**: Use the playwright tools to navigate to https://github.com and verify the page title contains "GitHub" (do NOT try to install playwright - use the provided MCP tools)
4. **Tavily Web Search Testing**: Use the Tavily MCP server to perform a web search for "GitHub Agentic Workflows Firewall" and verify that results are returned with at least one item
5. **File Writing Testing**: Create a test file `/tmp/gh-aw/agent/smoke-test-codex-${{ github.run_id }}.txt` with content "Smoke test passed for Codex at $(date)" (create the directory if it doesn't exist)
6. **Bash Tool Testing**: Execute bash commands to verify file creation was successful (use `cat` to read the file back)
7. **Discussion Interaction Testing**: 
   - Use the `github-discussion-query` safe-input tool with params: `limit=1, jq=".[0]"` to get the latest discussion from `__GH_AW_GITHUB_REPOSITORY__`
   - Extract the discussion number from the result (e.g., if the result is `{"number": 123, "title": "...", ...}`, extract 123)
   - Use the `add_comment` tool with `discussion_number: <extracted_number>` to add a mystical, oracle-themed comment stating that the smoke test agent was here
8. **Build AWF**: Run `npm ci && npm run build` to verify the agent can successfully build the AWF project. If the command fails, mark this test as ❌ and report the failure.

## Output

**REQUIRED**: Call `add_comment` to post a brief comment (max 5-10 lines) on the current pull request (this is validated by the post-step check) containing:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Overall status: PASS or FAIL

Use the `add_comment` tool to add a **mystical oracle-themed comment** to the latest discussion (using the `discussion_number` you extracted in step 7) - be creative and use mystical language like "🔮 The ancient spirits stir..."

If all tests pass:
- Use the `add_labels` safe-output tool to add the label `smoke-codex` to the pull request