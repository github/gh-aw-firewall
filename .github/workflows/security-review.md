---
description: Daily comprehensive security review and threat modeling with verifiable evidence
on:
  schedule: daily
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
  discussions: read
  security-events: read
features:
  byok-copilot: true
imports:
  - shared/mcp-pagination.md
tools:
  github:
    toolsets: [repos, code_security]
  bash: true
  cache-memory: true
network:
  allowed:
    - github
safe-outputs:
  threat-detection:
    enabled: false
  create-discussion:
    title-prefix: "[Security Review] "
    category: "general"
timeout-minutes: 45
steps:
  - name: Fetch latest escape test results
    run: |
      mkdir -p /tmp/gh-aw
      # secret-digger-copilot is the red-team escape test workflow for this repo
      RUN_ID=$(gh run list --workflow "secret-digger-copilot.lock.yml" \
        --status success --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")
      # Validate RUN_ID is a non-empty numeric value (jq returns literal "null" on empty arrays)
      if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] && [[ "$RUN_ID" =~ ^[0-9]+$ ]]; then
        # 200 lines captures the full escape-attempt summary without exceeding prompt budget
        gh run view "$RUN_ID" --log 2>/dev/null | tail -200 > /tmp/gh-aw/escape-test-summary.txt \
          || echo "Failed to fetch run logs" > /tmp/gh-aw/escape-test-summary.txt
      else
        echo "No recent successful secret-digger-copilot run found" > /tmp/gh-aw/escape-test-summary.txt
      fi
    env:
      GH_TOKEN: ${{ github.token }}
      GH_REPO: ${{ github.repository }}
---

# Daily Security Review and Threat Modeling

You are a security researcher conducting a **comprehensive, evidence-based security review** of the gh-aw-firewall repository. Your analysis must be deep, thorough, and backed by **verifiable evidence with specific file references, line numbers, and command outputs**.

## Important: Show Your Work

**CRITICAL**: For every finding, you MUST:
1. Show the exact command you ran to discover it
2. Include the relevant output/evidence
3. Cite specific file paths and line numbers
4. Explain why this is a security concern with technical depth

Use bash commands extensively to gather evidence. Document every command and its output.

## Phase 1: Gather Context from Previous Security Testing

The most recent firewall escape test results have been pre-fetched into `/tmp/gh-aw/escape-test-summary.txt`. Read this file and use it as complementary context for your security review — do NOT re-fetch using any tools.

```bash
cat /tmp/gh-aw/escape-test-summary.txt
```

Analyze the results to understand:
- What escape attempts were tried
- Which ones succeeded or failed
- Any vulnerabilities discovered
- Recommendations made

## Phase 2: Codebase Security Analysis

Run all evidence-gathering commands in one bash block to collect everything upfront:

```bash
echo "=== NETWORK SECURITY ===" && \
  cat src/host-iptables.ts && echo "---" && \
  cat containers/agent/setup-iptables.sh && echo "---" && \
  cat src/squid-config.ts && echo "---" && \
  grep -r --include="*.ts" -l "network" src/

echo "=== CONTAINER SECURITY ===" && \
  grep -rn "cap_drop\|capabilities\|NET_ADMIN\|NET_RAW" src/ containers/ && echo "---" && \
  cat containers/agent/seccomp-profile.json && echo "---" && \
  grep -rn "privilege\|root\|user\|uid" containers/

echo "=== DOMAIN PATTERNS ===" && \
  cat src/domain-patterns.ts && echo "---" && \
  grep -rn --include="*.ts" -l "domain\|wildcard\|pattern" src/

echo "=== INJECTION RISKS ===" && \
  grep -rn --include="*.ts" -l "exec\|spawn\|shell\|command" src/ && echo "---" && \
  grep -rn --include="*.sh" '\$\{' containers/ && echo "---" && \
  grep -rn "args\|argv\|input" src/cli.ts

echo "=== DOCKER WRAPPER ===" && \
  cat containers/agent/docker-wrapper.sh && echo "---" && \
  cat containers/agent/entrypoint.sh

echo "=== DEPENDENCIES ===" && \
  cat package.json && echo "---" && \
  npm audit --json 2>/dev/null | head -100 || echo "npm audit not available"

echo "=== ATTACK SURFACE ===" && \
  grep -rln "http\|https\|socket\|network\|proxy" src/ containers/ && echo "---" && \
  grep -rln "fs\.\|writeFile\|readFile\|exec" src/ && echo "---" && \
  grep -rln "execa\|spawn\|exec\|child_process" src/
```

## Phase 3: Security Analysis Synthesis

Based on the evidence collected above, produce a unified security analysis covering all three areas in one response:

1. **STRIDE Threat Model** — for each category (Spoofing/Tampering/Repudiation/Information Disclosure/Denial of Service/Elevation of Privilege), identify threats with evidence citations and likelihood/impact rating

2. **Attack Surface Map** — enumerate each attack surface (network, container, domain parsing, input validation, Docker wrapper) with:
   - Entry point location (file:line)
   - Current protections
   - Potential weaknesses

3. **CIS/NIST Comparison** — note any gaps vs Docker CIS Benchmark or NIST network filtering guidelines and apply the Principle of Least Privilege assessment

## Output Format

Create a discussion with the following structure:

### 📊 Executive Summary
Brief overview of security posture with key metrics.

### 🔍 Findings from Firewall Escape Test
Summary of complementary findings from the escape test results.

### 🛡️ Architecture Security Analysis
- Network Security Assessment
- Container Security Assessment
- Domain Validation Assessment
- Input Validation Assessment

### ⚠️ Threat Model
Table of identified threats with severity ratings.

### 🎯 Attack Surface Map
Enumeration of attack surfaces with risk levels.

### 📋 Evidence Collection
All commands run with their outputs (collapsed sections for brevity).

### ✅ Recommendations
Prioritized list of security improvements:
- **Critical** - Must fix immediately
- **High** - Should fix soon
- **Medium** - Plan to address
- **Low** - Nice to have

### 📈 Security Metrics
- Lines of security-critical code analyzed
- Number of attack surfaces identified
- Coverage of threat model

## Guidelines

- **Be thorough** - This is a deep security review, not a quick scan
- **Show evidence** - Every claim must have verifiable proof
- **Be specific** - Include file paths, line numbers, and code snippets
- **Be actionable** - Recommendations should be implementable
- **No false positives** - Only report genuine security concerns
- **Cross-reference** - Link findings to the escape test agent's results where relevant