---
description: Build Test Rust
on:
  roles: all
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read
  issues: read
name: Build Test Rust
engine: copilot
runtimes:
  rust:
    version: "stable"
network:
  allowed:
    - defaults
    - github
    - rust
    - crates.io
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
    allowed: [build-test-rust]
  messages:
    run-failure: "**Build Test Failed** [{workflow_name}]({run_url}) - See logs for details"
timeout-minutes: 30
strict: true
---

# Build Test: Rust

**IMPORTANT: Keep all outputs concise. Report results clearly with pass/fail status.**

## Test Requirements

Clone and test the following projects from the test repository:

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-rust /tmp/test-rust`
   - **CRITICAL**: If clone fails, immediately call `safeoutputs-missing_tool` with message "CLONE_FAILED: Unable to clone test repository" and stop execution

2. **Test Projects**:
   - `fd`: `cd /tmp/test-rust/fd && cargo build && cargo test`
   - `zoxide`: `cd /tmp/test-rust/zoxide && cargo build && cargo test`

3. **For each project**, capture:
   - Build success/failure
   - Test pass/fail count
   - Any error messages

## Output

Add a comment to the current pull request with a summary table:

| Project | Build | Tests | Status |
|---------|-------|-------|--------|
| fd      | ✅/❌  | X/Y   | PASS/FAIL |
| zoxide  | ✅/❌  | X/Y   | PASS/FAIL |

**Overall: PASS/FAIL**

If ALL tests pass, add the label `build-test-rust` to the pull request.
If ANY test fails, report the failure with error details.

## Error Handling

**CRITICAL**: This workflow MUST fail visibly when errors occur:

1. **Clone failure**: If repository clone fails, call `safeoutputs-missing_tool` with "CLONE_FAILED: [error message]"
2. **Build failure**: Report in comment table with ❌ and include error output
3. **Test failure**: Report in comment table with FAIL status and include failure details

DO NOT report success if any step fails. The workflow should produce a clear, actionable error message.