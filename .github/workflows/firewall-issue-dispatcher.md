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
    toolsets: [issues]
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

You audit open issues in `github/gh-aw` labeled `awf` and create tracking issues in `github/gh-aw-firewall`.

## Step 1: Batch Fetch All Data (ONE command)

Run this single `gh` command to get all open `awf` issues with their comments:

```bash
gh api graphql -f query='
  query {
    repository(owner: "github", name: "gh-aw") {
      issues(labels: ["awf"], states: [OPEN], first: 50) {
        nodes {
          number
          title
          body
          url
          labels(first: 10) { nodes { name } }
          comments(first: 100) {
            nodes { author { login } body }
          }
        }
      }
    }
  }
'
```

## Step 2: Filter Locally

For each issue found, read its comments and check whether any comment contains a reference to a `github/gh-aw-firewall` issue (i.e., a URL matching `https://github.com/github/gh-aw-firewall/issues/` or a GitHub cross-repo reference matching `github/gh-aw-firewall#`). If such a comment exists, **skip** that issue — it has already been audited. Do this filtering in your analysis — do NOT make additional API calls.

If no unprocessed issues remain, call `noop` and stop.

## Step 3: Create Tracking Issues

For each **unprocessed** issue:

1. **Create a tracking issue in `github/gh-aw-firewall`** using the `create_issue` safe output with:
   - Title: `[awf] <component>: <summary>`
   - Body: **Problem**, **Context** (link to original), **Root Cause**, **Proposed Solution**
   - Labels: `awf-triage`
   - Reference specific source files. See `AGENTS.md` for component descriptions.

2. **Comment on the original `github/gh-aw` issue** linking to the newly created tracking issue. Use this exact format:
   > 🔗 AWF tracking issue: https://github.com/github/gh-aw-firewall/issues/{NUMBER}

   where `{NUMBER}` is replaced with **only the numeric issue number** (e.g., `1896`). Do NOT include the repository name, hash symbols, or any other text — just the number in the URL path. Use the `add_comment` safe output tool with `repo: "github/gh-aw"` and the original issue number.

## Step 4: Summarize

Report: issues found, skipped (already audited), tracking issues created.

## Guidelines

- **Be specific and actionable** — reference source files and functions.
- **One tracking issue per gh-aw issue** — do not combine.
- **Propose real solutions** — not just "investigate this."
