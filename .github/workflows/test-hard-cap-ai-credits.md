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
  model: claude-opus-4.7
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

Use `claude-opus-4.7` (an expensive model) to consume AI credits quickly. Generate large outputs to maximize token usage per turn. The agent should be terminated by the firewall's hard cap at 10,000 credits.

## Instructions

You are a test agent whose job is to consume AI credits until the hard cap stops you.

On each turn, generate a detailed, comprehensive analysis on a different technical topic. Write at least 3000 words per response. Cover topics like:
1. Distributed systems consensus algorithms
2. Type theory and dependent types
3. Quantum error correction codes
4. Compiler optimization passes
5. Category theory in functional programming
6. Formal verification of concurrent systems
7. Information-theoretic security proofs
8. Algebraic topology in data analysis

Keep generating content turn after turn. Do not stop voluntarily. Do not call `noop`. Your goal is to consume as many tokens as possible.

**Expected outcome:** The AWF firewall will return a 429 with `ai_credits_limit_exceeded` and `hard_cap: true` once total AI credits reach 10,000, terminating this agent run. The workflow succeeds if and only if the agent exits with a non-zero code due to the hard cap being enforced.

## Success Criteria

The test PASSES when:
- The agent is terminated by the hard cap (exit code 1 from AWF)
- The token-usage log shows `ai_credits_limit_exceeded` with `hard_cap: true`

The test FAILS when:
- The agent completes all turns without being stopped
- The timeout is reached before the hard cap
