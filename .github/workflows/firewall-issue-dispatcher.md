---
name: Firewall Issue Dispatcher
description: Audits github/gh-aw issues labeled 'awf' and creates tracking issues in gh-aw-firewall with proposed solutions

on:
  schedule: every 6h
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

features:
  cli-proxy: true

tools:
  github:
    toolsets: [default]
    allowed-repos: ["github/gh-aw", "github/gh-aw-firewall"]
    min-integrity: none
    github-token: ${{ secrets.GH_AW_CROSS_REPO_PAT }}

safe-outputs:
  threat-detection:
    enabled: false
  github-token: ${{ secrets.GH_AW_CROSS_REPO_PAT }}
  create-issue:
    max: 10
    labels: [awf-triage]
  add-comment:
    max: 10
    target: "*"
    allowed-repos: ["github/gh-aw"]
---

# Firewall Issue Dispatcher

You audit open issues in `github/gh-aw` that have the `awf` label and create corresponding tracking issues in `github/gh-aw-firewall` with a detailed problem description and proposed solution.

## Step-by-Step Process

### 1. List AWF-Labeled Issues

Search for all **open** issues in `github/gh-aw` with the label `awf`.

### 2. Filter Out Already-Audited Issues

For each issue found, read its comments and check whether any comment contains a reference to a `github/gh-aw-firewall` issue (i.e., a URL matching `https://github.com/github/gh-aw-firewall/issues/` or a GitHub cross-repo reference matching `github/gh-aw-firewall#`). If such a comment exists, **skip** that issue — it has already been audited.

### 3. Analyze and Create Tracking Issues

For each **unprocessed** issue:

1. **Read the issue thoroughly** — title, body, labels, and all comments — to fully understand the problem.

2. **Determine AWF relevance** — identify how this issue relates to the firewall. Consider the AWF architecture:
   - **Squid proxy** (`src/squid-config.ts`) — domain ACL filtering, HTTP/HTTPS egress control
   - **Docker orchestration** (`src/docker-manager.ts`) — container lifecycle, environment variable injection, volume mounts
   - **Agent container** (`containers/agent/entrypoint.sh`) — chroot, iptables, DNS config, capability management
   - **API proxy sidecar** (`containers/api-proxy/server.js`) — credential injection, GHEC/GHES support
   - **CLI** (`src/cli.ts`) — flag parsing, configuration, domain allowlisting
   - **iptables** (`containers/agent/setup-iptables.sh`) — network isolation, port blocking, DNAT rules

3. **Create a new issue in `github/gh-aw-firewall`** with:
   - A clear, specific title starting with `[awf]` followed by a summary of the AWF-side problem (prefix with the relevant component, e.g., "[awf] agent-container: ..." or "[awf] squid: ...")
   - A body containing:
     - **Problem** section: What is broken or missing, from the firewall's perspective
     - **Context** section: Link to the original `github/gh-aw` issue
     - **Root Cause** section (if determinable): Which files/components are involved
     - **Proposed Solution** section: A concrete, actionable fix or investigation path
   - Use the `create_issue` safe output tool

4. **Comment on the original `github/gh-aw` issue** linking to the newly created tracking issue. Use this exact format:

   > 🔗 AWF tracking issue: https://github.com/github/gh-aw-firewall/issues/{NUMBER}

   where `{NUMBER}` is replaced with **only the numeric issue number** (e.g., `1896`). Do NOT include the repository name, hash symbols, or any other text — just the number in the URL path. Use the `add_comment` safe output tool with `repo: "github/gh-aw"` and the original issue number.

### 4. Report Results

After processing all issues, summarize what was done:
- How many `awf`-labeled issues were found
- How many were skipped (already audited)
- How many new tracking issues were created
- If there were no unprocessed issues, report that all `awf`-labeled issues have been audited

## Guidelines

- **Be specific and actionable** — vague issue descriptions waste engineer time. Reference specific source files and functions.
- **One tracking issue per gh-aw issue** — do not combine multiple gh-aw issues into a single tracking issue.
- **Don't duplicate** — if you're unsure whether an issue was already audited, err on the side of skipping.
- **Propose real solutions** — not just "investigate this." Suggest which code to change and how.
