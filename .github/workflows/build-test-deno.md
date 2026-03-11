---
description: Build Test Deno
on:
  roles: all
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read
  issues: read
name: Build Test Deno
engine: copilot
network:
  allowed:
    - defaults
    - github
    - node
    - "deno.land"
    - "jsr.io"
    - "dl.deno.land"
tools:
  bash:
    - "*"
  github:
    github-token: "${{ secrets.GH_AW_GITHUB_MCP_SERVER_TOKEN }}"
sandbox:
  mcp:
    container: "ghcr.io/github/gh-aw-mcpg"
safe-outputs:
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [build-test-deno]
  messages:
    run-failure: "**Build Test Failed** [{workflow_name}]({run_url}) - See logs for details"
timeout-minutes: 15
strict: true
---

# Build Test: Deno

**IMPORTANT: Keep all outputs concise. Report results clearly with pass/fail status.**

## Test Requirements

1. **Install Deno**:
   ```bash
   curl -fsSL https://deno.land/install.sh | sh
   export DENO_INSTALL="$HOME/.deno"
   export PATH="$DENO_INSTALL/bin:$PATH"
   ```

2. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-deno /tmp/test-deno`
   - **CRITICAL**: If clone fails, immediately call `safeoutputs-missing_tool` with message "CLONE_FAILED: Unable to clone test repository" and stop execution

3. **Test Projects**:
   - `oak`: `cd /tmp/test-deno/oak && deno test`
   - `std`: `cd /tmp/test-deno/std && deno test`

4. **For each project**, capture:
   - Test pass/fail count
   - Any error messages

## Output

Add a comment to the current pull request with a summary table:

| Project | Tests | Status |
|---------|-------|--------|
| oak     | X/Y   | PASS/FAIL |
| std     | X/Y   | PASS/FAIL |

**Overall: PASS/FAIL**

If ALL tests pass, add the label `build-test-deno` to the pull request.
If ANY test fails, report the failure with error details.

## Error Handling

**CRITICAL**: This workflow MUST fail visibly when errors occur:

1. **Clone failure**: If repository clone fails, call `safeoutputs-missing_tool` with "CLONE_FAILED: [error message]"
2. **Deno install failure**: Call `safeoutputs-missing_tool` with "DENO_INSTALL_FAILED: [error message]"
3. **Test failure**: Report in comment table with FAIL status and include failure details

DO NOT report success if any step fails. The workflow should produce a clear, actionable error message.