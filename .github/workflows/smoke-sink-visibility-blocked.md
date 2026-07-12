---
name: Smoke Sink Visibility Blocked
description: >-
  Smoke test verifying that MCP Gateway sink-visibility enforcement blocks
  cross-repo reads from a private repository (github/agentic-workflows) when
  private-to-public-flows is NOT opted out. Tests both gh CLI (mcpg proxy mode)
  and GitHub MCP tools (mcpg gateway mode).
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
    # NOTE: private-to-public-flows is intentionally NOT set here.
    # The MCP Gateway should enforce forcePublicRepos=true, blocking
    # access to the private repo github/agentic-workflows.
safe-outputs:
  threat-detection:
    enabled: false
strict: false
max-turns: 10
timeout-minutes: 10
---

# Smoke Test: Sink Visibility — Blocked (Default Enforcement)

This test verifies that the MCP Gateway **blocks** reads from a private
repository when `private-to-public-flows` is not opted out.

Target private repo: `github/agentic-workflows`

**IMPORTANT: All access to github/agentic-workflows must be READ-ONLY.
Never create, update, or delete anything in that repository.**

## Test 1 — gh CLI (mcpg proxy mode)

Run the following bash command and capture the exit code and output:

```bash
gh repo view github/agentic-workflows --json name 2>&1; echo "EXIT_CODE=$?"
```

**Expected**: The command should FAIL (non-zero exit code or error message
indicating the repo is inaccessible / not found).

## Test 2 — GitHub MCP tools (mcpg gateway mode)

Call the MCP tool `get_file_contents` to read the root path (`/`) of
`github/agentic-workflows`:
- owner: `github`
- repo: `agentic-workflows`
- path: `/`

**Expected**: The MCP call should FAIL with an error (repository not found,
access denied, or similar).

## Report

Summarize the results:

| Test | Method | Expected | Actual | Status |
|------|--------|----------|--------|--------|
| 1 | gh CLI (proxy mode) | BLOCKED | ... | ✅/❌ |
| 2 | MCP tools (gateway mode) | BLOCKED | ... | ✅/❌ |

- ✅ = access was correctly blocked (test passed)
- ❌ = access was unexpectedly allowed (test failed — sink visibility not enforced)

Call `noop` with the summary table and overall PASS/FAIL status.
