---
description: Daily Claude token usage analysis across agentic workflow runs — identifies trends, inefficiencies, and optimization opportunities
on:
  schedule: daily
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
features:
  byok-copilot: true
imports:
  - uses: shared/mcp/gh-aw.md
  - shared/mcp-pagination.md
  - shared/reporting.md
network:
  allowed:
    - github
tools:
  github:
    toolsets: [default, actions]
  bash: true
safe-outputs:
  threat-detection:
    enabled: false
  create-issue:
    title-prefix: "\U0001F4CA Claude Token Usage Report"
    labels: [claude-token-usage-report]
    close-older-issues: true
timeout-minutes: 45
steps:
  - name: Download Claude workflow logs
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/token-audit

      echo "\U0001F4E5 Downloading Claude workflow logs (last 24 hours)..."

      LOGS_EXIT=0
      gh aw logs \
        --engine claude \
        --start-date -1d \
        --json \
        -c 50 \
        > /tmp/gh-aw/token-audit/claude-logs.json || LOGS_EXIT=$?

      if [ -s /tmp/gh-aw/token-audit/claude-logs.json ]; then
        TOTAL=$(jq '.runs | length' /tmp/gh-aw/token-audit/claude-logs.json)
        echo "\u2705 Downloaded $TOTAL Claude workflow runs (last 24 hours)"
        if [ "$LOGS_EXIT" -ne 0 ]; then
          echo "\u26a0\ufe0f gh aw logs exited with code $LOGS_EXIT (partial results \u2014 likely API rate limit)"
        fi
      else
        echo "\u274c No log data downloaded (exit code $LOGS_EXIT)"
        echo '{"runs":[],"summary":{}}' > /tmp/gh-aw/token-audit/claude-logs.json
      fi
---

# Daily Claude Token Usage Analyzer

You are an AI agent that analyzes Claude token usage across agentic workflow runs in this repository. Your goal is to identify trends, highlight inefficiencies, and recommend optimizations to reduce AI inference costs for Claude-engine workflows.

## Background

This repository uses the **Agent Workflow Firewall (AWF)** with an api-proxy sidecar that tracks token usage for LLM API calls. The pre-agent step has already downloaded structured run data using `gh aw logs --json`, which includes per-run token usage, cost estimates, and run metadata.

**Note:** Copilot-engine and Codex-engine workflows are excluded \u2014 they are covered by the separate Copilot Token Usage Analyzer.

## Data Sources

### Pre-downloaded logs

The file `/tmp/gh-aw/token-audit/claude-logs.json` contains structured JSON output from `gh aw logs --engine claude --json` with this shape:

```json
{
  "summary": {
    "run_count": N,
    "total_tokens": N,
    "avg_tokens": N,
    "total_cost": F,
    "avg_cost": F,
    "total_turns": N,
    "avg_turns": F,
    "total_action_minutes": F,
    "error_count": N,
    "warning_count": N
  },
  "runs": [ ... ],
  "tool_usage": [ ... ],
  "mcp_tool_usage": { ... }
}
```

Each element of `.runs` includes:

| Field | Type | Notes |
|---|---|---|
| `workflow_name` | string | Human-readable name |
| `workflow_path` | string | `.github/workflows/....lock.yml` |
| `token_usage` | int | Total tokens (treat missing/null as 0) |
| `effective_tokens` | int | Cost-normalized tokens |
| `estimated_cost` | float | USD cost (treat missing/null as 0) |
| `action_minutes` | float | Billable GitHub Actions minutes |
| `turns` | int | Number of agent turns |
| `duration` | string | Human-readable duration |
| `created_at` | ISO 8601 | Run creation time |
| `database_id` | int64 | Unique run ID |
| `url` | string | Link to the run |
| `status` | string | `completed`, `in_progress`, etc. |
| `conclusion` | string | `success`, `failure`, etc. |
| `error_count` | int | Errors encountered |
| `warning_count` | int | Warnings encountered |
| `token_usage_summary` | object or null | Firewall-level breakdown by model (includes Anthropic cache read/write tokens) |

## Your Mission

### Step 1: Load and Parse Pre-Downloaded Data

Read the pre-downloaded logs:

```bash
cat /tmp/gh-aw/token-audit/claude-logs.json | jq '.summary'
cat /tmp/gh-aw/token-audit/claude-logs.json | jq '.runs | length'
```

If `.runs` is empty, create a minimal report noting that no Claude workflow runs were found in the last 24 hours.

### Step 2: Compute Per-Workflow Statistics

Group `.runs` by `workflow_name` and compute per-workflow aggregates:

1. **Run count**: Number of runs per workflow
2. **Total tokens**: Sum of `token_usage` across runs
3. **Avg tokens/run**: Mean `token_usage`
4. **Total cost**: Sum of `estimated_cost`
5. **Avg cost/run**: Mean `estimated_cost`
6. **Total turns**: Sum of `turns`
7. **Error/warning counts**: Sum of `error_count`, `warning_count`
8. **Model & cache breakdown**: Extract from `token_usage_summary` where available (Anthropic provides cache_read_tokens and cache_write_tokens)

Use bash with jq or a Python script to process efficiently. Handle null/missing `token_usage` and `estimated_cost` by treating them as 0.

### Step 3: Identify Optimization Opportunities

Flag workflows with these patterns:

| Pattern | Threshold | Recommendation |
|---------|-----------|----------------|
| High total cost | >$1.00 per run | Review if workflow is doing too much |
| High token count | >100K tokens/run | Reduce system prompt or MCP tool surface |
| Many turns | >15 turns/run | Consider pre-computing deterministic work in steps |
| High cache write vs read | cache_write > cache_read in token_usage_summary | Cache is being written but not reused \u2014 check if conversation turns are too short |
| High error rate | >30% of runs with errors | Investigate reliability issues |
| Increasing trend | >20% increase vs last report | Investigate what changed |

### Step 4: Check for Historical Trends

Search for previous token usage report issues:
```bash
gh issue list --repo "$GITHUB_REPOSITORY" --label claude-token-usage-report --state all --limit 5 --json number,title,createdAt,url
```

If previous reports exist, compare current metrics to identify:
- Workflows with increasing token consumption
- Workflows that gained or lost prompt caching
- New workflows that appeared
- Cost trend over time

### Step 5: Create the Summary Issue

Create an issue with the following structure:

#### Title: `YYYY-MM-DD` (safe-outputs will automatically prefix this with "\U0001F4CA Claude Token Usage Report")

#### Body structure:

```markdown
### Overview

**Period**: [start date] to [end date]
**Runs analyzed**: X (Y had token data)
**Total tokens**: N across all workflows
**Estimated total cost**: $X.XX
**Total Actions minutes**: X.X min

### Workflow Summary

| Workflow | Runs | Total Tokens | Avg Tokens | Cost | Avg Cost | Turns |
|----------|------|-------------|------------|------|----------|-------|
| smoke-claude | 2 | 395K | 197K | $0.46 | $0.23 | 12 |
| security-review | 1 | 120K | 120K | $0.22 | $0.22 | 5 |
| ... | | | | | | |

### \U0001F50D Optimization Opportunities

1. **security-review** \u2014 $0.22/run, high cache writes
   - Cache is being created but not fully reused across turns
   - Consider restructuring the prompt to maximize cache prefix reuse

2. ...

<details>
<summary><b>Per-Workflow Details</b></summary>

#### smoke-claude
- **Runs**: 2 (links to each run)
- **Total tokens**: 395K (avg 197K/run)
- **Estimated cost**: $0.46 (avg $0.23/run)
- **Turns**: 12 total (avg 6/run)
- **Model breakdown**: [from token_usage_summary if available]
- **Cache analysis**: [cache read/write breakdown if available]
- **Error rate**: 0/2 runs

</details>

<details>
<summary><b>Workflows Without Token Data</b></summary>

Runs where `token_usage` was null or 0 \u2014 these may not have the api-proxy enabled:
- [list workflows with missing data]

</details>

### Historical Trend

[If previous reports exist, show comparison. Otherwise: "This is the first Claude token usage report."]

### Previous Report
[Link to previous report issue if one exists]
```

## Important Guidelines

- **Do NOT fail** if no token data is available. Create a minimal report explaining which workflows need instrumentation.
- **All data is pre-downloaded** \u2014 do not attempt to download artifacts or run `gh run download`. Use only the JSON at `/tmp/gh-aw/token-audit/claude-logs.json`.
- **Anthropic-specific insights** \u2014 Leverage cache write/read data from `token_usage_summary` when available. Anthropic charges 12.5x more for cache writes than reads.
- **Wrap verbose output** in `<details>` blocks for progressive disclosure.
- **Round costs** to 2 decimal places, token counts to nearest thousand for readability.
- **Sort workflows** by estimated cost (highest first) in the summary table.
