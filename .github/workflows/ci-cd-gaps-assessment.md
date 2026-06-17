---
description: Weekly assessment of CI/CD pipelines and integration tests to identify gaps in PR quality measurement
on:
  schedule: weekly on Monday
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
max-ai-credits: 500
max-turns: 4
engine:
  id: copilot
  model: claude-haiku-4.5
sandbox:
  agent:
    id: awf
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  bash: true
safe-outputs:
  threat-detection:
    enabled: false
  create-discussion:
    title-prefix: "[CI/CD Assessment] "
    category: "general"
    close-older-discussions: true
timeout-minutes: 15
steps:
  - name: Pre-fetch CI/CD data
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/ci-assessment

      # List all registered GitHub Actions workflows
      gh workflow list --repo "$GITHUB_REPOSITORY" \
        --json name,state,path \
        > /tmp/gh-aw/ci-assessment/workflows.json \
        || echo '[]' > /tmp/gh-aw/ci-assessment/workflows.json

      # Last 50 workflow runs (all events)
      gh run list --repo "$GITHUB_REPOSITORY" \
        --limit 50 \
        --json name,status,conclusion,createdAt,event,workflowName \
        > /tmp/gh-aw/ci-assessment/recent-runs.json \
        || echo '[]' > /tmp/gh-aw/ci-assessment/recent-runs.json

      # Last 30 PR-triggered runs
      gh run list --repo "$GITHUB_REPOSITORY" \
        --event pull_request \
        --limit 30 \
        --json name,status,conclusion,createdAt,workflowName \
        > /tmp/gh-aw/ci-assessment/pr-runs.json \
        || echo '[]' > /tmp/gh-aw/ci-assessment/pr-runs.json

      # Aggregated run statistics
      jq '{
        total: length,
        success: [.[] | select(.conclusion=="success")] | length,
        failure: [.[] | select(.conclusion=="failure")] | length,
        cancelled: [.[] | select(.conclusion=="cancelled")] | length,
        by_event: ([.[].event] | group_by(.) | map({event: .[0], count: length})),
        by_workflow: ([.[].workflowName] | group_by(.) | map({name: .[0], count: length}) | sort_by(-.count) | .[0:10])
      }' /tmp/gh-aw/ci-assessment/recent-runs.json \
        > /tmp/gh-aw/ci-assessment/run-stats.json

      # Workflow files that trigger on pull_request events
      grep -rl 'pull_request' .github/workflows/*.yml 2>/dev/null \
        > /tmp/gh-aw/ci-assessment/pr-workflow-files.txt \
        || echo "(none)" > /tmp/gh-aw/ci-assessment/pr-workflow-files.txt

      WORKFLOW_COUNT=$(jq '. | length' /tmp/gh-aw/ci-assessment/workflows.json)
      PR_RUN_COUNT=$(jq '. | length' /tmp/gh-aw/ci-assessment/pr-runs.json)
      echo "Fetched $WORKFLOW_COUNT workflows, $PR_RUN_COUNT PR-triggered runs"
---

# CI/CD Pipelines and Integration Tests Gap Assessment

You are an AI agent tasked with analyzing CI/CD pipelines and integration tests in this repository to identify gaps in PR quality measurement.

## Pre-fetched Data

All data is pre-fetched in `/tmp/gh-aw/ci-assessment/`. **Read from these files first — do not call GitHub tools for data already here:**

- `workflows.json` — all registered GitHub Actions workflows
- `recent-runs.json` — last 50 workflow runs
- `pr-runs.json` — last 30 PR-triggered runs
- `run-stats.json` — aggregated success/failure statistics
- `pr-workflow-files.txt` — `.github/workflows/*.yml` files with `pull_request` trigger

## Your Task

1. **Read pre-fetched data** using `cat /tmp/gh-aw/ci-assessment/<file>`.
2. **Assess Current CI/CD Coverage**:
   - What checks run on PRs (linting, testing, building, security scans)?
   - Are integration tests present and what is their scope?
3. **Identify Gaps in PR Quality Measurement**:
   - Missing test coverage checks
   - Missing code quality gates (linting, formatting, type checking)
   - Lack of security scanning (dependency vulnerabilities, code scanning)
   - No performance regression testing
   - Insufficient integration or end-to-end testing
   - Missing required status checks
4. **Analyze run-stats.json** for success/failure patterns.

## Output

Create a discussion with these sections:

### 📊 Current CI/CD Pipeline Status
Summarize workflows and their recent health from `run-stats.json`.

### ✅ Existing Quality Gates
List the checks and tests that currently run on PRs.

### 🔍 Identified Gaps
Prioritized gaps: **High** (address immediately) / **Medium** (significant improvement) / **Low** (nice-to-have).

### 📋 Actionable Recommendations
For each gap: description, recommended solution, complexity (Low/Medium/High), expected impact.

### 📈 Metrics Summary
Workflow count, recent success/failure rates, PR check coverage.

Keep the report concise and actionable.