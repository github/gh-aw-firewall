---
description: |
  Daily workflow that measures test coverage, identifies files with declining coverage or
  newly-uncovered code paths, and posts a trend report as a GitHub Discussion.
  Runs daily on a schedule and on pushes to main that touch src/**/*.ts to catch coverage
  regressions early. Complements test-coverage-improver (which writes actual tests) by
  providing visibility into coverage trends over time.

on:
  schedule: daily
  push:
    branches: [main]
    paths:
      - 'src/**/*.ts'
  workflow_dispatch:

permissions:
  contents: read
  actions: read
  issues: read
  discussions: read

sandbox:
  mcp:
    version: "latest"
  agent:
    id: awf
strict: false
network:
  allowed:
    - github

tools:
  github: false
  bash: false

safe-outputs:
  threat-detection:
    enabled: false
  create-discussion:
    title-prefix: "[Coverage Report] "
    category: "general"

timeout-minutes: 20

steps:
  - name: Install dependencies
    run: set -o pipefail && npm ci 2>&1 | tail -5

  - name: Build
    run: set -o pipefail && npm run build 2>&1 | tail -5

  - name: Run coverage
    id: coverage
    run: set -o pipefail && npm run test:coverage 2>&1 | tail -20

  - name: Compute per-file coverage table
    id: coverage-table
    run: |
      {
        echo "COVERAGE_TABLE<<EOF"
        node -e "
          const fs = require('fs');
          const raw = fs.readFileSync('coverage/coverage-summary.json', 'utf8');
          const d = JSON.parse(raw);
          const SECURITY_CRITICAL = [
            'docker-manager',
            'host-iptables',
            'squid-config',
            'domain-patterns',
            'cli',
          ];
          const rows = Object.entries(d)
            .filter(([k]) => k !== 'total')
            .map(([k, v]) => ({
              file: k.replace(process.cwd() + '/', ''),
              stmts: v.statements.pct,
              branch: v.branches.pct,
              funcs: v.functions.pct,
              lines: v.lines.pct,
            }))
            .filter(r => r.stmts < 80 || SECURITY_CRITICAL.some(s => r.file.includes(s)))
            .sort((a, b) => a.stmts - b.stmts);
          console.log('| File | Stmts | Branch | Funcs | Lines | Status |');
          console.log('|------|------:|-------:|------:|------:|--------|');
          rows.forEach(r => {
            const status = r.stmts >= 80 ? '✅' : r.stmts >= 50 ? '⚠️' : '❌';
            console.log(\`| \${r.file} | \${r.stmts}% | \${r.branch}% | \${r.funcs}% | \${r.lines}% | \${status} |\`);
          });
          const t = d.total;
          if (t) {
            console.log(\`| **TOTAL** | **\${t.statements.pct}%** | **\${t.branches.pct}%** | **\${t.functions.pct}%** | **\${t.lines.pct}%** | |\`);
          }
        " 2>/dev/null || echo "Coverage data not available"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Identify critical paths with low coverage
    id: critical-gaps
    run: |
      {
        echo "CRITICAL_GAPS<<EOF"
        node -e "
          const fs = require('fs');
          const raw = fs.readFileSync('coverage/coverage-summary.json', 'utf8');
          const d = JSON.parse(raw);
          const priority = [
            'src/docker-manager.ts',
            'src/host-iptables.ts',
            'src/squid-config.ts',
            'src/cli.ts',
            'src/domain-patterns.ts',
          ];
          priority.forEach(p => {
            const key = Object.keys(d).find(k => k.includes(p.replace('src/', '')));
            if (key && d[key]) {
              const v = d[key];
              const label = v.statements.pct < 50 ? '🔴 CRITICAL' : v.statements.pct < 80 ? '🟡 LOW' : '🟢 OK';
              console.log(\`\${label} \${p}: stmts=\${v.statements.pct}% branch=\${v.branches.pct}% funcs=\${v.functions.pct}%\`);
            } else {
              console.log(\`⬜ NOT FOUND: \${p}\`);
            }
          });
        " 2>/dev/null || echo "Coverage data not available"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Identify exported functions in security-critical files
    id: func-audit
    run: |
      {
        echo "FUNC_AUDIT<<EOF"
        echo "=== host-iptables.ts ==="
        grep -nE "^export[[:space:]]+(async[[:space:]]+)?function|^export[[:space:]]+const" src/host-iptables.ts 2>/dev/null | head -20
        echo "=== squid-config.ts ==="
        grep -nE "^export[[:space:]]+(async[[:space:]]+)?function|^export[[:space:]]+const" src/squid-config.ts 2>/dev/null | head -20
        echo "=== domain-patterns.ts branch count ==="
        echo "if-branches: $(grep -cE "\\bif[[:space:]]*\\(" src/domain-patterns.ts 2>/dev/null || echo 0)"
        echo "switch-branches: $(grep -cE "\\bswitch[[:space:]]*\\(" src/domain-patterns.ts 2>/dev/null || echo 0)"
        echo "Test files: $(find src -name '*.test.ts' | wc -l) / Source files: $(find src -name '*.ts' ! -name '*.test.ts' | wc -l)"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Identify recently changed source files
    id: recent-changes
    run: |
      {
        echo "RECENT_FILES<<EOF"
        if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
          git fetch --prune --unshallow --tags
        fi
        git log --since="7 days ago" --name-only --format="" | grep -E "^src/.*\.ts$" | sort -u | head -20
        echo "---"
        git log --since="7 days ago" -p -- "src/*.ts" 2>/dev/null | grep -E "^\\+.*export.*function|^\\+.*export.*const.*=.*\\(" | head -20
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Pre-build discussion template
    id: discussion-template
    run: |
      {
        echo "DISCUSSION_BODY<<EOF"
        TODAY=$(date -u +"%Y-%m-%d")
        echo "## 📊 Test Coverage Report — ${TODAY}"
        echo ""
        echo "### Overall Coverage"
        echo ""
        node -e "
          const fs = require('fs');
          const d = JSON.parse(fs.readFileSync('coverage/coverage-summary.json', 'utf8'));
          const t = d.total;
          if (t) {
            console.log('| Metric | Coverage |');
            console.log('|--------|---------|');
            console.log(\`| Statements | \${t.statements.pct}% |\`);
            console.log(\`| Branches | \${t.branches.pct}% |\`);
            console.log(\`| Functions | \${t.functions.pct}% |\`);
            console.log(\`| Lines | \${t.lines.pct}% |\`);
          }
        " 2>/dev/null || echo "Coverage data unavailable"
        echo ""
        echo "### 🛡️ Security-Critical Path Status"
        echo '```'
        echo "${{ steps.critical-gaps.outputs.CRITICAL_GAPS }}"
        echo '```'
        echo ""
        echo "### 📋 Coverage Table"
        echo ""
        echo "${{ steps.coverage-table.outputs.COVERAGE_TABLE }}"
        echo ""
        echo "---"
        echo "*Generated by test-coverage-reporter workflow. Trigger: \`${{ github.event_name }}\`*"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"
---

# Test Coverage Reporter

You are a code quality analyst for `${{ github.repository }}`. Your mission is to measure test coverage, identify coverage regressions and gaps in security-critical paths, and post a clear trend report as a GitHub Discussion.

## Repository Context

This is **gh-aw-firewall**, a security-critical network firewall. Test coverage is especially important for:

- **`src/host-iptables.ts`** — generates iptables rules for network isolation
- **`src/squid-config.ts`** — generates domain ACL rules for HTTP/HTTPS filtering
- **`src/docker-manager.ts`** — container lifecycle management (3,900+ lines)
- **`src/domain-patterns.ts`** — domain pattern matching and validation
- **`src/cli.ts`** — main entry point and orchestration

## Pre-computed Coverage Data

The test suite has already run and the discussion body has been pre-built. Use the data below — **do not re-run npm test or npm run test:coverage**.

The pre-built discussion template is in `${{ steps.discussion-template.outputs.DISCUSSION_BODY }}`.

## Your Task

Your **only** task is to add the following two sections to the pre-built template and post it as a GitHub Discussion:

### 🔍 Notable Findings

Write 2–4 specific coverage gaps worth addressing. Use:
- `${{ steps.coverage-table.outputs.COVERAGE_TABLE }}` — per-file breakdown
- `${{ steps.critical-gaps.outputs.CRITICAL_GAPS }}` — security-critical path status
- `${{ steps.func-audit.outputs.FUNC_AUDIT }}` — exported functions in critical files
- `${{ steps.recent-changes.outputs.RECENT_FILES }}` — code changed in the last 7 days

Focus on:
- Uncovered error-handling paths
- Uncovered security validation branches in `host-iptables.ts`, `squid-config.ts`, `domain-patterns.ts`
- New code added in the past 7 days without corresponding tests

### 📈 Recommendations

Write 3 prioritized improvements (High/Medium/Low) based on the coverage data.

Append both sections to `${{ steps.discussion-template.outputs.DISCUSSION_BODY }}` and post the complete discussion using `create_discussion`.

## Guidelines

- **Data-driven**: Base all claims on the pre-computed coverage data — don't speculate
- **Security focus**: Always call out gaps in `host-iptables.ts`, `squid-config.ts`, `domain-patterns.ts`
- **Actionable**: Recommendations should be specific enough for a developer to act on
- **Concise**: The discussion body should be scannable, not a wall of text
- **No code changes**: This is a reporting workflow only — do not modify source files or tests
- **No duplicate discussions**: If coverage is already >= 80% across all files and no security-critical gaps exist, note this in the log and skip creating a discussion
