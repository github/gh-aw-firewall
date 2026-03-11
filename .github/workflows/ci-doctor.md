---
name: CI Doctor
description: Automated CI failure investigator that analyzes logs, identifies root causes, and creates investigation issues.

on:
  workflow_run:
    # NOTE: GitHub Actions doesn't support wildcards for workflow_run.
    # When adding new workflows, add them to this list to monitor for failures.
    workflows:
      - "Build Verification"
      - "Chroot Integration Tests"
      - "CI/CD Pipelines and Integration Tests Gap Assessment"
      - "CodeQL"
      - "Container Security Scan"
      - "Copilot Setup Steps"
      - "Daily Security Review and Threat Modeling"
      - "Dependency Vulnerability Audit"
      - "Deploy Documentation"
      - "Examples Test"
      - "Integration Tests"
      - "Issue Duplication Detector"
      - "Issue Monster"
      - "Lint"
      - "Pelis Agent Factory Advisor"
      - "Plan Command"
      - "PR Title Check"
      - "Release"
      - "Security Guard"
      - "Smoke Chroot"
      - "Smoke Claude"
      - "Smoke Codex"
      - "Smoke Copilot"
      - "Test Coverage"
      - "Test Setup Action"
      - "TypeScript Type Check"
      - "Update Release Notes"
    types:
      - completed
    branches:
      - main

if: ${{ github.event.workflow_run.conclusion == 'failure' }}

permissions:
  contents: read
  actions: read
  pull-requests: read
  issues: read

imports:
  - shared/mcp-pagination.md

tools:
  github:
    toolsets: [default, actions]
  cache-memory: true

network:
  allowed:
    - github

safe-outputs:
  create-issue:
    title-prefix: "🏥 CI Failure"
  add-comment:
    max: 1

timeout-minutes: 10
---

# CI Failure Doctor

You are the CI Failure Doctor. When a workflow fails, investigate the root cause and create an actionable investigation report.

## Context

- **Repository**: ${{ github.repository }}
- **Run**: [${{ github.event.workflow_run.id }}](${{ github.event.workflow_run.html_url }})
- **Conclusion**: ${{ github.event.workflow_run.conclusion }}
- **Commit**: ${{ github.event.workflow_run.head_sha }}

## Your Mission

1. **Fetch logs** from failed jobs using the GitHub Actions tools
2. **Analyze the failure** - look for error patterns, stack traces, and root causes
3. **Search cache-memory** for similar past failures
4. **Check for existing issues** that match this failure
5. **Create an investigation issue** if no duplicate exists

## Key Patterns for This Repository

This is the AWF (Agentic Workflow Firewall) repository with Docker/networking tests. Common failures:
- Docker network conflicts (`Pool overlaps`, orphaned `awf-net`)
- Container cleanup issues (`timeout` kills leaving orphaned resources)
- iptables/NET_ADMIN capability problems
- Squid proxy healthcheck failures

## Output

Create an issue with:
- Summary of what failed
- Root cause analysis
- Recommended actions
- Labels: `bug`, `ci`

If a duplicate issue exists, comment on it instead.

---
*🏥 Automatically investigated by CI Doctor*
