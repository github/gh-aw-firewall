---
description: |
  Weekly workflow that scans the codebase for refactoring opportunities: files exceeding
  size/complexity thresholds, functions with too many parameters or deep nesting, and
  modules with mixed responsibilities. files actionable issues for the highest-priority
  refactoring candidates to help keep the codebase maintainable as it grows.

on:
  schedule: weekly
  workflow_dispatch:

permissions:
  contents: read
  issues: read

sandbox:
  agent:
    version: v0.25.29
network:
  allowed:
    - node

tools:
  github:
    toolsets: [issues]
  bash: true

safe-outputs:
  threat-detection:
    enabled: false
  create-issue:
    title-prefix: "[Refactoring] "
    labels: [code-quality, refactoring]
    max: 5
    expires: 60d

timeout-minutes: 20

steps:
  - name: Measure file sizes
    id: file-sizes
    run: |
      {
        echo "FILE_SIZES<<EOF"
        echo "=== TypeScript source files (sorted by line count) ==="
        find src -name "*.ts" ! -name "*.test.ts" -exec wc -l {} + 2>/dev/null | sort -rn | head -20
        echo "=== Test files (sorted by line count) ==="
        find src -name "*.test.ts" -exec wc -l {} + 2>/dev/null | sort -rn | head -10
        echo "=== Container JS files (sorted by line count) ==="
        find containers -name "*.js" -exec wc -l {} + 2>/dev/null | sort -rn | head -15
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Count functions per file
    id: function-counts
    run: |
      {
        echo "FUNCTION_COUNTS<<EOF"
        for f in src/*.ts; do
          [ -f "$f" ] || continue
          count=$(grep -c "^\s*\(export \)\?\(async \)\?function\|^\s*\(export \)\?const [a-zA-Z].*=\s*\(async \)\?(" "$f" 2>/dev/null || echo 0)
          if [ "$count" -gt 10 ]; then
            echo "$count functions: $f"
          fi
        done | sort -rn
        echo "EOF"
      } >> "$GITHUB_OUTPUT"
---

# Refactoring Opportunity Scanner

You are a software architect analyzing the `${{ github.repository }}` codebase to identify high-priority refactoring opportunities. Your mission is to surface actionable candidates where splitting, extracting, or simplifying modules would meaningfully reduce maintenance burden and risk.

## Repository Context

This is **gh-aw-firewall**, a network firewall for GitHub Copilot CLI. Known large files:

- `src/docker-manager.ts` — 3,900+ lines; mixes container lifecycle, config generation, volume mounts, env vars, cleanup
- `src/cli.ts` — 1,700+ lines; argument parsing, orchestration, signal handling, config merging
- `containers/api-proxy/server.js` — 1,200+ lines; post-refactor but may still have opportunities

## Pre-computed Metrics

File sizes are already available from the pre-steps above. Use these — **do not re-run wc**.

```
${{ steps.file-sizes.outputs.FILE_SIZES }}
```

Function density per file:
```
${{ steps.function-counts.outputs.FUNCTION_COUNTS }}
```

## Phase 1: Identify Oversized Files

Classify every TypeScript source file and JS file by size:

| Threshold | Classification | Action |
|-----------|---------------|--------|
| > 2,000 lines | 🔴 Must split | File issue |
| 1,000–2,000 lines | 🟡 Review | File issue if mixed responsibilities |
| 500–999 lines | 🟢 Acceptable | Monitor only |
| < 500 lines | ✅ Good | No action |

For any file that exceeds 1,000 lines, run a quick responsibility analysis:

```bash
# For each large file, identify the logical sections
echo "=== docker-manager.ts: top-level function/class groupings ==="
grep -n "^export\s\+\(async \)\?function\|^export\s\+class\|^\/\/\s*=\+\|^\/\/ ---\|^\/\*\*" src/docker-manager.ts 2>/dev/null | head -60

echo "=== cli.ts: command/option definitions ==="
grep -n "program\.\(command\|option\|argument\)\|\.action(" src/cli.ts 2>/dev/null | head -40

echo "=== docker-manager.ts: responsibility zones (export names) ==="
grep -n "^export " src/docker-manager.ts 2>/dev/null | head -40

echo "=== api-proxy/server.js: handler sections ==="
grep -n "^function\|^const.*=\s*function\|^\/\/\s*=\+\|^\/\/ ---" containers/api-proxy/server.js 2>/dev/null | head -40
```

## Phase 2: Detect Deep Nesting and Complex Functions

```bash
# Find functions with excessive nesting (5+ levels of indentation)
echo "=== Deeply nested code in docker-manager.ts ==="
awk 'length($0) - length(ltrim($0)) >= 20 {print NR": "$0}' src/docker-manager.ts 2>/dev/null | \
  grep -v "^\s*\/\/" | head -20

# Heuristic: functions longer than 100 lines
echo "=== Long functions in docker-manager.ts (heuristic: >50 lines between function defs) ==="
awk '/^(export )?(async )?function|^  (export )?(async )?function/{if(prev>0){print prev": function starting at "start" is "NR-start" lines long"}; start=NR} {prev=NR}' src/docker-manager.ts 2>/dev/null | \
  awk -F': ' '$3 > 50 {print}' | head -20

# Functions with many parameters (>5)
echo "=== Functions with 5+ parameters ==="
grep -n "function.*(.*, .*, .*, .*, .*," src/docker-manager.ts src/cli.ts 2>/dev/null | head -20
```

## Phase 3: Detect Mixed Responsibilities

For large files, identify logical groupings that could become separate modules:

```bash
echo "=== docker-manager.ts: identify responsibility zones ==="
cat src/docker-manager.ts | grep -n "\/\/ ===\|\/\/ ---\|\/\*\*\s*$\|^export " | head -80

echo "=== Check for config-generation functions mixed into docker-manager.ts ==="
grep -n "generate\|config\|Config\|yaml\|YAML\|compose\|Compose" src/docker-manager.ts | head -30

echo "=== Check for volume/mount logic mixed into docker-manager.ts ==="
grep -n "volume\|mount\|bind\|Volume\|Mount" src/docker-manager.ts | head -20

echo "=== Check for cleanup/teardown logic ==="
grep -n "cleanup\|teardown\|stop\|remove\|Cleanup\|Stop\|Remove" src/docker-manager.ts | head -20

echo "=== cli.ts: check for logic that should be in docker-manager.ts ==="
grep -n "docker\|container\|compose\|volume" src/cli.ts | head -20
```

## Phase 4: Detect Test Files Exceeding 1,000 Lines

Large test files are hard to navigate and should be split by feature area:

```bash
find src -name "*.test.ts" -exec wc -l {} + 2>/dev/null | sort -rn | head -10

# For each test file > 500 lines, list the describe blocks
for f in src/*.test.ts; do
  [ -f "$f" ] || continue
  lines=$(wc -l < "$f")
  if [ "$lines" -gt 500 ]; then
    echo "=== $f ($lines lines): describe blocks ==="
    grep -n "^\s*describe(" "$f" | head -20
  fi
done
```

## Phase 5: Check for Existing Refactoring Issues

Before creating new issues, check the open issue tracker:

1. Search for open issues with `[Refactoring]` prefix using the GitHub toolset
2. Search for open issues with labels `code-quality` or `refactoring` mentioning the same file
3. Skip any finding that already has an open tracking issue

## Phase 6: Prioritize and File Issues

Score each refactoring candidate:

| Factor | Points |
|--------|--------|
| File > 3,000 lines | +4 |
| File > 1,500 lines | +2 |
| Clearly > 2 distinct responsibilities | +3 |
| Security-critical path | +2 |
| Functions > 80 lines | +2 |
| Nesting > 5 levels | +1 |

File issues only for candidates with score ≥ 4. Cap at 5 issues per run.

### Issue Format

**Title**: `[Refactoring] Split <file> into focused modules`

**Body**:
```markdown
## Refactoring Opportunity

### Summary
- **File**: `path/to/file.ts`
- **Current size**: X lines
- **Responsibilities identified**: N distinct concerns

### Evidence

<Specific evidence from the file showing mixed responsibilities or excessive size>

### Proposed Split

Describe the proposed extraction. For example:

**`src/docker-manager.ts`** (3,900 lines) could be split into:
- `src/container-lifecycle.ts` — start, stop, wait, healthcheck logic (~800 lines)
- `src/compose-generator.ts` — Docker Compose YAML generation (~600 lines)
- `src/volume-mounts.ts` — volume and bind mount construction (~400 lines)
- `src/docker-manager.ts` — orchestration facade remaining (~500 lines)

### Affected Callers

List files that import from this module that would need to be updated:
```bash
grep -rn "from.*docker-manager\|require.*docker-manager" src/ containers/ 2>/dev/null
```

### Effort Estimate
Low / Medium / High

### Benefits
- Easier to navigate and review
- Smaller surface area for individual features
- Enables focused testing per module

---
*Detected by Refactoring Scanner workflow. Run date: $(date -u +"%Y-%m-%d")*
```

## Guidelines

- **Evidence-based**: Every issue must cite specific line counts, function names, or code patterns
- **Actionable**: Propose a concrete split/extraction, not just "this is too big"
- **No duplication**: Always check existing issues before creating new ones
- **Security awareness**: Files containing security-critical logic (iptables, Squid config, domain validation) should be flagged with higher urgency
- **Be realistic**: Suggest splits that keep related logic together — don't over-fragment
- **Cap at 5 issues**: File at most 5 issues per run

## Edge Cases

- **No significant issues found**: Log a summary and exit without creating issues
- **All findings already tracked**: Skip creation and log that existing issues cover the findings
- **Cannot access file**: Log the error and continue with remaining files
