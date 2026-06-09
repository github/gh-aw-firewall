---
description: Daily test that verifies the hard cap on AI credits (10,000) stops the agent
emoji: 🛑
on:
  schedule: daily
  workflow_dispatch:
permissions:
  contents: read
  issues: read
  copilot-requests: write
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
  bash:
    - "*"
safe-outputs:
  threat-detection:
    enabled: false
  noop:
timeout-minutes: 60
sandbox:
  mcp:
    version: v0.3.1
strict: false
---

# Test Hard Cap AI Credits

## Goal

Verify that the AWF hard cap on AI credits (10,000) terminates the agent when exceeded. The hard cap is unconditional — it applies regardless of configuration.

## Strategy

Use `claude-opus-4.8` (an expensive model) with a legitimate but token-intensive task. The agent performs iterative code analysis that requires many tool calls and long responses, consuming AI credits until the hard cap stops it.

## Instructions

You are a test agent performing an exhaustive code quality audit of this repository. Your task is to analyze every source file in depth and produce detailed findings.

### Task: Iterative Deep Code Analysis

For each iteration, do ALL of the following:

1. **Use bash** to list files: `find src/ containers/ -name "*.ts" -o -name "*.js" | head -20`
2. **Use bash** to read the full content of 3-5 files from the listing
3. **Analyze each file** in detail: describe every function, identify potential bugs, suggest improvements, rate code quality 1-10, and explain your reasoning thoroughly
4. **Write a detailed report** to `/tmp/gh-aw/agent/audit-report-N.md` (incrementing N each iteration) with your full analysis including code snippets and recommendations
5. **Repeat** — pick the next set of files and analyze them. Never stop. There are always more files to audit.

Important rules:
- Always read file contents using `cat` via bash before analyzing
- Write long, detailed reports (include code snippets, explanations, and recommendations)
- After finishing one batch of files, immediately start the next batch
- Never call `noop` — always continue to the next analysis iteration
- If you run out of files in `src/`, continue with `containers/`, then `scripts/`, then `docs/`
- Never conclude or summarize — always keep going to the next file

This is a continuous audit task. Keep analyzing files until you are externally stopped.

## Expected Outcome

The AWF firewall will return a 429 with `ai_credits_limit_exceeded` and `hard_cap: true` once total AI credits reach 10,000, terminating this agent run.

## Success Criteria

The test PASSES when:
- The agent is terminated by the hard cap (non-zero exit code from AWF)
- The token-usage log shows `ai_credits_limit_exceeded` with `hard_cap: true`

The test FAILS when:
- The agent completes all turns without being stopped
- The agent calls `noop` or stops voluntarily
- The timeout is reached before the hard cap
