# Token efficiency in GitHub Agentic Workflows

*GitHub Blog draft — token-efficiency-paper branch*

---

**Deck / subtitle:**
Agentic workflows that run on every pull request can quietly accumulate large API bills. Here's how we instrumented our own production workflows, found the inefficiencies, and built agents to fix them.

---

GitHub Agentic Workflows are like the a team of street sweepers that clean up little messes all over your repo. However, like all agentic work cost is a first-class concern. Chatbots work under a user's watchful eye, but automations like agentic workflows run out of view and costs can compound across an entire team's activity. Thankfully it is easier to improve CI automation efficiency than interactive desktop use. A developer's session can be hard to predict since tasks change minute to minute and context is reactive. An agentic workflow's task is fully specified in YAML and it runs the same job every time, which makes systematic optimization easier. 

We build and maintain GitHub Agentic Workflows as a live product in our own repository, and we worry about our own token efficiency as much as our users do. In early April 2026, we began to systematically optimize the token-usage of the workflows that we rely on every day. This post describes what we instrumented, how we optimized, and the results.

## Token efficiency 

The repositories that build GitHub Agentic Workflows use agentic workflows for their own CI. We have an Auto-Triage Issues workflow that labels every new issue for discoverability, a Contribution Check that audits incoming pull requests for contributor guideline compliance, a Test Quality Sentinel that reviews test depth on every ready-for-review PR, a Glossary Maintainer that keeps documentation in sync with codebase changes, and three daily quality checks—Daily Syntax Error Quality, Daily Compiler Quality, and Daily Community Attribution—that run on a schedule to test compiler error messages, assess code standards, and track community contributions. These run on production hardware against production API rate limits.

The fastest path to understanding the true characteristics of a system is to depend on it yourself. When a workflow's context window grows by 20% because we accidentally added an unused MCP tool to a manifest, we see it in our own data. Running our own workflows gives us a strong incentive to improve.

## Logging token usage 

Before you can optimize token consumption, you need to see it. However, each agent framework that we support (Claude CLI, Copilot CLI, Codex CLI) emits a  different log formats, and usage data can be incomplete or unavailable for historical runs. Thankfully, the agentic workflows architecture already includes an API proxy that injects LLM credentials into the agent container to prevent the agent process from directly accessing them. Adding structured logging to the API proxy captures token usage for every run, from every agent framework, in a single normalized format—without touching any agent code.

Every workflow run now emits a `token-usage.jsonl` artifact with one record per LLM API call that records input tokens, output tokens, cache-read tokens, cache-write tokens, model, provider, and timestamp. Combining this data with the rest of the logs collected during an workflow run allows us to optimize the agent's token usage.

## Agents optimizing agents

Token data in hand, the next question was what to do with it. Rather than analyze it manually, we built two optimization workflows that run on a daily schedule.

A **Daily Token Usage Auditor** reads token usage artifacts from all recent workflow runs, aggregates consumption by workflow and time period, and posts a structured report. Its job is to flag any workflow that has significantly increased its token footprint since the last report, surface the most expensive workflows, and note any runs that look anomalous (e.g., a workflow that normally completes in 4 LLM turns taking 18).

A **Daily Token Optimizer** goes further. When an Auditor flags a heavy workflow, the Optimizer looks at the workflow's source and recent run logs and creates a new issue with concrete inefficiencies and specific changes. The Optimizer has consistently found many workflow inefficiencies that we had missed.

Of course, these are agentic workflows themselves, and their token usage also appears in the daily reports, creating a small virtuous cycle.

## Eliminating unused MCP tools

The single most common inefficiency the Optimizer identified was unused MCP tool registrations.

When an agent connects to an MCP server, the server's entire tool manifest—every available function, with its full JSON schema—is included in the system prompt of every LLM API call for the duration of the session. A GitHub MCP server with 40 registered tools can add 10–15 KB of JSON schema to every turn's context. If the workflow only uses 5 of those tools, the other 35 are dead weight on every call.

This is a very common pattern. Workflow authors naturally start with the full tool set available—it's the path of least resistance, and the agent can figure out which tools it needs. But as time goes on, most workflows settle into a narrow, stable set of tool calls. The Optimizer identifies this pattern by cross-referencing the tool manifest against the actual tool calls recorded in the MCP gateway logs and recommends pruning unused tools from the configuration.

For our smoke test workflows, removing unused tools from the MCP configuration reduced the system prompt by 8–12 KB per call, saving several thousand context tokens per run with no change to behavior.

## Replacing GitHub MCP with gh CLI

Removing unused MCP tools is a relatively simple win. A larger structural opportunity was replacing GitHub MCP server calls for data-fetching operations like retrieving PR diffs, file contents, and review state with calls to a `gh` CLI subprocess.

This change makes a difference because an MCP tool call is an LLM reasoning step, not just a data retrieval. The agent must decide to call the tool, formulate its arguments, and receive its output as part of the context. That's a full round-trip LLM API call, consuming tokens for the tool-use JSON schema, the argument block, and the response. Calling `gh pr diff`, by contrast, is a direct HTTP request to GitHub's REST API with no LLM involvement.

We used two strategies for this migration:

**Pre-agentic data downloads.** For data the agent always needs like a PR diff, the list of changed files, and relevant CI results, we added a setup step in the workflow that runs `gh` commands *before* the agent starts and writes the results to workspace files. The agent reads those files instead of making MCP calls. This is a big win because it eliminates tool-call overhead and allows the agent to take advantage of its extensive training in bash and scripting to efficiently process the data.

**In-agent CLI proxy substitution.** Pre-downloading isn't possible in cases where the agent needs to determine at runtime what to fetch. In these cases we rely on a lightweight transparent HTTP CLI proxy that routes `gh` CLI traffic to GitHub's API without the exposing an authentication token to the agent. The agent runs `gh pr view --json` and gets structured data back, just as a user would from a terminal. This preserves our zero-secrets security requirement that the agent can never have direct access to authentication material.

Together these techniques move the majority of GitHub data-fetching out of the LLM reasoning loop, which reduces token consumption and latency.

## Measuring efficiency gains is not easy

Once we had token data flowing and began to optimize our workflows, we ran into a nuanced problem: how do you know whether a change actually made things more efficient, or just made the workflow do less and perhaps worse work?

There are three confounding factors.

**Not all tokens are created equal.** Running the same workflow on Claude Haiku versus Claude Sonnet produces token counts that look similar but cost very differently. Haiku costs roughly 4× less per token than Sonnet, so a workflow that switches models appears unchanged in raw token counts but represents a significant cost reduction. To account for this, we use an Effective Tokens (ET) metric that applies model multipliers to each token type:

```
ET = m × (1.0 × I + 0.1 × C + 4.0 × O)
```

where *m* is a model cost multiplier (Haiku = 0.25×, Sonnet = 1.0×, Opus = 5.0×), *I* is newly-processed input tokens, *C* is cache-read tokens, and *O* is output tokens. Output tokens carry 4× weight because they are the most expensive token type across all major providers. Cache-read tokens carry only 0.1× weight because they are served from cache at a fraction of the cost of fresh input. This formula normalizes consumption across model tiers so that a 10% ET reduction means a genuine 10% cost reduction regardless of which model is in use.

**The workload is a live repository.** The workflows we optimize are not operating on consistent benchmark data. A workflow that processes a 200-line PR diff one day genuinely uses more tokens than one processing a 5-line fix a few hours later. The difference is correct behavior, not inefficiency. Raw token counts can conflate workload variation with efficiency changes. We try to normalize for this by tracking LLM API call counts alongside token counts; if the number of LLM turns per run stays constant while tokens-per-call falls, that's a genuine efficiency improvement. If both fall together, it could mean less work is being done.

**Does quality change?** This is the hardest question. A lighter model running a more constrained workflow might produce lower-quality output. We looked at the process-level signals like output tokens per LLM call, turn counts per run, and tool-call completion rates to approximate quality. For our optimized Smoke Copilot workflow all three remained stable across the optimization period even as token consumption fell. The workflow completes in exactly 5 LLM turns every run, before and after the optimizations. Of course, these are process signals, not outcome signals. We cannot directly observe whether the quality of agent output improved, degraded, or stayed flat, because we have no ground-truth labels for what "correct" output looks like. Measuring goodput—tokens per unit of correct work—requires additional instrumentation and thought.

## Initial results

After deploying the auditor and optimizer across twelve production workflows in the gh-aw project, we downloaded token-usage artifacts from runs before and after each optimization and computed ET for each run. Seven of the nine implemented optimizations have enough post-fix run history to compare:

| Workflow | Runs (pre) | Avg ET (pre) | Runs (post) | Avg ET (post) | Change |
|---|---|---|---|---|---|
| Auto-Triage Issues | 61 | 115 K | 62 | 64 K | **−44%** |
| Glossary Maintainer | 2 | 521 K | 12 | 332 K | **−36%** |
| Daily Syntax Error Quality | 2 | 1.13 M | 14 | 863 K | **−24%** |
| Test Quality Sentinel | 1 | 119 K | 561 | 110 K | −8% |
| Daily Compiler Quality | 12 | 482 K | 7 | 456 K | −5% |
| Daily Community Attribution | 8 | 835 K | 4 | 831 K | ~0% |
| Contribution Check | 46 | 324 K | 42 | 353 K | +9% |

The results show a wide range of outcomes. Three workflows—Auto-Triage Issues, Glossary Maintainer, and Daily Syntax Error Quality—show clear, sustained reductions of 24–44%. Two others—Daily Compiler Quality and Test Quality Sentinel—show modest improvements that are difficult to separate from workload variation. And two—Daily Community Attribution and Contribution Check—show no meaningful improvement in the data we collected.

This range is itself an important finding. Not every optimization the agent recommends translates into measurable ET reduction, especially over short observation windows on a live repository where workload varies day to day. The workflows with the strongest signal are those where the optimization eliminated a clearly pathological behavior—a runaway loop, a tool called hundreds of times unnecessarily—rather than shaving a few percent off normal operation.

We also note the small pre-optimization sample sizes for some workflows. Daily Syntax Error Quality and Glossary Maintainer have only 2 runs each before optimization; Test Quality Sentinel has just 1. Token tracking via the API proxy started in early April, and some workflows were optimized within days of the first instrumented run. The percentage changes for these workflows should be read as directional rather than precise.

From these results, we highlight three patterns that account for most of the gains.

**A single misconfigured rule can cause runaway loops.** The most extreme case was Daily Syntax Error Quality at 1.13 M ET per run—the highest in the project. The root cause was a one-line misconfiguration: the workflow copied test files to `/tmp/` then called `gh aw compile *`, but the sandbox's bash allowlist only permitted relative-path glob patterns. Every compile attempt was blocked. Unable to use the tool it needed, the agent fell into a 64-turn fallback loop—manually reading source code to reconstruct what the compiler would have told it. One fix to the allowed bash patterns dropped average consumption to 863 K ET (−24%). It's still the most expensive workflow because it tests many syntax error cases, but the runaway loop is gone.

**Unused tools are expensive to carry.** The Glossary Maintainer workflow was spending 521 K ET per run—and a single tool dominated: `search_repositories`, called **342 times in one run**, accounting for 58% of all tool calls. The tool came in as part of the default toolset but was completely unnecessary for a workflow that only scans local file changes. Removing it dropped average consumption to 332 K ET (−36%). The Daily Community Attribution workflow illustrates the limits of this approach: it was configured with eight GitHub MCP tools and made **zero calls to any of them** across an entire run, yet removing them did not measurably reduce ET. The tool manifests were a small fraction of this workflow's overall context.

**Many agent turns are deterministic data-gathering.** Auto-Triage Issues shows the strongest sustained improvement (−44% across 62 post-fix runs) because the optimization eliminated structural inefficiency: many agent turns were spent on reads that required no inference, such as fetching issue metadata and scanning labels. Moving those reads into pre-agentic `gh` CLI steps before the agent starts removed them from the LLM reasoning loop entirely. The same pattern was applied to Contribution Check and Test Quality Sentinel, where 50–96% of turns were data-gathering. However, the ET data for these two workflows does not yet show a clear reduction—Contribution Check is roughly flat, and Test Quality Sentinel has too few pre-optimization runs for a reliable comparison. We suspect workload variation (different PR sizes, different numbers of changed files) is masking the per-turn efficiency gains in the aggregate numbers.

## What's next?

The tools that we use to optimize our workflows like API-level observability, automated auditing workflows, MCP tool pruning, and CLI substitution are all available today in the Github Agentic Workflows framework. The measurement methodology (workload normalization, effective tokens) is documented in the [Effective Tokens specification](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/effective-tokens-specification.md) and the data and analysis scripts for this study are published on the [`token-efficiency-paper`](https://github.com/github/gh-aw-firewall/tree/token-efficiency-paper) branch.

The open questions are genuinely hard: measuring goodput requires outcome instrumentation that doesn't yet exist at scale for agentic CI workflows. We're building toward it. In the meantime, the proxy-level observability and the optimizer workflows have already changed how we develop and deploy new agentic automations—we add token monitoring from day one rather than retrofitting it later.

If you're running agentic workflows in CI and wondering whether you're spending more than you need to, the first step is the same as ours: add the API proxy, turn on logging, and let the data tell you where to look.

We'd love to hear how others are approaching this problem. Share your thoughts in the [Community discussion](https://github.com/orgs/community/discussions/186451) or join the #agentic-workflows channel of the [GitHub Next Discord](https://gh.io/next-discord).
