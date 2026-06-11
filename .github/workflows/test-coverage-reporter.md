---
description: |
  Daily workflow that measures test coverage, identifies files with declining coverage or
  newly-uncovered code paths, and posts a trend report as a GitHub Discussion.
  Runs daily on a schedule and on every push to main to catch coverage regressions early.
  Complements test-coverage-improver (which writes actual tests) by providing visibility
  into coverage trends over time.

on:
  schedule: daily
  push:
    branches: [main]
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
  github:
    toolsets: [repos, discussions]
  bash: true

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

  - name: Capture coverage summary JSON
    id: coverage-json
    run: |
      {
        echo "COVERAGE_JSON<<EOF"
        node -e "
          const fs = require('fs');
          const raw = fs.readFileSync('coverage/coverage-summary.json', 'utf8');
          const d = JSON.parse(raw);
          const filtered = Object.fromEntries(
            Object.entries(d).filter(([k, v]) =>
              k === 'total' || (v.statements && v.statements.pct < 80)
            )
          );
          console.log(JSON.stringify(filtered, null, 2));
        " 2>/dev/null || echo "{}"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Compute per-file coverage table
    id: coverage-table
    run: |
      {
        echo "COVERAGE_TABLE<<EOF"
        node -e "
          const fs = require('fs');
          const raw = fs.readFileSync('coverage/coverage-summary.json', 'utf8');
          const d = JSON.parse(raw);
          const rows = Object.entries(d)
            .filter(([k]) => k !== 'total')
            .map(([k, v]) => ({
              file: k.replace(process.cwd() + '/', ''),
              stmts: v.statements.pct,
              branch: v.branches.pct,
              funcs: v.functions.pct,
              lines: v.lines.pct,
            }))
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
        echo "=== domain-patterns.ts branches ==="
        grep -nE "\\bif[[:space:]]*\\(|\\bswitch[[:space:]]*\\(|\\?.*:" src/domain-patterns.ts 2>/dev/null | head -20
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

The test suite has already run. Use the data captured in the steps above — **do not re-run npm test or npm run test:coverage**.

## Your Task

### Phase 1: Review Coverage Results

Analyze the pre-computed data:

1. **Overall coverage summary**: From `${{ steps.coverage-json.outputs.COVERAGE_JSON }}`
2. **Per-file breakdown**: From `${{ steps.coverage-table.outputs.COVERAGE_TABLE }}`
3. **Critical path gaps**: From `${{ steps.critical-gaps.outputs.CRITICAL_GAPS }}`

Identify:
- Files where statement coverage < 50% (🔴 critical)
- Files where statement coverage 50–79% (🟡 low)
- Any security-critical file with branch coverage < 70%
- Functions with 0 coverage in key security modules

### Phase 2: Analyze Coverage Gaps in Security-Critical Paths

Use the pre-computed function audit from `${{ steps.func-audit.outputs.FUNC_AUDIT }}` to identify which exported functions and branches exist in security-critical files. This includes:
- Exported functions/constants in `src/host-iptables.ts`
- Exported functions/constants in `src/squid-config.ts`
- Branch points (`if`/`switch`/ternary) in `src/domain-patterns.ts`
- Test file count vs source file count

### Phase 3: Check Recent Coverage Changes

Use the pre-computed recent changes from `${{ steps.recent-changes.outputs.RECENT_FILES }}` to identify new code paths that may lack tests. This includes:
- TypeScript files under `src/` changed in the last 7 days
- Newly exported functions or constants added recently

### Phase 4: Post Coverage Report Discussion

Create a discussion with this structure:

---

## 📊 Test Coverage Report — $(date -u +"%Y-%m-%d")

### Overall Coverage

| Metric | Coverage |
|--------|---------|
| Statements | X% |
| Branches | X% |
| Functions | X% |
| Lines | X% |

### 🔴 Critical Gaps (< 50% statement coverage)

List files here, or "None" if all files are above 50%.

### 🟡 Low Coverage (50–79% statement coverage)

List files here with their percentages.

### 🛡️ Security-Critical Path Status

```
${{ steps.critical-gaps.outputs.CRITICAL_GAPS }}
```

### 📋 Full Coverage Table

${{ steps.coverage-table.outputs.COVERAGE_TABLE }}

### 🔍 Notable Findings

Describe 2–4 specific coverage gaps worth addressing, with file paths and what kinds of tests would improve them. Focus on:
- Uncovered error-handling paths
- Uncovered security validation branches
- New code added in the past 7 days without corresponding tests

### 📈 Recommendations

Prioritized list of coverage improvements:

1. **High**: <most impactful gap, with specific function/branch to cover>
2. **Medium**: <next most impactful>
3. **Low**: <nice-to-have>

---
*Generated by test-coverage-reporter workflow. Trigger: `${{ github.event_name }}`*

---

## Guidelines

- **Data-driven**: Base all claims on the pre-computed coverage data — don't speculate
- **Security focus**: Always call out gaps in `host-iptables.ts`, `squid-config.ts`, `domain-patterns.ts`
- **Actionable**: Recommendations should be specific enough for a developer to act on
- **Concise**: The discussion body should be scannable, not a wall of text
- **No code changes**: This is a reporting workflow only — do not modify source files or tests
- **No duplicate discussions**: If coverage is already >= 80% across all files and no security-critical gaps exist, note this in the log and skip creating a discussion
