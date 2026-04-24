# Token efficiency in GitHub Agentic Workflows

*GitHub Blog draft — token-efficiency-paper branch*

---

**Deck / subtitle:**
Agentic workflows that run on every pull request can quietly accumulate large API bills. Here's how we instrumented our production workflows, uncovered inefficiencies, and built agents to fix them.

---

GitHub Agentic Workflows are like a team of reliable street sweepers that clean up little messes all over your repo. However, like all agentic work, cost is a first-class concern. Chatbots work under a user's watchful eye, but automations like agentic workflows run in the background, and costs can compound across an entire team's activity. Thankfully, improving CI automation efficiency is often easier than optimizing interactive desktop use. A developer's session can be hard to predict, with tasks change minute-to-minute and context is constantly shifting. In contrast, an agentic workflow is fully specified in YAML and runs the same job every time, making systematic optimization easier. 

We build and maintain GitHub Agentic Workflows as a live product in our own repository, and we care about token efficiency as much as our users do. In early April 2026, we began systematically optimizing the token usage of the workflows we rely on every day. This post describes what we instrumented, how we optimized, and the results.

## Token efficiency 

The repositories that build GitHub Agentic Workflows use agentic workflows for their own CI. Those workflows include [Auto-Triage Issues]() workflow for labeling new issues, a [Contribution Check]() for auditing new pull requests againts contributor guidelines, [Test Quality Sentinel]() for reviewing test depth on every ready-for-review PR, [Glossary Maintainer]() for keeping documentation in sync with code changes, and three daily quality checks: [Daily Syntax Error Quality](), [Daily Compiler Quality](), and [Daily Community Attribution](). These run on production hardware against production API rate limits.

Using these workflows in our own CI makes inefficiencies hard to ignore. If a context window grows by 20% because we accidentally added an unused MCP tool to the manifest, it shows up in our own data right away. That creates a strong incentive to keep improving.

## Logging token usage 

Before we could optimize token consumption, we needed to see it. Each agent framework we support, including Claude CLI, Copilot CLI, Codex CLI, emits a  different log format, and usage data can be incomplete or unavailable for historical runs. Fortunately, the agentic workflows architecture already includes an API proxy that injects LLM credentials into the agent container without exposing them to the agent process. By adding structured logging to the API proxy, we capture token usage for every run across all supported agent frameworks in a single normalized format, with no changes to agent code.

Every workflow run now emits a `token-usage.jsonl` artifact with one record per LLM API call, including input tokens, output tokens, cache-read tokens, cache-write tokens, model, provider, and timestamp. Combined with the rest of the logs collected during a workflow run, this gives us the data we need to analyze and optimize token usage.

## Agents optimizing agents

Once we had token data, the next question was what to do with it. Rather than analyze it manually, we built two optimization workflows that run daily.

A [Daily Token Usage Auditor]() reads token usage artifacts from recent workflow runs, aggregates consumption by workflow and time period, and posts a structured report. It flags workflows whose token usage footprint has increased since the last report, surfaces the most expensive workflows, and highlights anomalous runs such as a workflow that normally completes in 4 LLM turns taking 18.

A [**Daily Token Optimizer**]() goes further. When the Auditor flags a heavy workflow,it examines the workflow's source and recent run logs, then creates a new issue decribing concrete inefficiencies and recommended changes. It has consistently found inefficiencies that we had missed.

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

After deploying the auditor and optimizer across twelve production workflows in the gh-aw project, we downloaded token-usage artifacts from runs before and after each optimization to measure actual impact in effective tokens (ET). Seven of the nine implemented optimizations have enough post-fix run history to compare:

![Token savings chart: before vs. after optimization across 7 workflows, measured in effective tokens](token-savings-chart-v2.png)

The improvements range from modest (Daily Community Attribution, −28%) to dramatic (Auto-Triage Issues, −81%). The variation reflects the nature of the fix applied: simple toolset pruning saves less than eliminating whole categories of work. It is important to note that the Daily Compiler Quality included a post-fix outlier run (7.68M ET) inflates the average. The remaining 5 runs average 2.41M ET (−30%) and the median for all post-fix runs was 2.6M ET (-26% compared to the pre-fix average).

From these results, we highlight three patterns that account for most of the gains.

**A single misconfigured rule can cause runaway loops.** The most extreme case was Daily Syntax Error Quality at 10.4 M ET per run—roughly 6× the project average. The root cause was a one-line misconfiguration: the workflow copied test files to `/tmp/` then called `gh aw compile *`, but the sandbox's bash allowlist only permitted relative-path glob patterns. Every compile attempt was blocked. Unable to use the tool it needed, the agent fell into a 64-turn fallback loop—manually reading source code to reconstruct what the compiler would have told it. One fix to the allowed bash patterns dropped consumption to 6.27 M ET (−40%). It's still high because the workflow itself tests many syntax error cases, but the runaway loop is gone.

**Unused tools are expensive to carry.** The Glossary Maintainer workflow was spending 4.27 M ET per run—and a single tool dominated: `search_repositories`, called **342 times in one run**, accounting for 58% of all tool calls. The tool came in as part of the default toolset but was completely unnecessary for a workflow that only scans local file changes. Removing it dropped average consumption to 2.32 M ET (−46%). The Daily Community Attribution workflow showed the inverse and was configured with eight GitHub MCP tools. It made **zero calls to any of them** across an entire run while still spending 6.75 M ET.

**Many agent turns are deterministic data-gathering.** Contribution Check and Test Quality Sentinel show the largest proportional gains (−55% and −66%) because their inefficiency was structural: 50–96% of agent turns were spent on reads that required no inference, such as fetching PR diffs, listing changed files, and parsing a repository's CONTRIBUTING.md. Moving those reads into pre-agentic `gh` CLI steps before the agent starts eliminated the majority of the LLM work. Test Quality Sentinel went from 1.15 M ET to 400 K ET; Contribution Check from 3.2 M to 1.43 M.

## What's next?

The tools that we use to optimize our workflows like API-level observability, automated auditing workflows, MCP tool pruning, and CLI substitution are all available today in the GitHub Agentic Workflows framework. The measurement methodology (workload normalization, effective tokens) is documented in the [Effective Tokens specification](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/reference/effective-tokens-specification.md) and the data and analysis scripts for this study are published on the [`token-efficiency-paper`](https://github.com/github/gh-aw-firewall/tree/token-efficiency-paper) branch.

The next step is to move from workflow-level optimization to system-level optimization. A workflow run is not really one flat sequence of API calls. It is a chain of episodes: short phases of work like gathering context, reading artifacts, retrying after a failure, or synthesizing a final answer. Once you can see those episodes clearly, you can ask much better questions. Which episode actually caused a costly run? Which episodes are mostly repeated work, blocked work, or failed work? Which ones should stop being agentic entirely and become deterministic pre-steps?

That same logic applies at the portfolio level. Repositories do not run one workflow in isolation. They run a fleet of agentic automations that often trigger on the same events, inspect the same diffs and logs, and produce adjacent judgments. That means cost is not only a property of a single workflow. It is also a property of overlap across the portfolio. The next analyses we want are portfolio-level ones: where workflows are duplicating reads, where several workflows should be consolidated, and where shared intermediate artifacts should be cached instead of rediscovered by each run.

Those open questions are genuinely hard. Measuring goodput still requires outcome instrumentation that does not yet exist at scale for agentic CI workflows, and understanding episode and portfolio efficiency requires richer lineage data than most systems collect today. But that is the direction that matters. The proxy-level observability and optimizer workflows have already changed how we develop and deploy new agentic automations. We add token monitoring from day one rather than retrofitting it later, and increasingly we think in terms of avoidable work across the whole automation fleet, not just expensive runs in isolation.

If you're running agentic workflows in CI and wondering whether you're spending more than you need to, the first step is the same as ours: add the API proxy, turn on logging, and let the data tell you where to look.

We'd love to hear how others are approaching this problem. Share your thoughts in the [Community discussion](https://github.com/orgs/community/discussions/186451) or join the #agentic-workflows channel of the [GitHub Next Discord](https://gh.io/next-discord).
