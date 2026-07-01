---
description: Daily test that verifies the hard cap on AI credits (10,000) stops the agent
emoji: 🛑
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
  actions: read
  pull-requests: read
  copilot-requests: write
tracker-id: test-hard-cap-ai-credits
name: Test Hard Cap AI Credits
engine:
  id: copilot
  model: claude-opus-4.8
max-turns: 200
network:
  allowed:
    - defaults
    - github
tools:
  bash: true
  github:
    toolsets: [pull_requests, issues, search]
safe-outputs:
  threat-detection:
    enabled: false
  noop:
    max: 1
timeout-minutes: 60
sandbox:
  mcp:
    version: v0.3.32
strict: false
steps:
  - name: Prepare analysis workspace
    run: |
      mkdir -p /tmp/gh-aw/agent/hard-cap-test
      echo "Hard cap test started at $(date)" > /tmp/gh-aw/agent/hard-cap-test/start.txt
---

# Test Hard Cap AI Credits

You are a comprehensive repository analysis agent for `${{ github.repository }}`. Your task is to perform an exhaustive multi-phase analysis of this codebase and produce detailed findings.

## Important

- This is a **long-running continuous analysis task**. You must keep working through ALL phases below.
- Do NOT call `noop` until you have completed ALL phases. There is always more analysis to do.
- If you find yourself wanting to stop, move to the next phase instead.
- You will eventually be terminated by the system — that is expected and correct behavior.

## Phase 1: Repository Structure Analysis

Use bash to explore the repository structure:

```bash
find . -type f \( -name "*.ts" -o -name "*.js" \) | wc -l
find src/ -type f -name "*.ts" | sort
find containers/ -type f -name "*.js" | sort
```

Read and analyze the top-level configuration files:
- `package.json`
- `tsconfig.json`
- `jest.config.js`

Produce a detailed structural overview in `/tmp/gh-aw/agent/hard-cap-test/phase1-structure.md`.

## Phase 2: Source Code Deep Dive

For EACH file in `src/`, read its full contents using `cat` and produce a detailed analysis:

- List every exported function and class with their signatures
- Describe the purpose and logic flow of each function
- Identify error handling patterns
- Note any potential performance issues
- Rate complexity on a 1-10 scale with justification

Write your analysis to `/tmp/gh-aw/agent/hard-cap-test/phase2-src-analysis.md`.

After `src/`, continue with `containers/api-proxy/` — analyze every `.js` file the same way.

## Phase 3: Test Coverage Analysis

Read and analyze all test files:

```bash
find . -name "*.test.ts" -o -name "*.test.js" | sort
```

For each test file:
- Count test cases
- Identify what functions are being tested
- Note any gaps in coverage
- Assess test quality

Write findings to `/tmp/gh-aw/agent/hard-cap-test/phase3-tests.md`.

## Phase 4: Cross-Cutting Concerns

Use GitHub search to find patterns across the codebase:

- Search for error handling patterns
- Search for logging patterns
- Search for security-sensitive code (crypto, auth, tokens)
- Search for Docker/container configuration patterns

Write findings to `/tmp/gh-aw/agent/hard-cap-test/phase4-patterns.md`.

## Phase 5: Dependency Analysis

Analyze all dependency files:
- `package.json` dependencies and their purposes
- `containers/api-proxy/package.json`
- Dockerfile dependency layers

Write findings to `/tmp/gh-aw/agent/hard-cap-test/phase5-deps.md`.

## Phase 6: Keep Going

If you reach this phase, go back to Phase 2 and analyze any files you missed. There are always more files. Read them, analyze them in detail, write reports.

## Expected Behavior

The AWF firewall enforces a hard cap on AI credits (10,000). This analysis task is designed to consume credits through legitimate work until the hard cap terminates the agent. This is the expected and correct outcome.
