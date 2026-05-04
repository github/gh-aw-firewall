---
name: Refactoring PR Creator
description: |
  Finds open issues with "[Refactoring]" in the title and assigns each one to the
  Copilot coding agent to create a pull request addressing the refactoring opportunity.
  Caps at 3 assignments per run to avoid overwhelming the codebase with concurrent changes.

on:
  workflow_dispatch:
  schedule: daily
  skip-if-no-match: 'is:issue is:open in:title "[Refactoring]"'
  skip-if-match:
    query: "is:pr is:open is:draft author:app/copilot-swe-agent"
    max: 5

permissions:
  contents: read
  issues: read
  pull-requests: read

sandbox:
  agent:
    version: v0.25.29

tools:
  github:
    mode: gh-proxy
    toolsets: [issues, pull_requests]
  bash: ["*"]

safe-outputs:
  threat-detection:
    enabled: false
  assign-to-agent:
    name: "copilot"
    max: 3
    target: "*"
  add-comment:
    max: 3
    target: "*"

timeout-minutes: 20
---

# Refactoring PR Creator

You find open issues titled `[Refactoring]` in `${{ github.repository }}` that don't already
have an open PR, and assign each qualifying issue to the Copilot coding agent so it creates
a pull request addressing the refactoring.

## Step 1: Find All Open Refactoring Issues

```bash
gh issue list \
  --search 'in:title "[Refactoring]" is:open' \
  --limit 50 \
  --json number,title,assignees,url \
  | tee /tmp/refactoring-issues.json
```

## Step 2: Find Open Copilot PRs Already Linked to These Issues

```bash
# List open draft PRs by Copilot to detect issues already in-progress
gh pr list \
  --author "app/copilot-swe-agent" \
  --state open \
  --limit 50 \
  --json number,title,body,headRefName \
  | tee /tmp/copilot-prs.json
```

## Step 3: Filter Qualifying Issues

For each issue from Step 1, skip it if ANY of the following is true:

- The issue is already **assigned** to `copilot` or `copilot-swe-agent`
- There is already an open PR (from Step 2) whose body contains `#<issue-number>` or
  `Fixes #<issue-number>` or `Closes #<issue-number>` or `Resolves #<issue-number>`

After filtering, take **at most 3** issues from the top of the list (preserve original order).

If the filtered list is empty, call `noop` with the message
`"All [Refactoring] issues already have open PRs or are assigned to Copilot."` and stop.

## Step 4: Assign Each Qualifying Issue to Copilot

For each issue in the filtered list:

1. **Assign to Copilot** using the `assign_to_agent` safe-output tool:

   ```
   safeoutputs/assign_to_agent(issue_number=<issue_number>, agent="copilot")
   ```

2. **Comment on the issue** using the `add_comment` safe-output tool to inform watchers:

   ```
   safeoutputs/add_comment(
     item_number=<issue_number>,
     body="🤖 **Refactoring PR Creator** has assigned this issue to the Copilot coding agent.\n\nCopilot will analyze the proposed refactoring and open a pull request with the implementation.\n\n_Triggered by [Refactoring PR Creator](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})_"
   )
   ```

**Important**: You must pass `item_number` explicitly — this workflow runs on a schedule
without a triggering issue, so the target must always be specified.

## Step 5: Report Results

After processing, output a summary:

```
Processed N [Refactoring] issue(s):
  ✅ #<number>: <title> — assigned to Copilot
  ⏭️  #<number>: <title> — skipped (already has open PR / already assigned)
```

## Guidelines

- **At most 3 assignments per run** — never exceed this cap regardless of how many
  qualifying issues exist.
- **Do not retry failed assignments** — log the error and move to the next issue.
- **Do not read source files** — all needed context comes from issue bodies and the
  open-PR list fetched above.
