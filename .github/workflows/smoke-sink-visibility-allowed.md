---
name: Smoke Sink Visibility Allowed
description: >-
  Smoke test verifying that private-to-public-flows: allow correctly disables
  MCP Gateway sink-visibility enforcement, permitting cross-repo reads from a
  private repository (github/agentic-workflows). Tests both gh CLI (mcpg proxy
  mode) and GitHub MCP tools (mcpg gateway mode).
on:
  workflow_dispatch:
permissions:
  contents: read
engine:
  id: copilot
  version: 1.0.34
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - "*"
  github:
    github-token: ${{ secrets.GH_AW_CROSS_REPO_PAT }}
    toolsets: [repos]
    private-to-public-flows: allow
safe-outputs:
  threat-detection:
    enabled: false
strict: false
max-turns: 10
timeout-minutes: 10
---

# Smoke Test: Sink Visibility — Allowed (private-to-public-flows: allow)

This test verifies that `private-to-public-flows: allow` correctly disables
MCP Gateway sink-visibility enforcement, permitting reads from a private
repository.

Target private repo: `github/agentic-workflows`

**IMPORTANT: All access to github/agentic-workflows must be READ-ONLY.
Never create, update, or delete anything in that repository.**

## Test 1 — gh CLI (mcpg proxy mode)

Run the following bash command and capture the exit code and output:

```bash
gh repo view github/agentic-workflows --json name 2>&1; echo "EXIT_CODE=$?"
```

**Expected**: The command should SUCCEED (exit code 0, returning the repo name).

## Test 2 — GitHub MCP tools (mcpg gateway mode)

Call the MCP tool `get_file_contents` to read the root path (`/`) of
`github/agentic-workflows`:
- owner: `github`
- repo: `agentic-workflows`
- path: `/`

**Expected**: The MCP call should SUCCEED, returning a directory listing.

## Report

Summarize the results:

| Test | Method | Expected | Actual | Status |
|------|--------|----------|--------|--------|
| 1 | gh CLI (proxy mode) | ALLOWED | ... | ✅/❌ |
| 2 | MCP tools (gateway mode) | ALLOWED | ... | ✅/❌ |

- ✅ = access was correctly allowed (test passed)
- ❌ = access was unexpectedly blocked (test failed — opt-out not working)

Call `noop` with the summary table and overall PASS/FAIL status.
