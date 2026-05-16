---
description: Daily Claude token optimization advisor — reads the latest token usage report and creates actionable recommendations to reduce token consumption for the most expensive workflow
on:
  workflow_run:
    workflows: ["Daily Claude Token Usage Analyzer"]
    types: [completed]
    branches: [main]
  workflow_dispatch:
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
    toolsets: [issues]
  bash: true
safe-outputs:
  threat-detection:
    enabled: false
  create-issue:
    title-prefix: "\u26a1 Claude Token Optimization"
    labels: [claude-token-optimization]
    close-older-issues: true
timeout-minutes: 15
sandbox:
  agent:
    id: awf
    version: v0.25.29
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
  - name: List workflows already covered by open optimization issues
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    run: |
      set -euo pipefail

      echo "🔍 Checking for open optimization issues..."

      # Fetch open optimization issues and extract workflow names from titles
      # Title format: "⚡ Claude Token Optimization YYYY-MM-DD — <workflow-name>"
      if ! gh issue list --repo "$GITHUB_REPOSITORY" \
        --label claude-token-optimization \
        --state open --limit 50 \
        --json title -q '.[].title' \
      | sed -n 's/.*— //p' \
      | sort -u > /tmp/gh-aw/token-audit/already-optimized.txt; then
        echo "⚠️ Failed to list open optimization issues; proceeding with an empty exclusion list"
        : > /tmp/gh-aw/token-audit/already-optimized.txt
      fi

      COUNT=$(wc -l < /tmp/gh-aw/token-audit/already-optimized.txt | tr -d ' ')
      if [ "$COUNT" -gt 0 ]; then
        echo "⏭️ $COUNT workflow(s) already have open optimization issues:"
        cat /tmp/gh-aw/token-audit/already-optimized.txt
      else
        echo "✅ No open optimization issues — all workflows are eligible"
      fi
  - name: Identify top workflow and stage its file
    run: |
      set -euo pipefail

      echo "📊 Selecting the top Claude workflow candidate..."

      EXCLUDED_JSON=$(jq -R -s 'split("\n") | map(select(length > 0))' /tmp/gh-aw/token-audit/already-optimized.txt 2>/dev/null || echo '[]')

      TOP_WORKFLOW=$(jq -r --argjson excluded "$EXCLUDED_JSON" '
        [.runs[] | select(.token_usage != null and (.workflow_name // "") != "") | {workflow_name, token_usage}]
        | sort_by(.workflow_name)
        | group_by(.workflow_name)
        | map({
            name: .[0].workflow_name,
            average_token_usage: (map(.token_usage) | add / length)
          })
        | map(select(.name as $name | ($excluded | index($name)) == null))
        | sort_by(.average_token_usage)
        | reverse
        | .[0].name // ""
      ' /tmp/gh-aw/token-audit/claude-logs.json)

      echo "TOP_WORKFLOW=${TOP_WORKFLOW}" >> "$GITHUB_ENV"

      if [ -z "$TOP_WORKFLOW" ]; then
        echo "ℹ️ No eligible Claude workflow found in the downloaded run data"
        echo "WORKFLOW_FILE=" >> "$GITHUB_ENV"
        echo "TARGET_NOT_FOUND=1" >> "$GITHUB_ENV"
        touch /tmp/gh-aw/token-audit/target-workflow.md
        exit 0
      fi

      KEBAB=$(printf '%s' "$TOP_WORKFLOW" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')
      FILE=$(grep -Flx -- "name: ${TOP_WORKFLOW}" .github/workflows/*.md 2>/dev/null | head -1 || true)
      [ -z "$FILE" ] && FILE=".github/workflows/${KEBAB}.md"

      echo "WORKFLOW_FILE=${FILE}" >> "$GITHUB_ENV"

      if [ -f "$FILE" ]; then
        cp "$FILE" /tmp/gh-aw/token-audit/target-workflow.md
        echo "✅ Top workflow: ${TOP_WORKFLOW} → ${FILE}"
      else
        echo "⚠️ Unable to locate workflow file for ${TOP_WORKFLOW}"
        echo "TARGET_NOT_FOUND=1" >> "$GITHUB_ENV"
        touch /tmp/gh-aw/token-audit/target-workflow.md
      fi
---

# Daily Claude Token Optimization Advisor

You are an AI agent that reads the latest Claude token usage report and produces **concrete, actionable optimization recommendations** for the most token-intensive Claude-engine workflow.

**IMPORTANT:** Stay focused on the task. Follow these steps in order. Do not read or explore unrelated workflow files. You may use: (1) the pre-downloaded run data at `/tmp/gh-aw/token-audit/`, (2) the latest token usage report issue if one exists, and (3) the staged target workflow file at `/tmp/gh-aw/token-audit/target-workflow.md`.

The pre-agent step already selected the top workflow candidate as `$TOP_WORKFLOW` and resolved its source path as `$WORKFLOW_FILE`. Read `/tmp/gh-aw/token-audit/target-workflow.md` directly. Do **not** search `.github/workflows` for the workflow file again.

If `$TOP_WORKFLOW` is empty or `$TARGET_NOT_FOUND` is `1`, log that no eligible workflow file could be staged, exit immediately, and do not call any safe-output tools.

## Step 1: Find the Latest Token Usage Report

Use `gh issue list --repo "$GITHUB_REPOSITORY" --label claude-token-usage-report --state all --limit 1 --json number,title,body,createdAt,url` to fetch the most recent Claude token usage report issue.

If no report exists, do **not** create an issue. Simply log a message noting that no token usage report was found and that the `claude-token-usage-analyzer` workflow should run first. Then stop without calling any safe-output tools.

Read the full issue body to extract per-workflow statistics.

## Step 2: Identify the Most Token-Intensive Workflow

A pre-agent step already read `/tmp/gh-aw/token-audit/already-optimized.txt`, ranked workflows from `/tmp/gh-aw/token-audit/claude-logs.json`, skipped any workflow that already has an open optimization issue, and selected `$TOP_WORKFLOW`.

Use the report body to confirm the selected workflow's metrics. If the report does not contain `$TOP_WORKFLOW`, log that mismatch and fall back to the pre-downloaded run data rather than selecting a different workflow.

Extract these key metrics for the target workflow:
- Total tokens per run
- Cache hit rate (read and write separately \u2014 Anthropic exposes both)
- Cache write rate
- Input/output ratio
- Number of LLM turns (request count)
- Model(s) used
- Estimated cost per run

## Step 3: Analyze the Workflow Definition

Read `/tmp/gh-aw/token-audit/target-workflow.md` directly. Its source path is `$WORKFLOW_FILE`.

Analyze:
- **Tools loaded** \u2014 List all tools in the `tools:` section. Flag any that may not be needed.
- **Network groups** \u2014 List network groups in `network.allowed:`. Flag unused ones.
- **Prompt length** \u2014 Estimate the markdown body size. Is it verbose?
- **Pre-agent steps** \u2014 Does it use `steps:` to pre-compute deterministic work?

Read **only** the staged target workflow file. Do not open or read other workflow files.

## Step 4: Analyze Recent Run Data

The pre-agent step downloaded the last 7 days of Claude workflow logs to `/tmp/gh-aw/token-audit/claude-logs.json`. Filter that file for `$TOP_WORKFLOW` to inspect only the selected workflow's runs.

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
