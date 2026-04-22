# Under the hood: Token efficiency in GitHub Agentic Workflows

*GitHub Blog draft — token-efficiency-paper branch*

---

**Deck / subtitle:**
Agentic workflows that run on every pull request can quietly accumulate large API bills. Here's how we instrumented our own production workflows, found the inefficiencies, and built agents that fix them.

---

Agentic workflows are compelling precisely because they run continuously—on every pull request, every commit, every scheduled cron trigger. That continuous execution is also what makes cost a first-class concern. Unlike a chatbot where a user pays per conversation, an agentic CI workflow compounds across your entire team's activity. Run a workflow with a 150 K-token context on 50 pull requests a day, and you're spending several dollars per day before you've shipped anything.

We build and maintain GitHub Agentic Workflows as a live product in our own repository. That means we're not just designing the system—we're paying its API bills too. Over a 20-day period in April 2026, we ran 2,836 workflow executions spanning five different workflow types, sampled \$962.98 in LLM API costs (averaging \$0.43 per run), and systematically reduced per-run effective token consumption by 29% in our most frequently triggered workflow. This post describes how we did it: what we instrumented, what we found, and what we built to fix it.

## We eat our own cooking

The repository that builds GitHub Agentic Workflows uses Agentic Workflows for its own CI. We have a Security Guard workflow that reviews every incoming pull request for security concerns, a Secret Digger that scans for credential leaks, smoke tests that validate the Copilot CLI and Claude CLI against every change, and a pair of daily advisor workflows that surface token usage trends and suggest optimizations. These aren't demos—they run on production hardware, against production GitHub API rate limits, and billed against a real budget.

That alignment between builder and user is intentional. The fastest path to understanding the real performance characteristics of a system is to depend on it yourself. When a workflow's context window grows by 20% because we accidentally added an unused MCP tool to the manifest, we feel it in the bill before a user does. Running our own workflows gave us both the incentive to optimize and the data to measure it.

## Step one: log token usage at the API level

Before you can optimize token consumption, you need to see it. The obvious approach—reading application logs from the agent itself—has a fundamental problem: different agent frameworks (Claude CLI, Copilot CLI, Codex CLI) emit completely different log formats, and usage data is often incomplete or unavailable for historical runs.

We took a different approach. The Agentic Workflows architecture already includes an API proxy sidecar that injects LLM credentials into the agent container without exposing them to the agent process directly. This proxy sits between the agent and every upstream LLM provider call. By adding structured logging to the proxy, we capture token usage for every run, from every agent framework, in a single normalized format—without touching agent code at all.

Every workflow run now emits a `token-usage.jsonl` artifact: one record per LLM API call, recording input tokens, output tokens, cache-read tokens, cache-write tokens, model, provider, and timestamp. This single change turned token consumption from an invisible cost center into a first-class CI observable.

## Let agents optimize agents

Token data in hand, the next question was what to do with it. Rather than analyze it manually, we built two optimization workflows that run on a daily schedule.

The **Daily Token Usage Auditor** reads token usage artifacts from all recent workflow runs, aggregates consumption by workflow and by time period, and posts a structured report to a GitHub Discussion. Its job is surveillance: flag any workflow that has significantly increased its token footprint since the last report, surface the most expensive workflows, and note any runs that look anomalous (e.g., a workflow that normally completes in 4 LLM turns taking 18).

The **Daily Token Optimizer** goes further. When the Auditor flags a heavy workflow, the Optimizer is given that workflow's source (the `.md` file and recent run logs) and asked to identify concrete inefficiencies and propose specific changes. It then creates a pull request with those changes. In practice, the Optimizer has become the highest-leverage tool in our efficiency toolkit: it consistently finds things that human reviewers miss.

Both workflows are themselves agentic workflows running inside the Agent Workflow Firewall, so their token usage also appears in the daily reports—a small but satisfying recursion.

## What the logs revealed: unused MCP tools

The single most common inefficiency the Optimizer identified was unused MCP tool registrations.

When an agent connects to an MCP server, the server's entire tool manifest—every available function, with its full JSON schema—is included in the system prompt of every LLM API call for the duration of the session. A GitHub MCP server with 40 registered tools can add 10–15 KB of JSON schema to every turn's context. If the workflow only uses 5 of those tools, the other 35 are dead weight on every call.

This turns out to be a very common pattern. Workflow authors naturally start with the full tool set available—it's the path of least resistance, and the agent can figure out which tools it needs. But in production, most workflows settle into a narrow, stable set of tool calls. The Optimizer identifies this pattern by cross-referencing the tool manifest against the actual tool calls recorded in the MCP gateway logs and recommends pruning unused tools from the configuration.

For our smoke test workflows, removing unused tools from the MCP configuration reduced the system prompt by 8–12 KB per call, saving several thousand context tokens per run with no change to behavior.

## Going further: replace GitHub MCP calls with gh CLI calls

Removing unused MCP tools is a relatively simple win. A larger structural opportunity was replacing GitHub data-fetching operations—reads that retrieve PR diffs, file contents, and review state—from MCP server tool calls to deterministic `gh` CLI subprocess calls.

The difference matters because an MCP tool call isn't just a data fetch. It's an LLM reasoning step: the agent must decide to call the tool, formulate its arguments, and receive its output as part of the context. That's a full round-trip LLM API call, consuming tokens for the tool-use JSON schema, the argument block, and the response. A `gh pr diff` subprocess call, by contrast, is a direct HTTP request to GitHub's REST API with no LLM involvement.

We used two strategies to make this migration:

**Pre-agentic data downloads.** For data the agent always needs—the PR diff, the list of changed files, relevant CI results—we added a setup step in the workflow that runs `gh` commands *before* the agent starts and writes the results to files in the workspace. The agent reads those files instead of making MCP calls. This is the most efficient approach because it eliminates the tool-call overhead entirely.

**In-agent CLI proxy substitution.** For cases where the agent determines at runtime which data to fetch, pre-downloading isn't always possible. Here we rely on the CLI proxy—a lightweight transparent HTTP proxy running in the agent container that routes `gh` CLI traffic through to GitHub's API without the agent ever seeing an authentication token. The agent runs `gh pr view --json` and gets structured data back, same as a user would from a terminal. The zero-secrets security property is preserved: the agent never has direct access to a GitHub PAT. It just gets the data.

Together, these approaches moved the majority of GitHub data-fetching out of the LLM reasoning loop, which reduces both token consumption and latency.

## Measuring efficiency is harder than it looks

Once we had token data flowing and optimizations shipping, we ran into a more subtle challenge: how do you know whether a change actually made things more efficient, versus just making the workflow *do less*?

Three confounding factors make this harder than it first appears.

**Not all tokens are created equal.** Running the same workflow on Claude Haiku versus Claude Sonnet produces token counts that look similar on paper but cost very differently. Haiku costs roughly 4× less per token than Sonnet, so a workflow that switches models appears "unchanged" in raw token counts but actually represents a significant cost reduction. To account for this, we use an Effective Tokens (ET) metric that applies model multipliers to each token type:

```
ET = m × (1.0 × I + 0.1 × C + 4.0 × O)
```

where *m* is a model cost multiplier (Haiku = 0.25×, Sonnet = 1.0×, Opus = 5.0×), *I* is newly-processed input tokens, *C* is cache-read tokens, and *O* is output tokens. Output tokens carry 4× weight because they are the most expensive token type across all major providers. Cache-read tokens carry only 0.1× weight because they are served from cache at a fraction of the cost of fresh input. This formula normalizes consumption across model tiers so that a 10% ET reduction means a genuine 10% cost reduction regardless of which model is in use.

**The workload is a live repository.** The gh-aw-firewall repository is actively developed: pull requests merge, issues open, the codebase changes. A workflow that processes a 200-line PR diff genuinely uses more tokens than one processing a 5-line fix—that's not inefficiency, that's correct behavior. Raw token counts conflate workload variation with efficiency changes. We normalize by tracking LLM API call counts alongside token counts; if the number of LLM turns per run stays constant while tokens-per-call falls, that's a genuine efficiency improvement. If both fall together, it could mean less work is being done.

**Does quality change?** This is the hardest question. A lighter model running a more constrained workflow might produce lower-quality output. We looked at the process-level signals available in our dataset: output tokens per LLM call, turn counts per run, and tool-call completion rates. For Smoke Copilot—our most-optimized workflow—all three remained stable across the optimization period even as token consumption fell. The workflow completes in exactly 5 LLM turns every run, before and after the optimizations. But these are process signals, not outcome signals. We cannot directly observe whether the quality of agent output improved, degraded, or stayed flat, because we have no ground-truth labels for what "correct" output looks like. Measuring goodput—tokens per unit of correct work—requires outcome instrumentation that is on our roadmap.

## The numbers: Smoke Copilot

Smoke Copilot is a workflow that runs on every pull request to the gh-aw-firewall repository and validates that the Copilot CLI agent can successfully complete a basic agentic task inside the AWF sandbox. It's a good case study because it has a well-defined, stable workload: the task is the same every run.

At the start of our measurement period, the workflow was making 15 MCP tool calls per run to gather the context it needed: listing pull requests, fetching diff content, reading file state, and checking CI status. Each of those 15 calls contributed a tool-schema JSON block to the system prompt and consumed a full LLM reasoning turn. Median context tokens were 156 K per run.

A single workflow change replaced 13 of those MCP calls with a single `gh pr view --json` call run as a pre-agentic download step. The JSON output from `gh` is richer than what the MCP calls were returning, the agent reads it directly from the workspace, and no LLM reasoning turns are consumed for data fetching.

After that change and a subsequent model selection optimization, the same workflow runs with 2 MCP calls per run instead of 15, median context tokens of 114 K (–27%), and a 29% reduction in effective tokens when model cost is factored in. The workflow still completes in 5 LLM turns per run. From the outside, nothing has changed about what it does—only how efficiently it does it.

| | Before | After | Change |
|---|---|---|---|
| MCP tool calls/run | 15 | 2 | −87% |
| Context tokens (median) | 156 K | 114 K | −27% |
| Effective tokens (ET) | 52 K | 37 K | −29% |
| LLM turns/run | 5 | 5 | — |

Across all five workflows in the study, median effective tokens per run fell 25% over the 20-day period.

## What's next?

The techniques described here—API-level observability, automated auditing workflows, MCP tool pruning, and CLI substitution—are all available today in the Agentic Workflows framework. The measurement methodology (workload normalization, effective tokens) is documented in the [Effective Tokens specification](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/effective-tokens-specification.md) and the data and analysis scripts for this study are published in the [gh-aw-firewall repository](https://github.com/github/gh-aw-firewall) on the `token-efficiency-paper` branch.

The open questions are genuinely hard: measuring goodput requires outcome instrumentation that doesn't yet exist at scale for agentic CI workflows. We're building toward it. In the meantime, the proxy-level observability and the optimizer workflows have already changed how we develop and deploy new agentic automations—we add token monitoring from day one rather than retrofitting it later.

If you're running agentic workflows in CI and wondering whether you're spending more than you need to, the first step is the same as ours: add the API proxy, turn on logging, and let the data tell you where to look.

We'd love to hear how others are approaching this problem. Share your thoughts in the [Community discussion](https://github.com/orgs/community/discussions/186451) or join the #agentic-workflows channel of the [GitHub Next Discord](https://gh.io/next-discord).
