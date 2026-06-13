---
name: Firewall Issue Dispatcher
description: Audits github/gh-aw issues labeled 'awf' and creates tracking issues in gh-aw-firewall with proposed solutions

on:
  schedule: every 12h
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read

max-turns: 10
max-ai-credits: 100

jobs:
  fetch-awf-issues:
    runs-on: ubuntu-slim
    permissions:
      contents: read
    steps:
      - name: Fetch open awf issues from github/gh-aw
        env:
          GH_TOKEN: ${{ secrets.GH_AW_CROSS_REPO_PAT }}
        run: |
          mkdir -p "${{ runner.temp }}/awf-data"
          gh api graphql -f query='
            query {
              repository(owner: "github", name: "gh-aw") {
                issues(labels: ["awf"], states: [OPEN], first: 50) {
                  nodes {
                    number
                    title
                    body
                    url
                    comments(first: 10) {
                      nodes { author { login } body }
                    }
                  }
                }
              }
            }
          ' > "${{ runner.temp }}/awf-data/awf-issues.json"
      - uses: actions/upload-artifact@v7
        with:
          name: awf-issues-${{ github.run_id }}
          path: ${{ runner.temp }}/awf-data/awf-issues.json
          retention-days: 1

if: needs['fetch-awf-issues'].result == 'success'

sandbox:
  agent:
    id: awf

steps:
  - uses: actions/download-artifact@v8
    with:
      name: awf-issues-${{ github.run_id }}
      path: /tmp/gh-aw/data

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

## Step 1: Load Pre-Fetched Data

All issue data has been pre-fetched for you. Read the file at `/tmp/gh-aw/data/awf-issues.json`. This contains all open `awf` issues with their first 10 comments. Do **not** run any GraphQL or API commands — all needed data is already in that file.

## Step 2: Filter Locally

For each issue found, read its comments and check whether any comment contains a reference to a `github/gh-aw-firewall` issue (i.e., a URL matching `https://github.com/github/gh-aw-firewall/issues/` or a GitHub cross-repo reference matching `github/gh-aw-firewall#`). If such a comment exists, **skip** that issue — it has already been audited. Do this filtering in your analysis — do NOT make additional API calls.

If no unprocessed issues remain, call `noop` and stop.

## Step 3: Create Tracking Issues

For each **unprocessed** issue:

1. **Create a tracking issue in `github/gh-aw-firewall`** using the `create_issue` safe output with:
   - Title: `[awf] <component>: <summary>`
   - Body: **Problem**, **Context** (link to original), **Root Cause**, **Proposed Solution** — keep to 200 words maximum
   - Labels: `awf-triage`

2. **Comment on the original `github/gh-aw` issue** linking to the newly created tracking issue. Use this exact format:
   > 🔗 AWF tracking issue: https://github.com/github/gh-aw-firewall/issues/{NUMBER}

   `create_issue` may return a reference like `github/gh-aw-firewall#2159`. Extract only the trailing digits before composing the URL.
   - Valid: `https://github.com/github/gh-aw-firewall/issues/2159`
   - Invalid: `https://github.com/github/gh-aw-firewall/issues/github/gh-aw-firewall#2159`
   - Invalid: `https://github.com/github/gh-aw-firewall/issues/#2159`

   Use the `add_comment` safe output tool with `repo: "github/gh-aw"` and the original issue number.

### 4. Report Results

Report: issues found, skipped (already audited), tracking issues created.

## Guidelines

- **Be specific and actionable** — reference source files and functions.
- **One tracking issue per gh-aw issue** — do not combine.
- **Propose real solutions** — not just "investigate this."
- **No extra reads** — do not open `AGENTS.md`, source files, or any workspace files; all needed context is in `/tmp/gh-aw/data/awf-issues.json`.
- **Don't retry without diagnosing** — analyze the error before retrying any failed tool call.