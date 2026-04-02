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
network:
  allowed:
    - github
tools:
  github:
    toolsets: [default, actions]
  bash: true
safe-outputs:
  create-issue:
    title-prefix: "⚡ Claude Token Optimization"
    labels: [claude-token-optimization]
    close-older-issues: true
timeout-minutes: 10
strict: true
---

# Daily Claude Token Optimization Advisor

You are an AI agent that reads the latest Claude token usage report and produces **concrete, actionable optimization recommendations** for the most token-intensive Claude-engine workflow.

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
- Cache hit rate (read and write separately — Anthropic exposes both)
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
- **Tools loaded** — List all tools in the `tools:` section. Flag any that may not be needed.
- **Network groups** — List network groups in `network.allowed:`. Flag unused ones.
- **Prompt length** — Estimate the markdown body size. Is it verbose?
- **Pre-agent steps** — Does it use `steps:` to pre-compute deterministic work?
- **Post-agent steps** — Does it use `post-steps:` for validation?

## Step 4: Analyze Recent Run Artifacts

Download the most recent successful run's artifacts to understand actual tool usage:

```bash
# Find the latest successful run using the resolved workflow file
LOCK_FILE="$(basename "$WORKFLOW_FILE" .md).lock.yml"
RUN_ID=$(gh run list --repo "$GITHUB_REPOSITORY" \
  --workflow "$LOCK_FILE" \
  --status success --limit 1 \
  --json databaseId --jq '.[0].databaseId')

if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "No successful runs found for $LOCK_FILE — skipping artifact analysis"
else
  # Download artifacts
  TMPDIR=$(mktemp -d)
  gh run download "$RUN_ID" --repo "$GITHUB_REPOSITORY" \
    --name agent-artifacts --dir "$TMPDIR" 2>/dev/null || \
  gh run download "$RUN_ID" --repo "$GITHUB_REPOSITORY" \
    --name agent --dir "$TMPDIR" 2>/dev/null

  # Check token usage
  find "$TMPDIR" -name "token-usage.jsonl" -exec cat {} \;

  # Check agent stdio log for tool calls (|| true to handle no matches)
  find "$TMPDIR" -name "agent-stdio.log" -exec grep -h "^●" {} \; || true

  # Check prompt size
  find "$TMPDIR" -name "prompt.txt" -exec wc -c {} \;
fi
```

From the artifacts, determine:
- **Which tools were actually called** vs which are loaded
- **How many LLM turns** were used
- **Per-turn token breakdown** (first turn is usually the most expensive)
- **Cache write vs cache read ratio** — Anthropic charges 12.5x more for cache writes than reads
- **Whether cache writes are amortized** — Are they reused across subsequent turns?

Clean up: `rm -rf "$TMPDIR"`

## Step 5: Generate Optimization Recommendations

Produce **specific, implementable recommendations** based on these patterns:

### Tool Surface Reduction
If many tools are loaded but few are used:
- List which tools to remove from `tools:` in the workflow `.md`
- Estimate token savings (each tool schema is ~500-700 tokens)
- Example: "Remove `agentic-workflows:`, `web-fetch:` — saves ~15K tokens/turn"

### Pre-Agent Steps
If the workflow does deterministic work (API calls, file creation, data fetching) inside the agent:
- Identify which operations could move to `steps:` (pre-agent)
- Show example `steps:` configuration
- Example: "Move `gh pr list` to a pre-step, inject results via `${{ steps.X.outputs.Y }}`"

### Prompt Optimization
If the prompt is verbose or contains data the agent doesn't need:
- Suggest specific cuts or rewrites
- Example: "Replace 15-line test instructions with 3-line summary referencing pre-computed results"

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
- Check if `cache_write_tokens` from Turn 1 are reflected as `cache_read_tokens` in Turn 2+
- If prompts change substantially between turns, caching provides no benefit

### Cache Read Optimization
If cache hit rate is low (<50%):
- Check if prompts vary between runs (run-specific IDs, timestamps)
- Suggest moving variable content to the end of prompts (prefix caching)
- Note: Anthropic cache TTL is ~5 minutes for automatic caching

## Step 6: Create the Optimization Issue

Create an issue with title: `YYYY-MM-DD — <workflow-name>`

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

- **Be concrete** — Every recommendation must include specific file changes, not just "reduce tools"
- **Estimate savings** — Quantify each recommendation in tokens and percentage
- **Prioritize by impact** — Order recommendations from highest to lowest token savings
- **Include implementation steps** — Someone should be able to follow your recommendations without additional research
- **Reference the report** — Link back to the source token usage report issue
- **One workflow per issue** — Focus on the single most expensive workflow
- **Anthropic-specific insights** — Leverage cache write data that Copilot workflows don't expose
- **Clean up** temporary files after analysis
