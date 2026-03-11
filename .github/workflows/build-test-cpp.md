---
description: Build Test C++
on:
  roles: all
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read
  issues: read
name: Build Test C++
engine: copilot
network:
  allowed:
    - defaults
    - github
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
    allowed: [build-test-cpp]
  messages:
    run-failure: "**Build Test Failed** [{workflow_name}]({run_url}) - See logs for details"
timeout-minutes: 30
strict: true
---

# Build Test: C++

**IMPORTANT: Keep all outputs concise. Report results clearly with pass/fail status.**

## Test Requirements

Clone and test the following projects from the test repository:

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-cpp /tmp/test-cpp`
   - **CRITICAL**: If clone fails, immediately call `safeoutputs-missing_tool` with message "CLONE_FAILED: Unable to clone test repository" and stop execution

2. **Test Projects**:
   - `fmt`:
     ```bash
     cd /tmp/test-cpp/fmt
     mkdir -p build && cd build
     cmake ..
     make
     ```
   - `json`:
     ```bash
     cd /tmp/test-cpp/json
     mkdir -p build && cd build
     cmake ..
     make
     ```

3. **For each project**, capture:
   - CMake configuration success/failure
   - Build success/failure
   - Any error messages

## Output

Add a comment to the current pull request with a summary table:

| Project | CMake | Build | Status |
|---------|-------|-------|--------|
| fmt     | ✅/❌  | ✅/❌  | PASS/FAIL |
| json    | ✅/❌  | ✅/❌  | PASS/FAIL |

**Overall: PASS/FAIL**

If ALL builds pass, add the label `build-test-cpp` to the pull request.
If ANY build fails, report the failure with error details.

## Error Handling

**CRITICAL**: This workflow MUST fail visibly when errors occur:

1. **Clone failure**: If repository clone fails, call `safeoutputs-missing_tool` with "CLONE_FAILED: [error message]"
2. **CMake failure**: Report in comment table with ❌ and include error output
3. **Build failure**: Report in comment table with ❌ and include failure details

DO NOT report success if any step fails. The workflow should produce a clear, actionable error message.