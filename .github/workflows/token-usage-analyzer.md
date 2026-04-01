---
description: Daily token usage analysis across agentic workflow runs — identifies trends, inefficiencies, and optimization opportunities
on:
  schedule: daily
  workflow_dispatch:
  skip-if-match:
    query: 'is:issue is:open in:title "Token Usage Report"'
    max: 1
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
imports:
  - shared/mcp-pagination.md
  - shared/reporting.md
tools:
  github:
    toolsets: [default, actions]
  bash: true
safe-outputs:
  create-issue:
    title-prefix: "📊 Token Usage Report"
    labels: [token-usage-report]
timeout-minutes: 15
---

# Daily Token Usage Analyzer

You are an AI agent that analyzes token usage across agentic workflow runs in this repository. Your goal is to identify trends, highlight inefficiencies, and recommend optimizations to reduce AI inference costs.

## Background

This repository uses the **Agent Workflow Firewall (AWF)** with an api-proxy sidecar that tracks token usage for LLM API calls. Each workflow run with `--enable-api-proxy` produces a `token-usage.jsonl` file captured in the `agent-artifacts` upload artifact.

**Token usage tracking is a new feature** — many older runs won't have this data. Handle missing data gracefully.

### Token Usage Record Format

Each line in `token-usage.jsonl` is a JSON object:
```json
{
  "timestamp": "2026-04-01T17:38:12.486Z",
  "request_id": "uuid",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "path": "/v1/messages?beta=true",
  "status": 200,
  "streaming": true,
  "input_tokens": 3,
  "output_tokens": 418,
  "cache_read_tokens": 14044,
  "cache_write_tokens": 26042,
  "duration_ms": 5858,
  "response_bytes": 2800
}
```

## Your Mission

### Step 1: Discover Recent Workflow Runs

Use `gh run list` via bash to find completed agentic workflow runs from the past 24 hours (or since the last token usage report issue). Focus on workflows that use the api-proxy:

- `smoke-copilot`, `smoke-claude`, `smoke-codex`, `smoke-chroot`, `smoke-services`
- `secret-digger-copilot`, `secret-digger-claude`, `secret-digger-codex`
- `security-guard`, `security-review`
- `build-test`, `ci-doctor`, `plan`
- Any other workflow with `agent-artifacts`

Use bash to run:
```bash
gh run list --repo "$GITHUB_REPOSITORY" --limit 50 --json databaseId,name,status,conclusion,createdAt,workflowName --jq '[.[] | select(.conclusion == "success" or .conclusion == "failure")]'
```

### Step 2: Download and Parse Token Usage Data

For each discovered run, attempt to download the `agent-artifacts` artifact and extract `token-usage.jsonl`:

```bash
# Create temp directory
TMPDIR=$(mktemp -d)

# Try to download artifacts for a run
gh run download <RUN_ID> --repo "$GITHUB_REPOSITORY" --name agent-artifacts --dir "$TMPDIR/run-<RUN_ID>" 2>/dev/null

# Look for token-usage.jsonl (may be nested under sandbox/firewall/logs/api-proxy-logs/)
find "$TMPDIR/run-<RUN_ID>" -name "token-usage.jsonl" 2>/dev/null
```

**Graceful degradation:**
- If artifact download fails → skip run, note it as "no artifacts"
- If `token-usage.jsonl` is missing → skip run, note it as "no token logs"
- If the file is empty → skip run, note it as "empty token logs"
- Track which workflows have instrumentation vs which don't

### Step 3: Compute Per-Workflow Statistics

For each workflow that has token data, calculate:

1. **Total tokens**: `input_tokens + output_tokens + cache_read_tokens + cache_write_tokens`
2. **Billable tokens**: `input_tokens + output_tokens + cache_write_tokens` (cache reads are discounted)
3. **Input/output ratio**: `(input_tokens + cache_read_tokens) / output_tokens`
4. **Cache hit rate**: `cache_read_tokens / (cache_read_tokens + input_tokens) * 100`
5. **Request count**: Number of records in the JSONL
6. **Average latency**: Mean `duration_ms` per request
7. **Model distribution**: Count of requests per model
8. **Estimated cost** (use approximate rates):
   - Anthropic Sonnet: input $3/M, output $15/M, cache_read $0.30/M, cache_write $3.75/M
   - Anthropic Haiku: input $0.80/M, output $4/M, cache_read $0.08/M, cache_write $1/M
   - OpenAI/Copilot: input $2.50/M, output $10/M

Use bash with a Python or jq script to process the JSONL files efficiently.

### Step 4: Identify Optimization Opportunities

Flag workflows with these patterns:

| Pattern | Threshold | Recommendation |
|---------|-----------|----------------|
| Zero cache hits | cache_hit_rate = 0% | Enable prompt caching |
| Low cache hits | cache_hit_rate < 50% | Review cache breakpoints |
| High input/output ratio | ratio > 100:1 | Reduce system prompt or MCP tool surface |
| Many small requests | >10 requests, <50 output tokens each | Batch requests or combine tool calls |
| High total cost | >$1.00 per run | Review if workflow is doing too much |
| Increasing trend | >20% increase vs last report | Investigate what changed |

### Step 5: Check for Historical Trends

Search for previous token usage report issues:
```bash
gh issue list --repo "$GITHUB_REPOSITORY" --label token-usage-report --state all --limit 5 --json number,title,createdAt,url
```

If previous reports exist, compare current metrics to identify:
- Workflows with increasing token consumption
- Workflows that gained or lost prompt caching
- New workflows that started using the api-proxy
- Cost trend over time

### Step 6: Create the Summary Issue

Create an issue with the following structure:

#### Title: `YYYY-MM-DD` (the date prefix is added by safe-outputs)

#### Body structure:

```markdown
### Overview

**Period**: [start date] to [end date]
**Runs analyzed**: X of Y (Z had token data)
**Total tokens**: N across all workflows
**Estimated total cost**: $X.XX

### Workflow Summary

| Workflow | Runs | Total Tokens | Cost | Cache Rate | I/O Ratio | Top Model |
|----------|------|-------------|------|------------|-----------|-----------|
| smoke-claude | 2 | 395K | $0.46 | 99.5% | 0.6:1 | sonnet-4.6 |
| smoke-copilot | 2 | 603K | $1.20 | 0% | 184:1 | gpt-4o |
| ... | | | | | | |

### 🔍 Optimization Opportunities

1. **smoke-copilot** — 0% cache hit rate, 184:1 input/output ratio
   - Enable prompt caching to reduce input costs by ~80%
   - Review MCP tool surface (Playwright loads 30+ tools but barely uses them)

2. ...

<details>
<summary><b>Per-Workflow Details</b></summary>

#### smoke-claude
- **Runs**: 2 (run 123, run 456)
- **Requests**: 12 total (avg 6/run)
- **Models**: claude-haiku-4.5 (4 reqs), claude-sonnet-4.6 (8 reqs)
- **Tokens**: 395K total (1.5K input, 2.5K output, 304K cache_read, 87K cache_write)
- **Cache hit rate**: 99.5%
- **Avg latency**: 3,800ms/request
- **Estimated cost**: $0.46

#### smoke-copilot
...

</details>

<details>
<summary><b>Workflows Without Token Data</b></summary>

The following workflows either don't use `--enable-api-proxy` or ran before token tracking was enabled:
- ci-doctor (3 runs — no agent-artifacts)
- issue-monster (1 run — no token-usage.jsonl)

</details>

### Historical Trend

[If previous reports exist, show comparison. Otherwise note: "This is the first token usage report. Historical trends will be available in future reports."]

### Previous Report
[Link to previous report issue if one exists, otherwise omit this section]
```

## Important Guidelines

- **Do NOT fail** if no token data is available. Create a minimal report explaining that token tracking is new and which workflows need instrumentation.
- **Clean up** temporary directories after processing.
- **Respect rate limits** — download artifacts one at a time, not in parallel.
- **Use `--perPage` parameters** when listing runs to avoid token limits on MCP responses.
- **Wrap verbose output** in `<details>` blocks for progressive disclosure.
- **Round costs** to 2 decimal places, token counts to nearest thousand for readability.
- **Sort workflows** by estimated cost (highest first) in the summary table.
