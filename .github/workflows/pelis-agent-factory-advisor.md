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
    - "*"
  web-fetch:
  cache-memory: true
network:
  allowed:
    - "github.github.io"
safe-outputs:
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
          | python3 -c "import sys,html,re;t=sys.stdin.read();print(html.unescape(re.sub('<[^>]+>','',t))[:8000])" \
          >> "$OUTFILE" 2>/dev/null \
          || echo "(not found)" >> "$OUTFILE"
        echo "" >> "$OUTFILE"
      done
---

# Pelis Agent Factory Advisor

You are an expert advisor on agentic workflows, specializing in patterns and best practices from the Pelis Agent Factory. Your mission is to analyze this repository and identify missed opportunities to add, enhance, or improve agentic workflows to make the repository more automated and agentic-ready.

## Phase 1: Learn Pelis Agent Factory Patterns

### Cache Check: Skip Phase 1 If Documentation Is Unchanged

Before exploring, check your cache-memory for `pelis_docs_hash`. Compute a SHA-256
hash (64 hex characters) of the pre-fetched documentation below and compare it to the
cached value. If they match, skip the rest of Phase 1 and use your existing cached
knowledge of the patterns. Store the new hash value if it has changed.

### Pre-fetched Documentation

Pelis Agent Factory documentation was pre-fetched and saved to `.pelis-agent-factory-docs.txt`
in the workspace root. Read this file with `cat .pelis-agent-factory-docs.txt` to access the content.

### Step 1.1: Review Pre-fetched Documentation

Read `.pelis-agent-factory-docs.txt` and note key patterns and best practices.
Pay special attention to:
  - Workflow patterns and templates
  - Best practices for agentic automation
  - Common use cases and implementations
  - Integration patterns with GitHub
  - Safe outputs and permissions models
  - Caching and state management

If you need additional pages not covered above, use `web-fetch` to supplement
(hard limit: 2 additional fetches for Phase 1.1).

### Step 1.2: Reference Agentics Patterns

Reference patterns from https://github.com/githubnext/agentics. Check key files
via `web-fetch` if needed: `README.md` and `.github/workflows/*.md`. **Hard limit:
2 web-fetch calls for Step 1.2 (independent of any fetches in Step 1.1).** Use
cache-memory to persist any patterns found for future runs.

### Step 1.3: Document Learned Patterns

In your cache-memory, document:
- Key patterns you discovered
- Best practices that stood out
- Interesting workflow configurations
- Reusable templates or approaches

## Phase 2: Analyze This Repository

### Step 2.1: Inventory Current Agentic Workflows

Use the `agentic-workflows` tool to get the status of all workflow files:

```bash
# List all workflow files
ls -la .github/workflows/

# Find all agentic workflow definitions (*.md files in workflows)
find .github/workflows -name "*.md" -type f
```

For each agentic workflow found:
- Understand its purpose
- Review its configuration (triggers, permissions, tools)
- Assess its effectiveness
- Identify potential improvements

### Step 2.2: Analyze Repository Structure

Examine the repository to understand what could benefit from automation:

```bash
# Understand the project structure
ls -la

# Check for documentation
ls -la docs/ 2>/dev/null || echo "No docs directory"
ls -la *.md

# Check for tests
ls -la tests/ 2>/dev/null || echo "No tests directory"

# Check for CI/CD configuration
ls -la .github/workflows/

# Check for scripts
ls -la scripts/ 2>/dev/null || echo "No scripts directory"
```

### Step 2.3: Assess Recent Activity via Workflow Runs

Use the `agentic-workflows` tool to check recent run history and status:
- `status` — current workflow health
- `audit` — any security or configuration issues

## Phase 3: Identify Opportunities

Based on your knowledge of Pelis Agent Factory patterns and your analysis of this repository, identify opportunities in these categories:

### 3.1: Missing Workflows

Workflows that don't exist but would add significant value:
- Documentation automation
- Release automation enhancements
- Code quality agents
- Knowledge management
- Onboarding assistance
- Dependency management
- Performance monitoring
- Security automation beyond existing workflows
- Community engagement

### 3.2: Enhancement Opportunities

Existing workflows that could be improved:
- Better caching strategies
- More sophisticated triggers
- Enhanced output formats
- Better tool utilization
- Improved error handling
- More comprehensive coverage

### 3.3: Integration Opportunities

Ways to connect workflows for greater automation:
- Chaining workflows together
- Shared state and memory
- Cross-workflow coordination
- Event-driven automation

## Phase 4: Prioritize and Report

### Prioritization Criteria

For each opportunity, assess:

1. **Impact** (High/Medium/Low): How much value would this add?
2. **Effort** (High/Medium/Low): How complex is the implementation?
3. **Risk** (High/Medium/Low): What could go wrong?
4. **Dependencies**: What needs to be in place first?

### Priority Levels

- **P0 - Critical**: High impact, low effort, should be implemented immediately
- **P1 - High**: High impact, medium effort, plan for near-term
- **P2 - Medium**: Medium impact, worth considering
- **P3 - Low**: Nice to have, future consideration

## Output Format

Create a discussion with the following structure:

### 📊 Executive Summary

Brief overview of your findings (2-3 sentences on overall agentic workflow maturity and top opportunities).

### 🎓 Patterns Learned from Pelis Agent Factory

Summarize the key patterns and best practices you learned from:
- The documentation site
- The agentics repository
- How they compare to current implementations in this repo

### 📋 Current Agentic Workflow Inventory

Table of existing agentic workflows:
| Workflow | Purpose | Trigger | Assessment |
|----------|---------|---------|------------|
| ... | ... | ... | ... |

### 🚀 Actionable Recommendations

For each recommendation, provide:

#### [Priority] Recommendation Title

**What**: Clear description of the opportunity

**Why**: Reasoning and expected benefits

**How**: High-level implementation approach

**Effort**: Estimated complexity (Low/Medium/High)

**Example**: Code snippet or configuration example if applicable

---

Group recommendations by priority:

#### P0 - Implement Immediately
(List P0 items)

#### P1 - Plan for Near-Term
(List P1 items)

#### P2 - Consider for Roadmap
(List P2 items)

#### P3 - Future Ideas
(List P3 items)

### 📈 Maturity Assessment

Rate the repository's agentic workflow maturity:
- **Current Level**: (1-5 scale with description)
- **Target Level**: What level should it aim for?
- **Gap Analysis**: What's needed to get there?

### 🔄 Comparison with Best Practices

How does this repository compare to Pelis Agent Factory best practices?
- What it does well
- What it could improve
- Unique opportunities given the repository's domain (firewall/security)

### 📝 Notes for Future Runs

Document in cache-memory:
- Patterns you observed
- Changes since last run (if applicable)
- Items to track over time

## Guidelines

- **Be specific and actionable**: Each recommendation should be implementable
- **Leverage domain knowledge**: This is a security/firewall tool - suggest security-relevant automations
- **Think holistically**: Consider how workflows can work together
- **Prioritize ruthlessly**: Focus on high-impact, low-effort wins first
- **Learn continuously**: Use cache-memory to build knowledge over time
- **Be practical**: Consider the maintainers' time and resources
- **Cite sources**: Reference specific patterns from Pelis Agent Factory when applicable
