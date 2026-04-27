---
description: Daily advisor that analyzes the repository for opportunities to add, enhance, or improve agentic workflows based on Pelis Agent Factory patterns
on:
  schedule: daily
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
  discussions: read
tools:
  agentic-workflows:
  bash:
    - "cat"
    - "find"
    - "ls"
    - "grep"
  cache-memory: true
  github:
    toolsets: [context]
network:
  allowed:
    - "github.github.io"

safe-outputs:
  threat-detection:
    enabled: false
  create-discussion:
    title-prefix: "[Pelis Agent Factory Advisor] "
    category: "general"
timeout-minutes: 30
steps:
  - name: Fetch Pelis Agent Factory Docs
    id: fetch-docs
    run: |
      set -o pipefail
      BASE="https://github.github.io/gh-aw"
      OUTFILE="${GITHUB_WORKSPACE}/.pelis-agent-factory-docs.txt"
      : > "$OUTFILE"
      for PATH_SUFFIX in \
        "/blog/2026-01-12-welcome-to-pelis-agent-factory/" \
        "/introduction/overview/" \
        "/guides/workflow-patterns/" \
        "/guides/best-practices/"; do
        echo "### ${BASE}${PATH_SUFFIX}" >> "$OUTFILE"
        curl -sf "${BASE}${PATH_SUFFIX}" \
          | python3 -c "import sys,html,re;t=sys.stdin.read();print(html.unescape(re.sub('<[^>]+>','',t))[:3500])" \
          >> "$OUTFILE" 2>/dev/null \
          || echo "(not found)" >> "$OUTFILE"
        echo "" >> "$OUTFILE"
      done
  - name: Fetch Agentics Patterns
    id: fetch-agentics
    run: |
      set -o pipefail
      curl -sf "https://raw.githubusercontent.com/githubnext/agentics/main/README.md" \
        | head -c 4000 > "${GITHUB_WORKSPACE}/.agentics-patterns.txt" \
        || echo "(not available)" > "${GITHUB_WORKSPACE}/.agentics-patterns.txt"
  - name: Compute Content Hashes
    id: content-hashes
    run: |
      {
        sha256sum "${GITHUB_WORKSPACE}/.pelis-agent-factory-docs.txt"
        sha256sum "${GITHUB_WORKSPACE}/.agentics-patterns.txt"
      } | sha256sum | cut -d' ' -f1 > "${GITHUB_WORKSPACE}/.content-hash.txt"
  - name: Summarize Existing Workflows
    id: workflow-summaries
    run: |
      {
        echo "# Workflow Summaries (name | description | triggers)"
        find .github/workflows -name "*.md" -type f | sort | while IFS= read -r f; do
          name=$(basename "$f" .md)
          desc=$(grep -m1 "^description:" "$f" 2>/dev/null | sed 's/^description: *//' | cut -c1-100)
          triggers=$(grep -E "^  (schedule|workflow_dispatch|pull_request|push|issues|workflow_run|issue_comment):" "$f" 2>/dev/null \
            | sed 's/^  //' | tr -d ':' | tr '\n' ',' | sed 's/,$//')
          printf "%-45s | %-100s | %s\n" "$name" "${desc:-(no description)}" "${triggers:-(none)}"
        done
      } > "${GITHUB_WORKSPACE}/.workflow-summaries.txt"
  - name: Collect Repo Structure
    id: repo-structure
    run: |
      {
        echo "=== Root files ==="
        ls -la
        echo ""
        echo "=== Tests ==="
        ls -la tests/ 2>/dev/null || echo "(no tests/)"
        echo ""
        echo "=== Scripts ==="
        ls -la scripts/ 2>/dev/null || echo "(no scripts/)"
      } > "${GITHUB_WORKSPACE}/.repo-structure.txt"
---

# Pelis Agent Factory Advisor

You are an expert advisor on agentic workflows specializing in Pelis Agent Factory patterns. Your mission: identify the top opportunities to add, enhance, or improve agentic workflows in this repository.

> **Batch all independent operations into a single turn.** Never read files one at a time when you can read them in parallel.

## Phase 1: Learn Patterns (cache-gated)

**First turn**: read `.content-hash.txt` and `.workflow-summaries.txt` in parallel (both are always read on every run).

Compare `.content-hash.txt` to cached `pelis_docs_hash` in cache-memory.
- **Cache hit** (hash unchanged): skip reading doc files; use cached patterns and proceed directly to Phase 2.
- **Cache miss**: read `.pelis-agent-factory-docs.txt` and `.agentics-patterns.txt` in a single parallel batch, then update `pelis_docs_hash` and store a bullet-point summary of key patterns in cache-memory (`pelis_patterns_summary`).

Key things to extract from docs: workflow templates, safe-outputs patterns, caching strategies, permission models, integration patterns.

## Phase 2: Analyze Repository

All repository context is pre-computed — avoid reading individual workflow files unless you need specific configuration details.

**In one turn**, do all of the following in parallel:
1. `agentic-workflows status` — check recent run health
2. `agentic-workflows audit` — check security/config issues
3. `bash:cat .repo-structure.txt` — root files, tests, scripts

The pre-computed `.workflow-summaries.txt` (read in Phase 1 first turn) gives you a one-line inventory of every workflow (name | description | triggers). Use it as your primary inventory — **do not read individual workflow `.md` files** unless a specific recommendation requires detailed configuration review.

Assess automation coverage: what triggers exist, what's missing, where there are gaps.

## Phase 3: Identify Opportunities

Identify top opportunities across these categories (focus on highest value for a security/firewall tool):

- **Missing workflows**: security automation, test quality, release automation, documentation, monitoring
- **Enhancement opportunities**: caching, triggers, tool utilization, error handling
- **Integration opportunities**: chaining workflows, shared state, event-driven patterns

For each opportunity: Impact (H/M/L) · Effort (H/M/L) · Risk (H/M/L).
Priority: P0=High impact+Low effort, P1=High impact+Medium effort, P2=Medium, P3=Nice-to-have.

## Phase 4: Report

Create a discussion using `create_discussion` with:

1. **📊 Executive Summary** — 2–3 sentences on maturity and top opportunities
2. **📋 Workflow Inventory** — Table from `.workflow-summaries.txt`: `| Workflow | Purpose | Trigger | Assessment |`
3. **🚀 Recommendations** — Grouped P0→P3, each with: What / Why / How / Effort
4. **📈 Maturity Assessment** — Current/Target level (1–5), gap analysis
5. **📝 Cache Update** — Update cache-memory with observed patterns and items to track next run

## Guidelines

- Specific and actionable — every recommendation must be implementable
- Security-focused — this is a firewall tool; prioritize security-relevant automations
- Ruthlessly prioritize — top 5 wins over exhaustive lists
- Use cached knowledge — avoid re-reading docs and files already summarized