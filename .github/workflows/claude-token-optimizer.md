---
description: Daily Claude token optimization advisor — reads the latest token usage report and creates actionable recommendations to reduce token consumption for the most expensive workflow
on:
  workflow_run:
    workflows: ["Daily Claude Token Usage Analyzer"]
    types: [completed]
    branches: [main]
  workflow_dispatch:
  skip-if-match:
    query: 'is:issue is:open label:claude-token-optimization'
    max: 1
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
imports:
  - uses: shared/mcp/gh-aw.md
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
    title-prefix: "\u26a1 Claude Token Optimization"
    labels: [claude-token-optimization]
    close-older-issues: true
timeout-minutes: 25
strict: true
steps:
  - name: Download recent Claude workflow logs
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/token-audit

      echo "\U0001F4E5 Downloading Claude workflow logs (last 7 days)..."

      LOGS_EXIT=0
      gh aw logs \
        --engine claude \
        --start-date -7d \
        --json \
        -c 50 \
        > /tmp/gh-aw/token-audit/claude-logs.json || LOGS_EXIT=$?

      if [ -s /tmp/gh-aw/token-audit/claude-logs.json ]; then
        TOTAL=$(jq '.runs | length' /tmp/gh-aw/token-audit/claude-logs.json)
        echo "\u2705 Downloaded $TOTAL Claude workflow runs (last 7 days)"
        if [ "$LOGS_EXIT" -ne 0 ]; then
          echo "\u26a0\ufe0f gh aw logs exited with code $LOGS_EXIT (partial results)"
        fi
      else
        echo "\u274c No log data downloaded (exit code $LOGS_EXIT)"
        echo '{"runs":[],"summary":{}}' > /tmp/gh-aw/token-audit/claude-logs.json
      fi
---

# Daily Claude Token Optimization Advisor

You are an AI agent that reads the latest Claude token usage report and produces **concrete, actionable optimization recommendations** for the most token-intensive Claude-engine workflow.

**IMPORTANT:** Stay focused on the task. Follow these steps in order. Do not read or explore unrelated workflow files. You may use: (1) the pre-downloaded run data at `/tmp/gh-aw/token-audit/`, (2) the token usage report issue fetched via the `gh issue` commands below, and (3) the single target workflow `.md` file identified in Step 3.

## Step 1: Find the Latest Token Usage Report

Search for the most recent Claude token usage report issue:

```bash
gh issue list --repo "$GITHUB_REPOSITORY" \
  --label claude-token-usage-report \
  --state all --limit 1 \
  --json number,title,body,createdAt,url
```

If no report exists, do **not** create an issue. Simply log a message noting that no token usage report was found and that the `claude-token-usage-analyzer` workflow should run first. Then stop without calling any safe-output tools.

Read the full issue body to extract per-workflow statistics.

## Step 2: Identify the Most Token-Intensive Workflow

From the report's **Workflow Summary** table, identify the workflow with:
1. Highest estimated cost (primary sort)
2. Highest total token count (tiebreaker)

Extract these key metrics for the target workflow:
- Total tokens per run
- Cache hit rate (read and write separately \u2014 Anthropic exposes both)
- Cache write rate
- Input/output ratio
- Number of LLM turns (request count)
- Model(s) used
- Estimated cost per run

## Step 3: Analyze the Workflow Definition

Resolve the workflow file name from the display name in the report. The report table uses display names (e.g., "Smoke Claude") but the files use kebab-case (e.g., `smoke-claude.md`). Map the name by searching for a matching `name:` field:

```bash
# Find workflow file by display name
DISPLAY_NAME="Smoke Claude"  # from report
WORKFLOW_FILE=$(grep -rl "^name: ${DISPLAY_NAME}$" .github/workflows/*.md 2>/dev/null | head -1)
# Fallback: try kebab-case conversion
if [ -z "$WORKFLOW_FILE" ]; then
  KEBAB=$(echo "$DISPLAY_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  WORKFLOW_FILE=".github/workflows/${KEBAB}.md"
fi
cat "$WORKFLOW_FILE"
```

Analyze:
- **Tools loaded** \u2014 List all tools in the `tools:` section. Flag any that may not be needed.
- **Network groups** \u2014 List network groups in `network.allowed:`. Flag unused ones.
- **Prompt length** \u2014 Estimate the markdown body size. Is it verbose?
- **Pre-agent steps** \u2014 Does it use `steps:` to pre-compute deterministic work?

Read **only** the target workflow file. Do not open or read other workflow files (the `grep` above may scan filenames to resolve the correct file, but do not read their contents).

## Step 4: Analyze Recent Run Data

The pre-agent step downloaded the last 7 days of Claude workflow logs to `/tmp/gh-aw/token-audit/claude-logs.json`. Filter for the target workflow:

```bash
cat /tmp/gh-aw/token-audit/claude-logs.json | \
  jq --arg name "$WORKFLOW_NAME" '[.runs[] | select(.workflow_name == $name)]'
```

Determine per-run token breakdown, average turns, error patterns, cache write vs read ratio, and which tools are actually used vs loaded (`tool_usage` and `mcp_tool_usage` fields).

## Step 5: Generate Optimization Recommendations

Produce **specific, implementable recommendations** based on these patterns:

### Tool Surface Reduction
If many tools are loaded but few are used:
- List which tools to remove from `tools:` in the workflow `.md`
- Estimate token savings (each tool schema is ~500-700 tokens)
- Example: "Remove `agentic-workflows:`, `web-fetch:` \u2014 saves ~15K tokens/turn"

### Pre-Agent Steps
If the workflow does deterministic work (API calls, file creation, data fetching) inside the agent:
- Identify which operations could move to `steps:` (pre-agent)
- Show example `steps:` configuration

### Prompt Optimization
If the prompt is verbose or contains data the agent doesn't need:
- Suggest specific cuts or rewrites

### GitHub Toolset Restriction
If `github:` tools are loaded without `toolsets:` restriction:
- Suggest `toolsets: [repos, pull_requests]` or similar based on actual usage
- Default loads ~22 tools; restricting to used toolsets saves ~10K tokens

### Network Group Trimming
If unused network groups are configured (e.g., `node`, `playwright`):
- List which to remove

### Cache Write Optimization (Anthropic-Specific)
Anthropic charges significantly more for cache writes than reads:
- Cache write: $3.75/M tokens (Sonnet), cache read: $0.30/M tokens
- If cache writes are high but not reused across turns, the caching cost may exceed the benefit
- Check if prompts change substantially between turns

### Cache Read Optimization
If cache hit rate is low (<50%):
- Check if prompts vary between runs (run-specific IDs, timestamps)
- Suggest moving variable content to the end of prompts (prefix caching)
- Note: Anthropic cache TTL is ~5 minutes for automatic caching

## Step 6: Create the Optimization Issue

Create an issue with title: `YYYY-MM-DD \u2014 <workflow-name>`

Body structure:

```markdown
## Target Workflow: `<workflow-name>`

**Source report:** #<report-number>
**Estimated cost per run:** $X.XX
**Total tokens per run:** ~NK
**Cache read rate:** X%
**Cache write rate:** X%
**LLM turns:** N

## Current Configuration

| Setting | Value |
|---------|-------|
| Tools loaded | N (list) |
| Tools actually used | N (list) |
| Network groups | list |
| Pre-agent steps | Yes/No |
| Prompt size | N chars |

## Recommendations

### 1. [Highest impact recommendation]

**Estimated savings:** ~NK tokens/run (~X%)

[Specific implementation details with code snippets]

### 2. [Second recommendation]

**Estimated savings:** ~NK tokens/run (~X%)

[Specific implementation details]

### 3. [Third recommendation]

...

## Cache Analysis (Anthropic-Specific)

| Turn | Input | Output | Cache Read | Cache Write | Net New |
|------|------:|-------:|-----------:|------------:|--------:|
| 1 | NK | NK | NK | NK | NK |
| 2 | NK | NK | NK | NK | NK |
| ... | | | | | |

**Cache write amortization:** Are Turn 1 cache writes reused in Turn 2+?
**Cache cost vs benefit:** Is the write cost justified by read savings?

## Expected Impact

| Metric | Current | Projected | Savings |
|--------|---------|-----------|---------|
| Total tokens/run | NK | NK | -X% |
| Cost/run | $X.XX | $X.XX | -X% |
| LLM turns | N | N | -N |
| Session time | Xs | Xs (est.) | -X% |

## Implementation Checklist

- [ ] [First change to make]
- [ ] [Second change to make]
- [ ] Recompile: `gh aw compile .github/workflows/<name>.md`
- [ ] Post-process: `npx tsx scripts/ci/postprocess-smoke-workflows.ts`
- [ ] Verify CI passes on PR
- [ ] Compare token usage on new run vs baseline
```

## Important Guidelines

- **Be concrete** \u2014 Every recommendation must include specific file changes, not just "reduce tools"
- **Estimate savings** \u2014 Quantify each recommendation in tokens and percentage
- **Prioritize by impact** \u2014 Order recommendations from highest to lowest token savings
- **Include implementation steps** \u2014 Someone should be able to follow your recommendations without additional research
- **Reference the report** \u2014 Link back to the source token usage report issue
- **One workflow per issue** \u2014 Focus on the single most expensive workflow
- **Anthropic-specific insights** \u2014 Leverage cache write data that Copilot workflows don't expose
- **Use pre-downloaded data** \u2014 All run data is at `/tmp/gh-aw/token-audit/claude-logs.json`. Do not download artifacts manually.
