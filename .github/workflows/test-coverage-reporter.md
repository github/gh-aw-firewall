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

engine:
  id: copilot
  model: summarization

safe-outputs:
  threat-detection:
    enabled: false
  create-discussion:
    title-prefix: "[Coverage Report] "
    category: "general"

timeout-minutes: 20

steps:
  - name: Cache npm dependencies
    uses: actions/cache/restore
    with:
      path: ~/.npm
      key: npm-${{ hashFiles('package-lock.json') }}
      restore-keys: npm-

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
            .sort((a, b) => a.stmts - b.stmts)
            .slice(0, 20);
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
          git fetch --shallow-since="7 days ago" --no-tags origin HEAD
        fi
        git log --since="7 days ago" --name-only --format="" | grep -E "^src/.*\.ts$" | sort -u | head -10
        echo "---"
        git log --since="7 days ago" -p -- "src/*.ts" 2>/dev/null | grep -E "^\\+.*export.*function|^\\+.*export.*const.*=.*\\(" | head -10
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Identify top coverage gaps for agent brief
    id: coverage-gaps-brief
    run: |
      {
        echo "COVERAGE_GAPS_BRIEF<<EOF"
        node -e "
          const fs = require('fs');
          const d = JSON.parse(fs.readFileSync('coverage/coverage-summary.json','utf8'));
          const SEC = ['docker-manager','host-iptables','squid-config','domain-patterns','cli'];
          const gaps = Object.entries(d)
            .filter(([k]) => k !== 'total')
            .map(([k, v]) => ({
              file: k.replace(process.cwd() + '/', ''),
              stmts: v.statements.pct,
              branch: v.branches.pct,
              isSec: SEC.some(s => k.includes(s)),
            }))
            .filter(r => r.stmts < 80)
            .sort((a, b) => (b.isSec - a.isSec) || (a.stmts - b.stmts))
            .slice(0, 5);
          if (!gaps.length) {
            console.log('All files >= 80% coverage. No gaps found.');
          } else {
            gaps.forEach(g => {
              const tag = g.isSec ? '[SECURITY]' : g.stmts < 50 ? '[CRITICAL]' : '[LOW]';
              console.log(tag + ' ' + g.file + ': stmts=' + g.stmts + '% branch=' + g.branch + '%');
            });
          }
        " 2>/dev/null || echo "Coverage data unavailable"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Pre-build discussion template
    id: discussion-template
    env:
      EXPR_STEPS_CRITICAL_GAPS_OUTPUTS_CRITICAL_GAPS: ${{ steps.critical-gaps.outputs.CRITICAL_GAPS }}
      EXPR_STEPS_COVERAGE_TABLE_OUTPUTS_COVERAGE_TABLE: ${{ steps.coverage-table.outputs.COVERAGE_TABLE }}
      EXPR_STEPS_FUNC_AUDIT_OUTPUTS_FUNC_AUDIT: ${{ steps.func-audit.outputs.FUNC_AUDIT }}
      EXPR_STEPS_RECENT_CHANGES_OUTPUTS_RECENT_FILES: ${{ steps.recent-changes.outputs.RECENT_FILES }}
      EXPR_GITHUB_EVENT_NAME: ${{ github.event_name }}
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
        echo "$EXPR_STEPS_CRITICAL_GAPS_OUTPUTS_CRITICAL_GAPS"
        echo '```'
        echo ""
        echo "### 📋 Coverage Table"
        echo ""
        echo "$EXPR_STEPS_COVERAGE_TABLE_OUTPUTS_COVERAGE_TABLE"
        echo ""
        echo "### 🔧 Function Audit"
        echo '```'
        echo "$EXPR_STEPS_FUNC_AUDIT_OUTPUTS_FUNC_AUDIT"
        echo '```'
        echo ""
        echo "### 📅 Recent Source Changes (last 7 days)"
        echo '```'
        echo "$EXPR_STEPS_RECENT_CHANGES_OUTPUTS_RECENT_FILES"
        echo '```'
        echo ""
        echo "---"
        echo "*Generated by test-coverage-reporter workflow. Trigger: \`$EXPR_GITHUB_EVENT_NAME\`*"
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

The test suite has already run and all coverage metrics were pre-computed. Use the data below — **do not re-run npm test or npm run test:coverage**.

## Your Task

The top coverage gaps (pre-identified) are:

${{ steps.coverage-gaps-brief.outputs.COVERAGE_GAPS_BRIEF }}

Using only this brief, write a complete coverage discussion that follows this structure:

- `## 📊 Test Coverage Report — YYYY-MM-DD`
- `### Overall Coverage`
- `### 🛡️ Security-Critical Path Status`
- `### 📋 Coverage Table`
- `### 🔧 Function Audit`
- `### 📅 Recent Source Changes (last 7 days)`
- `### 🔎 Notable Findings` (2–4 bullets)
- `### 🎯 Recommendations` (3 prioritized High/Medium/Low items)

Populate each section using the pre-computed step outputs and call `create_discussion` with the full final body.

## Guidelines

- **Data-driven**: Base all claims on the pre-computed coverage data — don't speculate
- **Security focus**: Always call out gaps in `host-iptables.ts`, `squid-config.ts`, `domain-patterns.ts`
- **Actionable**: Recommendations should be specific enough for a developer to act on
- **Concise**: The discussion body should be scannable, not a wall of text
- **No code changes**: This is a reporting workflow only — do not modify source files or tests
- **No duplicate discussions**: If coverage is already >= 80% across all files and no security-critical gaps exist, note this in the log and skip creating a discussion