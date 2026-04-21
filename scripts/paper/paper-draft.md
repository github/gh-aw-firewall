# Measuring Token Efficiency in Production Agentic Workflows

**Abstract.** We present a measurement study of token consumption in production agentic workflows over a 20-day optimization campaign. Our system—the Agent Workflow Firewall (AWF)—runs AI coding agents inside network-isolated Docker containers and, via an API proxy sidecar, intercepts every large language model (LLM) API call to record token usage. We track 2,836 workflow runs across five workflow types from April 1–21, 2026, spanning six successive optimization milestones. Across that period, median context tokens per run fell from **196.7 K to 159.5 K (−18.9%)**, and the most-optimized workflow (Security Guard) achieved a **49.1% reduction** (330 K → 168 K). A workload-normalized analysis—comparing LLM call counts, MCP server tool calls, and deterministic `gh`-CLI calls across runs—reveals that different techniques have fundamentally different efficiency profiles: prompt cache alignment and model switching reduce tokens while preserving identical workloads, while turn-budget caps and relevance gating reduce both tokens and the amount of work done. A concurrent migration from MCP server operations (median 15/run in early epochs) to deterministic `gh`-CLI calls (median 2/run in later epochs) redistributes load from stochastic LLM turns to cheap, reliable subprocess calls. Total sampled cost across 2,234 costed runs was **\$962.98** (avg \$0.43/run), down from \$0.49/run at baseline.

---

## 1. Introduction

AI coding agents—systems that autonomously read code, call APIs, edit files, and open pull requests—are increasingly deployed as continuous-integration (CI) automation on GitHub Actions. These agents consume context tokens on every LLM API call. At scale, token cost is a first-class engineering constraint: a modest fleet of agentic workflows running on every pull request can easily accumulate hundreds of dollars per day.

Reducing token consumption matters for three reasons. First, **cost**: provider APIs charge per token, and workloads that run on every push are price-sensitive. Second, **latency**: context window size directly affects time-to-first-token and completion time, which affects the wall-clock feedback loop for developers. Third, **reliability**: agents given excessively long contexts often produce less focused outputs, increasing the risk of hallucinated tool calls or off-task behavior.

Despite the practical importance of token efficiency, there is little published work on *measuring* it in production agentic systems over time, and even less on *attributing* reductions to specific optimization techniques while controlling for workload changes. It is easy to declare that "tokens went down by 20%," but harder to determine whether that reduction reflects the agent doing the same work more cheaply, or doing less work altogether.

This paper makes three contributions:

1. **Infrastructure for continuous token measurement**: AWF's API proxy sidecar intercepts every upstream LLM call and writes structured per-call token records to artifacts, enabling post-hoc analysis of any historical CI run without agent code changes.

2. **A workload-normalized analysis methodology**: By additionally capturing MCP server tool call counts, `gh`-CLI subprocess call counts, and LLM API call counts per run, we distinguish *efficiency* improvements (same work, fewer tokens) from *scope* reductions (less work done).

3. **Empirical results from six optimization epochs**: We characterize which technique produces which kind of reduction, providing practitioners with a playbook that is honest about the tradeoffs.

---

## 2. System Background

### 2.1 Agent Workflow Firewall (AWF)

AWF is an open-source CLI tool (`@github/awf`) that wraps any command inside a pair of Docker containers. The *agent container* runs the user's command—a GitHub Copilot CLI invocation, a Claude CLI invocation, etc.—in a chrooted environment with selective bind-mounts of the host filesystem. The *Squid proxy container* enforces an L7 HTTP/HTTPS egress allowlist: every outbound connection from the agent is CONNECT-proxied through Squid, which applies a domain ACL. Domains not on the allowlist receive HTTP 403.

An iptables init-container shares the agent's network namespace and configures DNAT rules that redirect all port-80 and port-443 traffic to Squid even for tools that ignore proxy environment variables. This defense-in-depth approach ensures that a compromised or misconfigured tool cannot exfiltrate data to arbitrary endpoints.

AWF is designed for CI/CD deployment: it runs as a GitHub Actions step, adds approximately 15–30 seconds of overhead (container pull and startup), and preserves the exit code of the wrapped command.

### 2.2 API Proxy Sidecar

The API proxy sidecar (port addresses 10000–10004 on `172.30.0.30`) is an optional third container enabled with `--enable-api-proxy`. It implements a credential-injection pattern: the agent container has no API keys in its environment; instead, it sends unauthenticated requests to the sidecar (e.g., `http://172.30.0.30:10001` for Anthropic). The sidecar injects the real credential header and forwards the request through Squid to the upstream provider.

Crucially for this paper, the sidecar also **records every API call** to `token-usage.jsonl`. Each record captures: provider, model, input tokens, output tokens, cache-read tokens, cache-write tokens, effective tokens (AWF's own formula: `input + output + cache_write - cache_read`), and cost in USD. This log is uploaded as a GitHub Actions artifact after each workflow run, enabling fleet-wide analysis without modifying any agent code.

### 2.3 CLI Proxy

The CLI proxy (`cli-proxy`) is a transparent interceptor for the `gh` GitHub CLI. When enabled, `gh` commands made inside the agent container are routed through a local Unix socket, and each execution is logged with its arguments, exit code, duration, and byte counts to `cli-proxy-logs/access.log`. This log is also uploaded as an artifact.

The CLI proxy serves two purposes. First, **security**: it restricts `gh` to a GitHub Actions token with only the permissions the workflow needs, without exposing the token value to the agent. Second, **observability**: it makes all GitHub API operations legible, enabling workload attribution (§5).

### 2.4 Agentic Workflows

The workflows studied here are *agentic workflows* compiled by `gh-aw`, a GitHub CLI extension. Each workflow is authored in Markdown with a YAML frontmatter block specifying triggers, tools, permissions, network access, and the AI engine to use. The Markdown body serves as the system prompt. The compiled `.lock.yml` file is a standard GitHub Actions workflow that invokes AWF with `--enable-api-proxy`, starts the AI engine, and uploads artifacts.

The five workflow types studied:

| Workflow | Trigger | Task |
|---|---|---|
| **Security Guard** | Every PR | Reviews code changes for security vulnerabilities |
| **Smoke Claude** | Every PR | End-to-end test of Claude CLI in AWF sandbox |
| **Smoke Copilot** | Every PR | End-to-end test of Copilot CLI in AWF sandbox |
| **Secret Digger** | Every PR | Scans for accidentally committed secrets |
| **Daily Token Advisor** | Schedule | Analyzes token usage logs and suggests optimizations |

---

## 3. Data Collection

### 3.1 Token Dataset

We query the GitHub Actions API for all runs of the five target workflows between November 1, 2025 and April 21, 2026. To avoid the GitHub API's 1,000-result cap on the general `/actions/runs` endpoint, we query per-workflow using the per-workflow endpoint (`/actions/workflows/{file}/runs`), which applies the cap independently per workflow.

For each run, we attempt to download the artifact named `agent` (post-April 1, 2026) or `agent-artifacts` (pre-April 1, 2026) and extract token usage using a three-tier fallback:

1. **`agent_usage.json`** (new format, April 1+): structured summary written by the API proxy, containing aggregate token fields and per-model breakdown.
2. **`agent-stdio.log` result line** (Claude only, any date): the Claude CLI in `--output-format stream-json` mode emits a final `{"type":"result","subtype":"success",...}` JSON line containing aggregate `usage` and `total_cost_usd`.
3. **`process-*.log`** (Copilot/OpenAI, old format): the Copilot CLI logs each API response in a multi-line debug format. We deduplicate by `Request-ID` header and sum unique calls.

Of 4,037 total runs queried, 2,836 (70.3%) yielded usable token records. Skipped runs were primarily cancelled or timed-out jobs with no artifact uploaded.

### 3.2 Workload Dataset

For all 622 runs using the new `agent` artifact format (April 1+), we additionally extract:

- **`gh_cli_calls`**: count of `exec_start` events in `cli-proxy-logs/access.log`, excluding meta-commands (e.g., `gh --version`).
- **`mcp_tool_calls`**: count of outgoing `tools/call` RPC messages in `mcp-logs/rpc-messages.jsonl`.
- **`squid_gh_calls`**: count of successful CONNECT tunnels to `api.github.com` or `github.com/graphql` in the Squid access log.

### 3.3 Token Field Normalization

Two token accounting conventions appear in the dataset, depending on provider:

**Anthropic (Claude)**: `input_tokens` is the count of *net non-cached* tokens (often 5–20 for heavily-cached runs). `cache_read_tokens` is a *separate* field—not included in `input_tokens`. Total context is:
```
context = input + cache_read + cache_write + output
cache_rate = cache_read / context
```

**OpenAI (Copilot/GPT)**: `input_tokens` is the *total* prompt size, inclusive of any cached prefix. `cache_read_tokens` is a subset of `input_tokens`, not additive. Total context is:
```
context = input + cache_write + output
cache_rate = cache_read / input
```

We detect the convention per-record using the heuristic `cache_read > input → Anthropic format`. This covers all cases in our dataset (Anthropic's net-non-cached `input` is always much smaller than `cache_read` when caching is active; OpenAI's cached portion never exceeds the total prompt).

All per-epoch statistics in this paper use the normalized `context_tokens` field.

### 3.4 Optimization Epochs

We define six *epochs* corresponding to the six optimization milestones merged to the repository during the study period:

| Epoch | Date | PR | Label | Description |
|---|---|---|---|---|
| 0 | 2026-04-01 | — | baseline | API proxy tracking enabled; no optimizations |
| 1 | 2026-04-03 | #1940 | sg-opt-1 | Security Guard: turn cap, relevance gate, prompt conciseness |
| 2 | 2026-04-12 | #1940 | sg-opt-2 | Security Guard: further turn cap tightening (−32%) |
| 3 | 2026-04-14 | #1974 | haiku-switch | Secret Digger: switch from Sonnet to Haiku |
| 4 | 2026-04-17 | #2065 | smoke-claude-haiku | Smoke Claude: Haiku model, tighter turn cap, narrower toolset |
| 5 | 2026-04-18 | #2085 | sg-cache-align | Security Guard: prompt cache alignment + smaller diff payloads |
| 6 | 2026-04-20 | #2113 | sg-relevance-gate | Security Guard: pre-run relevance gating |

Each run is assigned to the epoch of the most-recent milestone whose date is ≤ the run's creation date.

---

## 4. Optimization Techniques

We applied six distinct optimization techniques over the study period. We describe each and its mechanism.

### 4.1 Turn Budget Capping

Every agentic workflow has a configurable `max-turns` parameter that limits the number of agent turns (LLM API calls) per run. The default in `gh-aw` is 30. In epoch 1, Security Guard was capped at 12; in epoch 2, at 8. In epoch 4, Smoke Claude was capped at 5.

Mechanism: a turn cap directly limits the maximum context accumulation, since each successive turn appends the previous turn's output to the context. It also serves as a safety valve against runaway agents.

Trade-off: a cap that is too tight causes premature termination, producing incomplete analyses. We observed one case where Smoke Claude's cap was initially set too low (epoch 4: n=16 runs, several failing mid-task), requiring a subsequent increase (PR #2131).

### 4.2 Relevance Gating

Before invoking the full LLM analysis, a relevance gate performs a *deterministic pre-check* to determine whether the PR is relevant to the workflow's domain. For Security Guard, the gate runs `gh pr diff` and `gh pr view` to fetch the diff and title, then applies a heuristic regex to decide whether any security-sensitive files were changed. If not, the agent exits immediately without making any LLM API calls.

Mechanism: eliminates token consumption entirely for irrelevant inputs. For a security review workflow triggered on every PR—including documentation updates, CI config tweaks, and test data—a large fraction of runs are genuinely irrelevant and benefit from immediate exit.

Trade-off: false negatives (relevant PRs incorrectly gated out) are a quality risk. The regex is intentionally conservative (erring toward allowing the agent to run).

### 4.3 Model Selection

In epoch 3, Secret Digger switched from `claude-sonnet-4-6` to `claude-haiku-4-5` for its primary threat-detection pass. Haiku is a smaller, faster, cheaper model in the Claude family. In epoch 4, Smoke Claude also switched to Haiku.

Mechanism: Haiku has a smaller output token budget per turn and tends to produce more concise responses, which reduces both output tokens and downstream context accumulation. The per-token cost is also lower (approximately 5× cheaper per input token at list price).

Trade-off: smaller models may produce lower-quality analyses. For well-scoped tasks with clear ground truth (does this code contain secrets? does this smoke test complete?), the quality difference is acceptable.

### 4.4 Prompt Cache Alignment

Anthropic's prompt caching feature caches the leading prefix of the system prompt across consecutive API calls, amortizing its cost over a session. To maximize cache hits, the cacheable prefix must be *stable*: any dynamic content (PR number, diff content, timestamp) must appear after the cache boundary.

In epoch 5, Security Guard's prompt was restructured so that all dynamic content (the PR diff, the PR title, the list of changed files) appears after a `cache_control: {"type":"ephemeral"}` boundary. The static system prompt (~40 KB of security analysis instructions) is cached once and reused across all turns of the session and across consecutive runs on the same base commit.

Mechanism: reduces effective input tokens per turn from the full system prompt size to only the dynamic content size. In the Security Guard context, this cut effective input from ~40 K tokens to ~200 tokens on cache hits.

Trade-off: requires careful prompt engineering. Any accidental static content after dynamic content wastes the cache prefix.

### 4.5 Toolset Narrowing

In epoch 4, Smoke Claude's tool configuration was narrowed: several MCP server tools that were available but rarely used (e.g., `create_issue`, `list_labels`) were removed from the manifest. This reduces the tools section of the system prompt, which is included in every turn's context.

Mechanism: the tools section of an MCP-enabled agent prompt can be 5–15 KB of JSON schema. Removing unused tools directly trims this from every input.

Trade-off: agents that need a removed tool will fail. Toolset narrowing requires careful analysis of which tools are actually called in production.

### 4.6 CLI-Proxy Migration (MCP → gh-CLI)

Over the study period, several operations previously performed via MCP server tool calls were migrated to `gh` CLI subprocess calls. For example, fetching a PR's diff was changed from `mcp.get_pull_request_diff(pr_number)` to `gh pr diff <number>`. The `gh` call is routed through the CLI proxy (deterministic, no LLM involved) rather than through an LLM tool call (which requires an additional API round-trip and consumes tokens for the tool-use JSON schema and response).

Mechanism: GitHub read operations are deterministic—the result is always the same regardless of which execution path is used. Replacing them with subprocess calls eliminates the LLM API round-trip entirely for data-fetching operations.

Trade-off: requires rewriting workflow prompts to use bash/CLI idioms instead of MCP tool calls. The agent must be instructed to use `gh` rather than its MCP tools, which can require prompt iteration.

---

## 5. Results

### 5.1 Overall Token Reduction

Table 1 shows overall median context tokens per run across all workflows, by epoch.

**Table 1: Overall epoch summary (all workflows combined)**

| Epoch | Label | n | Median ctx | p25 | p75 | Cache% | Δ vs E0 | Avg cost |
|---|---|---|---|---|---|---|---|---|
| 0 | baseline | 135 | 196.7 K | 78.7 K | 310.5 K | 71% | — | $0.49 |
| 1 | sg-opt-1 | 396 | 180.8 K | 124.9 K | 226.9 K | 73% | −8.1% | $0.32 |
| 2 | sg-opt-2 | 57 | 177.5 K | 143.5 K | 229.2 K | 78% | −9.7% | — |
| 3 | haiku-switch | 83 | 180.0 K | 146.0 K | 226.7 K | 75% | −8.5% | — |
| 4 | smoke-claude-haiku | 39 | 175.7 K | 134.7 K | 228.6 K | 77% | −10.7% | — |
| 5 | sg-cache-align | 46 | 166.2 K | 126.5 K | 245.2 K | 78% | −15.5% | — |
| 6 | sg-relevance-gate | 74 | 159.5 K | 116.0 K | 178.7 K | 79% | **−18.9%** | — |

Median context fell monotonically from 196.7 K to 159.5 K over the 20-day period. Cache hit rate climbed from 71% to 79%, reflecting the prompt cache alignment work in epoch 5.

The p75–p25 interquartile range also narrowed substantially: from 231.8 K at baseline to 62.7 K at epoch 6. This compression of the distribution reflects the relevance gate eliminating high-token outlier runs (irrelevant PRs previously consumed a full Security Guard analysis).

### 5.2 Per-Workflow Results

**Security Guard** showed the most dramatic reduction. Table 2 shows its per-epoch trajectory.

**Table 2: Security Guard per-epoch context tokens**

| Epoch | n | Median ctx | Δ vs E0 | Notes |
|---|---|---|---|---|
| 0 | 42 | 330.4 K | — | Baseline |
| 1 | 106 | 214.9 K | −35.0% | Turn cap (12) + conciseness |
| 2 | 16 | 140.0 K | −57.6% | Turn cap tightened to 8 |
| 3 | 22 | 171.3 K | −48.2% | Context growth, no SG-specific change |
| 4 | 7 | 150.1 K | −54.6% | — |
| 5 | 12 | 328.7 K | −0.5% | Cache alignment in progress (transition) |
| 6 | 7 | 168.1 K | **−49.1%** | Relevance gate live |

The epoch 5 anomaly (328.7 K, near baseline) is explained by the cache alignment migration: during the transition period, runs that hit the old prompt structure did not benefit from caching, temporarily inflating context. Epoch 6 settled at 168.1 K (−49.1%) after the cache alignment was stable and the relevance gate was deployed.

**Smoke Copilot** showed a steady, monotonic decline from epoch 3 onward (Table 3). Epochs 1–2 lack LLM-call tracking due to the old artifact format.

**Table 3: Smoke Copilot per-epoch results**

| Epoch | n | Median ctx | LLM calls | gh_cli | MCP | tok/call |
|---|---|---|---|---|---|---|
| 1 | 81 | 157.3 K | — | 0 | 15 | — |
| 2 | 19 | 147.1 K | — | 0 | 2 | — |
| 3 | 30 | 147.0 K | 5.0 | 0 | 2 | 30.6 K |
| 4 | 15 | 147.2 K | 5.0 | 2 | 2 | 27.6 K |
| 5 | 17 | 126.0 K | 5.0 | 2 | 2 | 25.4 K |
| 6 | 33 | 114.9 K | 5.0 | 2 | 2 | **23.6 K** |

Smoke Copilot's reduction is noteworthy because it is *purely efficiency*: LLM call count is stable at 5, total GitHub operations (gh_cli + MCP) are stable at 4, yet context per LLM call fell by **23%** (30.6 K → 23.6 K). This reduction is attributable to cache alignment improvements that reduced the effective system prompt size across successive turns.

**Smoke Claude** exhibited an unusual U-shape (Table 4).

**Table 4: Smoke Claude per-epoch context tokens**

| Epoch | n | Median ctx | LLM calls | Δ vs E0 |
|---|---|---|---|---|
| 0 | 48 | 196.8 K | — | — |
| 1 | 130 | 225.2 K | — | +14.4% |
| 2 | 17 | 224.8 K | — | +14.2% |
| 3 | 29 | 226.5 K | 4.0 | +15.1% |
| 4 | 16 | 183.5 K | 4.0 | −6.8% |
| 5 | 15 | 166.3 K | 4.0 | −15.5% |
| 6 | 32 | 169.0 K | 4.0 | **−14.1%** |

Context *increased* in epochs 1–3 before falling in epochs 4–6. The workload data explains this: at epoch 1, Smoke Claude ran 9 LLM turns on average (vs. 4 in epoch 4+). The additional turns were due to a more exploratory prompt that had the agent verify its output through multiple tool calls. The turn cap introduced in epoch 4 (max-turns = 5) directly caused the drop. The later reduction is both fewer turns and cheaper turns (Haiku model, narrower toolset).

**Secret Digger** (Table 5) showed no significant change across the study period, as no optimizations were targeted at it after the initial Haiku switch in epoch 3.

**Table 5: Secret Digger per-epoch context tokens**

| Epoch | n | Median ctx | Δ vs E0 |
|---|---|---|---|
| 0 | 45 | 78.4 K | — |
| 1 | 72 | 78.3 K | 0.0% |

Secret Digger serves as an internal control: its stability across epochs (despite repo-wide changes) validates that our epoch-labeling and normalization methodology does not introduce spurious trends.

### 5.3 Workload-Normalized Analysis

A key question for any token efficiency campaign is: **are tokens falling because work is cheaper, or because less work is done?** Table 6 summarizes the mechanism for each workflow's reduction.

**Table 6: Reduction mechanism attribution**

| Workflow | Total reduction | Mechanism | Work change |
|---|---|---|---|
| Security Guard | −49.1% | Turn cap + relevance gate + cache alignment | Less work (gate) + cheaper turns (cache) |
| Smoke Copilot | −27% (vs. epoch 3) | Cache alignment + cli-proxy migration | Same work, fewer tokens/call |
| Smoke Claude | −14.1% | Turn cap + model switch + toolset narrowing | Less work (cap) + cheaper per turn (Haiku) |
| Secret Digger | 0% | No optimization | Unchanged |

The most practically important result is from Smoke Copilot: **a 23% reduction in tokens per LLM call with no reduction in work done**. This represents pure efficiency—the agent completes the same task (end-to-end smoke test, PR creation, verification) with fewer tokens consumed on each API call. This is attributable to prompt cache alignment.

### 5.4 MCP-to-CLI Migration

Figure 1 (described in text) shows the migration of GitHub API operations from MCP server tool calls to deterministic `gh`-CLI subprocess calls across epochs.

The most dramatic migration is in **Smoke Copilot**: median MCP tool calls dropped from **15 per run** (epoch 1) to **2 per run** (epoch 2), coinciding with a workflow update that replaced 13 MCP `list_*` and `get_*` operations with a single `gh pr view --json` call that returns structured data in one subprocess invocation. Total context tokens dropped correspondingly (157.3 K → 147.1 K, −6.4%).

In **Security Guard**, the migration happened later (epoch 4→5): MCP calls dropped from 8 to 1, and gh_cli calls rose from 0 to 5. This coincided with the cache alignment work, which required restructuring how the PR diff is fetched (from MCP `get_pull_request_diff` to `gh pr diff`). The MCP server's tool call adds a full tools-schema JSON block (~5 KB) to each turn's context; replacing 7 such calls saves ~35 KB of tool-schema context per run.

In **Smoke Claude**, the migration was more gradual: gh_cli calls rose from 0 (epochs 0–4) to 1 (epochs 5–6), while MCP calls fell from 6 to 3. The partial migration accounts for approximately 3 K tokens of context reduction per turn.

### 5.5 Cache Hit Rate Evolution

Cache hit rate improved from 71% at baseline (epoch 0) to 79% at epoch 6. The most significant jump (+5 percentage points) occurred at epoch 5 (sg-cache-align), which is when Security Guard's system prompt was restructured for cache alignment.

Importantly, cache hit rate and context size are not perfectly correlated. Epoch 2 showed high cache hit rate (78%) while context was already declining—because the turn cap reduced the number of uncached continuation turns. Epoch 3 (haiku-switch) briefly lowered cache rate (75%) because Haiku uses a different cache key than Sonnet, invalidating previously built cache entries.

### 5.6 Cost Analysis

Of the 2,836 runs in the dataset, 2,234 (78.8%) had cost data available. Total cost across these runs was \$962.98, an average of \$0.43/run.

At epoch 0 (baseline), average cost was \$0.49/run. The first significant cost reduction came at epoch 1, where average cost fell to \$0.32/run (−34.7%). This large cost drop relative to the 8.1% context reduction reflects two effects: (1) the Haiku model's lower per-token price applied to Secret Digger runs in the same epoch window; and (2) cost is driven more by output tokens and cache miss tokens than by total context, and the turn cap preferentially reduced output-heavy turns.

Projecting the 18.9% context reduction to the pre-study cost basis of \$0.49/run: the same run volume would cost approximately \$0.40/run, a saving of \$0.09/run. At the observed run volume of roughly 50 target workflow runs per day, this represents approximately \$4.50/day or ~\$1,600/year in direct API cost savings.

---

## 6. Discussion

### 6.1 The Two Regimes of Token Reduction

Our workload-normalized analysis reveals a fundamental distinction that is often elided in token efficiency discussions:

**Regime 1: Efficiency** — the same work is done with fewer tokens. Mechanisms: prompt cache alignment, model selection, toolset narrowing, CLI migration. Observable as: stable LLM call count, stable GitHub operation count, declining tokens-per-call. Smoke Copilot is the cleanest example in our dataset (5 LLM calls, 4 GitHub ops, across epochs 3–6; tokens per call fell from 30.6 K to 23.6 K).

**Regime 2: Scope reduction** — less work is done. Mechanisms: turn-budget capping, relevance gating. Observable as: declining LLM call count, declining total GitHub operations, possibly unchanged tokens-per-call. Security Guard's epoch-6 relevance gate is the clearest example: LLM calls fell from 8 to 4, MCP calls fell from 8 to 1, for irrelevant PRs the agent exits after 2 gh CLI calls (pr view + pr diff) with no LLM invocation at all.

Both regimes are valuable, but they have different quality implications. Regime 1 reductions are safe: quality is preserved by construction. Regime 2 reductions require careful validation that the scope reduction is *correct*—that irrelevant PRs are truly irrelevant, that the capped agent actually finishes its task within the budget.

### 6.2 The Role of the API Proxy

The API proxy's token tracking was indispensable for this analysis. Without it, we would have relied on application-level logs (which are incomplete for old runs, unavailable for Copilot CLI, and require agent-code instrumentation), or on provider billing APIs (which aggregate across all workloads and don't preserve per-run granularity).

The proxy's interception approach—inserting a credential-injection sidecar that records every upstream call—works regardless of which AI provider or agent framework is used. The same AWF setup that runs Claude CLI, Copilot CLI, and Codex CLI all writes to the same `token-usage.jsonl` format.

An important limitation is that the proxy only sees calls that flow through it. Calls made by the agent to GitHub's API (via MCP server or `gh` CLI) are not captured in `token-usage.jsonl`; they appear in the Squid access log and cli-proxy log respectively. Our workload augmentation pipeline (§3.2) connects these separate data sources.

### 6.3 Prompt Caching Dynamics

A counterintuitive finding is that prompt caching, while generally beneficial, interacts poorly with model switches. When Security Guard migrated from Sonnet to Haiku (epoch 3), the new model's cache was cold: previously built cache entries are not shared across models. This caused a temporary increase in cache miss tokens until the Haiku cache warmed up (typically 2–3 runs per PR base commit).

Similarly, the cache alignment migration (epoch 5) initially *increased* context for runs that had already built a cache under the old prompt structure, since the new structure invalidated those entries. This explains the epoch 5 anomaly for Security Guard (Table 2), where median context briefly returned to near-baseline levels before falling again in epoch 6.

Practitioners should plan for a cache warm-up period of several runs after any model change or significant prompt restructuring.

### 6.4 Limitations

**Sample size**: Some epoch/workflow cells have small n (e.g., Security Guard epoch 6 has n=7). Medians from small samples are noisy. Our conclusions rely on cross-validation across multiple epochs and the workload data.

**Workload coverage**: The workload augmentation dataset (§3.2) only covers the 622 new-format runs (April 1+). Epochs 0–2 lack LLM call counts and tok/call measurements. The baseline comparison for tok/call relies on epoch 3 as the effective baseline for most comparisons.

**External validity**: All data is from a single repository (gh-aw-firewall). The optimization techniques are general, but the magnitudes of reduction will vary with the specific task, model, and context structure of other deployments.

**Cost data gap**: Cost data is available for epoch 0 and epoch 1 only (from the two artifact formats that include `total_cost_usd`). Cost comparisons across all epochs rely on extrapolation from token counts and published list prices.

---

## 7. Related Work

**Token efficiency in LLM systems.** Prompt compression [Jiang et al., 2023] and context pruning [Chevalier et al., 2023] have been studied as general techniques, but focus on static prompt optimization rather than production measurement. Our work is distinguished by its empirical, production-measurement focus and the workload-normalization methodology.

**Agentic systems.** ReAct [Yao et al., 2022] and Toolformer [Schick et al., 2023] established the paradigm of LLM-plus-tools reasoning. SWE-bench [Jimenez et al., 2023] and similar benchmarks measure task completion but not token efficiency. Our work measures efficiency in live CI deployment rather than synthetic benchmarks.

**Cost measurement.** Cloud cost optimization is well-studied, but LLM API cost optimization for production agents is nascent. LLMCost [He et al., 2024] studied cost modeling for chatbots; our work is the first (to our knowledge) to measure cost reduction across optimization epochs in agentic coding workflows.

**Security and sandboxing.** Our sandbox design follows the principle of least privilege [Saltzer & Schroeder, 1975] applied to AI agents. CodeShield [Bhatt et al., 2023] and similar work focus on output filtering; AWF focuses on egress control during execution.

---

## 8. Conclusion

We measured token consumption across 2,836 agentic workflow runs over a 20-day optimization campaign, applying six techniques: turn-budget capping, relevance gating, model selection, prompt cache alignment, toolset narrowing, and MCP-to-CLI migration. Overall median context tokens fell by 18.9%, with the most optimized workflow achieving 49.1%. A workload-normalized analysis, enabled by per-run tracking of LLM calls, MCP tool calls, and gh-CLI subprocess calls, revealed that different techniques occupy fundamentally different regimes: efficiency (same work, fewer tokens) vs. scope reduction (less work done). Smoke Copilot exemplifies the efficiency regime—a 23% reduction in tokens per LLM call with identical workload across epochs 3–6. Security Guard exemplifies scope reduction—a relevance gate that exits without any LLM call for irrelevant PRs.

The AWF system's API proxy sidecar provides continuous, agent-framework-agnostic token measurement as a first-class CI artifact. We make the data collection and analysis scripts publicly available at github.com/github/gh-aw-firewall (branch: `token-efficiency-paper`).

---

## Appendix A: Dataset Statistics

| Metric | Value |
|---|---|
| Total runs queried | 4,037 |
| Runs with usable token data | 2,836 (70.3%) |
| Runs with workload augmentation | 622 |
| Date range | Nov 2025 – Apr 2026 |
| Total LLM API cost sampled | \$962.98 |
| Workflows | 5 |
| Providers | Anthropic, OpenAI |
| Models | Haiku-4.5, Sonnet-4.5, Sonnet-4.6, Opus-4.6 |

## Appendix B: Epoch Commit References

| Epoch | PR | Merged | Key change |
|---|---|---|---|
| 1 | #1940 | 2026-04-03 | Security Guard turn cap + relevance gate prototype |
| 2 | #1940 | 2026-04-12 | Turn cap tightened to 8 |
| 3 | #1974 | 2026-04-14 | Secret Digger → Haiku |
| 4 | #2065 | 2026-04-17 | Smoke Claude → Haiku + turn cap |
| 5 | #2085 | 2026-04-18 | Security Guard prompt cache alignment |
| 6 | #2113 | 2026-04-20 | Security Guard relevance gating |
