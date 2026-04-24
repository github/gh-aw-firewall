---
description: Daily assessment of CI/CD pipelines and integration tests to identify gaps in PR quality measurement
on:
  schedule: daily
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
imports:
  - shared/mcp-pagination.md
tools:
  agentic-workflows:
  github:
    toolsets: [default, actions]
safe-outputs:
  threat-detection:
    enabled: false
  create-discussion:
    title-prefix: "[CI/CD Assessment] "
    category: "general"
timeout-minutes: 15
---

# CI/CD Pipelines and Integration Tests Gap Assessment

You are an AI agent tasked with analyzing the current state of CI/CD pipelines and integration tests in this repository to identify gaps in PR quality measurement.

## Your Task

1. **Analyze GitHub Actions Workflows**:
   - Use the `agentic-workflows` tool to get the status of all workflow files
   - Review recent workflow runs using GitHub tools to identify patterns
   - Look for workflows that run on pull requests

2. **Assess Current CI/CD Coverage**:
   - Identify what types of checks are currently running on PRs (linting, testing, building, security scans)
   - Check for integration tests and their scope
   - Review test coverage reporting if available
   - Look at the workflow configuration files in `.github/workflows/`

3. **Identify Gaps in PR Quality Measurement**:
   - Missing or inadequate test coverage checks
   - Absence of code quality gates (linting, formatting, type checking)
   - Lack of security scanning (dependency vulnerabilities, code scanning)
   - Missing documentation checks
   - No performance regression testing
   - Insufficient integration or end-to-end testing
   - Missing accessibility checks for UI components
   - No artifact size monitoring
   - Incomplete status checks or missing required reviews

4. **Analyze Recent PR Activity**:
   - Review recent merged PRs to identify patterns
   - Look for PRs that introduced issues that could have been caught by better CI/CD

## Output Requirements

Create a discussion with the following sections:

### 📊 Current CI/CD Pipeline Status
Summarize the current state of CI/CD pipelines and their health.

### ✅ Existing Quality Gates
List the current checks and tests that run on PRs.

### 🔍 Identified Gaps
Provide a detailed list of gaps in PR quality measurement, categorized by:
- **High Priority**: Critical gaps that should be addressed immediately
- **Medium Priority**: Important improvements that would significantly improve quality
- **Low Priority**: Nice-to-have improvements

### 📋 Actionable Recommendations
For each gap, provide:
- A clear description of the issue
- The recommended solution
- Implementation complexity (Low/Medium/High)
- Expected impact on PR quality

### 📈 Metrics Summary
Include relevant metrics such as:
- Number of workflows
- Recent workflow success/failure rates
- Test coverage if available

## Guidelines

- Be specific and actionable in your recommendations
- Prioritize gaps based on their impact on code quality and developer experience
- Consider the repository's current tech stack and development practices
- Focus on practical improvements that can be implemented incrementally
- Reference specific workflow files or configurations when identifying gaps