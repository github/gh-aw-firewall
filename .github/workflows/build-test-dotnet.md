---
description: Build Test .NET
on:
  roles: all
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read
  issues: read
name: Build Test .NET
engine: copilot
runtimes:
  dotnet:
    version: "8.0"
network:
  allowed:
    - defaults
    - github
    - dotnet
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
    allowed: [build-test-dotnet]
  messages:
    run-failure: "**Build Test Failed** [{workflow_name}]({run_url}) - See logs for details"
timeout-minutes: 15
strict: true
---

# Build Test: .NET

**IMPORTANT: Keep all outputs concise. Report results clearly with pass/fail status.**

## Test Requirements

Clone and test the following projects from the test repository:

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-dotnet /tmp/test-dotnet`
   - **CRITICAL**: If clone fails, immediately call `safeoutputs-missing_tool` with message "CLONE_FAILED: Unable to clone test repository" and stop execution

2. **Test Projects**:
   - `hello-world`: `cd /tmp/test-dotnet/hello-world && dotnet restore && dotnet build && dotnet run`
   - `json-parse`: `cd /tmp/test-dotnet/json-parse && dotnet restore && dotnet build && dotnet run`

3. **For each project**, capture:
   - Restore success/failure (NuGet package download)
   - Build success/failure
   - Run output
   - Any error messages

## Output

Add a comment to the current pull request with a summary table:

| Project     | Restore | Build | Run   | Status    |
|-------------|---------|-------|-------|-----------|
| hello-world | ✅/❌   | ✅/❌ | ✅/❌ | PASS/FAIL |
| json-parse  | ✅/❌   | ✅/❌ | ✅/❌ | PASS/FAIL |

**Overall: PASS/FAIL**

If ALL tests pass, add the label `build-test-dotnet` to the pull request.
If ANY test fails, report the failure with error details.

## Error Handling

**CRITICAL**: This workflow MUST fail visibly when errors occur:

1. **Clone failure**: If repository clone fails, call `safeoutputs-missing_tool` with "CLONE_FAILED: [error message]"
2. **Build failure**: Report in comment table with ❌ and include error output
3. **Run failure**: Report in comment table with FAIL status and include failure details

DO NOT report success if any step fails. The workflow should produce a clear, actionable error message.