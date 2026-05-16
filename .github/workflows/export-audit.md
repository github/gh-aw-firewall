---
description: |
  Workflow triggered on every push to main that audits the TypeScript and JavaScript
  surface of the codebase: unused exports, inconsistent naming conventions, circular
  dependencies, and test files importing from incorrect modules. Files actionable issues
  to keep the API surface clean and prevent dead-code accumulation.

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  issues: read

sandbox:
  agent:
    id: awf
    version: v0.25.29
network:
  allowed:
    - github

tools:
  github:
    toolsets: [issues]
  bash: true

safe-outputs:
  threat-detection:
    enabled: false
  create-issue:
    title-prefix: "[Export Audit] "
    labels: [code-quality]
    max: 5
    expires: 30d

timeout-minutes: 20

steps:
  - name: Install dependencies
    run: set -o pipefail && npm ci 2>&1 | tail -5

  - name: Build TypeScript
    id: build
    run: set -o pipefail && npm run build 2>&1 | tail -10

  - name: Collect export inventory
    id: exports
    run: |
      {
        echo "EXPORTS<<EOF"
        echo "=== All exported symbols from src/ ==="
        grep -rn "^export[[:space:]]\+\(function\|class\|const\|let\|var\|type\|interface\|enum\)" src/ --include="*.ts" | \
          grep -v "\.test\.ts" | \
          sed 's|.*export[[:space:]]\+\(function\|class\|const\|let\|var\|type\|interface\|enum\)[[:space:]]\+\([a-zA-Z_][a-zA-Z0-9_]*\).*|\2|' | \
          sort | head -80
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Check for TypeScript compiler errors
    id: ts-errors
    run: |
      {
        echo "TS_ERRORS<<EOF"
        npx tsc --noEmit 2>&1 | head -40 || true
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Detect unused exports (ts-prune)
    id: unused_exports
    run: |
      {
        echo "UNUSED_EXPORTS<<EOF"
        npm install -g ts-prune@0.10.3 2>&1 | tail -5
        if command -v ts-prune >/dev/null 2>&1; then
          ts-prune | grep -v "\.test\.ts" | head -40
        else
          echo "ts-prune unavailable, falling back to grep analysis"
          grep -rn "^export " src/ --include="*.ts" | grep -v "\.test\.ts" | \
            while IFS=: read -r file line rest; do
              name=$(echo "$rest" | sed -n 's/.*export \(function\|class\|const\|type\|interface\|enum\) \([a-zA-Z_][a-zA-Z0-9_]*\).*/\2/p')
              [ -z "$name" ] && continue
              count=$(grep -rwn "${name}" src/ --include="*.ts" 2>/dev/null | grep -v "^${file}:" | wc -l)
              [ "$count" -eq 0 ] && echo "UNUSED: $name ($file:$line)"
            done | head -30
        fi
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Detect circular dependencies (madge)
    id: circular_deps
    run: |
      {
        echo "CIRCULAR_DEPS<<EOF"
        npm install -g madge@8.0.0 2>&1 | tail -5
        if command -v madge >/dev/null 2>&1; then
          madge --circular src/ 2>&1 | head -20
        else
          echo "madge unavailable, cannot check circular deps"
        fi
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Naming convention audit
    id: naming_audit
    run: |
      {
        echo "NAMING_ISSUES<<EOF"
        echo "=== Types/interfaces not in PascalCase ==="
        grep -rn "^export type\|^export interface" src/ --include="*.ts" | \
          grep -v "\.test\.ts" | \
          sed 's/.*export \(type\|interface\) \([a-zA-Z_][a-zA-Z0-9_]*\).*/\2/' | \
          grep -v "^[A-Z]" | head -20
        echo "=== api-proxy provider exports ==="
        for f in containers/api-proxy/providers/*.js; do
          [ -f "$f" ] || continue
          [ "$(basename "$f")" = "index.js" ] && continue
          echo "--- $(basename "$f") ---"
          grep -n "^module\.exports\|^exports\." "$f" | head -3
        done
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Audit test file imports
    id: test_imports
    run: |
      {
        echo "TEST_IMPORTS<<EOF"
        echo "=== Test files: imports from src/ ==="
        for f in src/*.test.ts; do
          [ -f "$f" ] || continue
          echo "--- $f ---"
          grep "^import\|^const.*=.*require" "$f" 2>/dev/null | head -5
        done | head -50
        echo "=== Check for tests importing from dist/ ==="
        grep -rn "from '.*dist/\|require('.*dist/" src/ --include="*.test.ts" | head -10
        echo "=== Check for tests reaching into private implementation ==="
        grep -rn "from '\.\.\/\.\.\/" src/ --include="*.test.ts" | head -10
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Audit api-proxy module exports
    id: apip_exports
    run: |
      {
        echo "APIP_EXPORTS<<EOF"
        echo "=== api-proxy/providers: export consistency ==="
        for f in containers/api-proxy/providers/*.js; do
          [ -f "$f" ] || continue
          [ "$(basename "$f")" = "index.js" ] && continue
          echo "--- $f ---"
          grep -n "^module\.exports\|^exports\." "$f" | head -5
        done | head -50
        echo "=== providers/index.js: registered providers ==="
        cat containers/api-proxy/providers/index.js 2>/dev/null | grep -n "require\|createAdapter\|register" | head -20
        echo "=== server.js: imports from providers ==="
        grep -n "require.*providers\|from.*providers" containers/api-proxy/server.js 2>/dev/null | head -10
        echo "EOF"
      } >> "$GITHUB_OUTPUT"
---

# API Surface & Export Audit

You are a code quality engineer auditing the `${{ github.repository }}` codebase for dead exports, naming inconsistencies, circular dependencies, and test isolation issues. Your mission is to keep the public API surface clean and prevent silent technical debt from accumulating after each merge to `main`.

## Repository Context

This is **gh-aw-firewall**, a network firewall for GitHub Copilot CLI. The TypeScript source lives in `src/` and is compiled to `dist/`. Container JavaScript lives in `containers/api-proxy/`.

## Phase 1: Review Unused Exports

The pre-computed unused exports analysis is provided in the **Pre-computed Data** section below (`UNUSED_EXPORTS`). Review the results and verify each finding by checking all import sites, including test files and barrel exports (`index.ts`). Pay special attention to multi-line import blocks — TypeScript imports often list each symbol on its own line, which a single-line grep will miss. Use `grep -w` (whole-word matching) for verification.

## Phase 2: Review Naming Conventions

The pre-computed naming audit is provided in the **Pre-computed Data** section below (`NAMING_ISSUES`). Review the results for:
- Types/interfaces not following PascalCase
- api-proxy provider export inconsistencies

Also verify function and constant naming conventions using the exported symbols sample:
- Functions: camelCase
- Types/interfaces: PascalCase
- Constants: UPPER_CASE or camelCase depending on context
- Files: kebab-case

## Phase 3: Review Circular Dependencies

The pre-computed circular dependency analysis is provided in the **Pre-computed Data** section below (`CIRCULAR_DEPS`). Review the results for any detected cycles between modules.

## Phase 4: Audit Test File Import Paths

Review the pre-computed test import audit (`TEST_IMPORTS`) to confirm test files import from correct modules and do not reach into private implementation details.

## Phase 5: Audit api-proxy Module Exports

Review the pre-computed api-proxy export audit (`APIP_EXPORTS`) and verify provider modules follow the adapter pattern and are consistently registered.

## Phase 6: Check for Existing Issues

Before creating new issues, check BOTH open AND closed issues:

1. Search for issues with `[Export Audit]` prefix mentioning the same symbol or file using `state: all` (or equivalent `is:open` + `is:closed`)
2. Search for issues with the `code-quality` label mentioning the same symbol or file using `state: all` (or equivalent `is:open` + `is:closed`)
3. Skip any finding that already has an open tracking issue
4. For matching closed issues, check the GitHub `state_reason`: **auto-skip only when `state_reason` is `not_planned`** (often shown as "won't fix" / "not planned"). If `state_reason` is `completed` and the finding still reproduces, reopen the prior issue or file a new one with fresh evidence and a link to the prior issue.

## Phase 7: Prioritize and File Issues

Score each finding:

| Category | Score |
|----------|-------|
| Exported public API symbol, never imported | +3 |
| Circular dependency between modules | +4 |
| Naming convention violation in exported type | +2 |
| Test importing from wrong location | +2 |
| Dead export in security-critical module | +2 |

File issues only for findings with score ≥ 3. Cap at 5 issues per run.

## Verification Budget

To control token usage, limit verification to the **top 10 candidates** by score. For each candidate:
- Run at most 2 bash commands to confirm (one broad `grep -rw`, one targeted check)
- If not confirmed in 2 checks, mark as "unconfirmed" and skip filing
- Do NOT loop over all files for each candidate — use whole-word grep across the whole repo in one command

### Issue Format

**Title**: `[Export Audit] <specific issue description>`

**Body**:
```markdown
## API Surface Issue

### Category
Unused export / Naming inconsistency / Circular dependency / Import path issue

### Summary
- **File**: `path/to/file.ts`
- **Symbol**: `symbolName`
- **Issue**: Brief description

### Evidence

<Specific grep output or analysis showing the problem>

### Recommended Fix

1. For **unused exports**: Remove the `export` keyword or delete the symbol if it's dead code
2. For **naming inconsistencies**: Rename to follow convention (types: PascalCase, functions: camelCase)
3. For **circular dependencies**: Extract the shared dependency into a new module
4. For **test imports**: Update the import path to reference the correct module

### Impact
- Dead code risk: <High/Medium/Low>
- Maintenance burden: <High/Medium/Low>

---
*Detected by Export Audit workflow. Triggered by push to main on $(date -u +"%Y-%m-%d")*
```

## Guidelines

- **Verify before filing**: Confirm that the export is truly unused by checking all import sites, including test files and any barrel exports (`index.ts`). Pay special attention to **multi-line import blocks** — TypeScript imports often list each symbol on its own line, which a single-line `import.*name` grep will miss entirely. The manual fallback script uses `grep -w` (whole-word matching) for this reason; apply the same logic during manual verification.
- **Be precise**: Include the exact symbol name, file path, and line number in the evidence
- **No duplicates**: Always check existing issues with `state: all`; only treat closed issues as terminal when `state_reason` is `not_planned`
- **Batch related findings**: If multiple unused exports are in the same file, file a single issue listing all of them
- **Cap at 5 issues**: File at most 5 issues per run to avoid noise

## Edge Cases

- **Build fails (TypeScript errors)**: Report the build errors in the log; skip the audit since analysis would be unreliable. Do NOT create issues for TypeScript errors — those are tracked separately.
- **ts-prune / madge unavailable**: Fall back to grep-based analysis with a note that results may be incomplete
- **All findings already tracked**: Skip creation and log that existing issues cover the findings
- **No issues found**: Log a summary and exit without creating issues

---

## Pre-computed Data

TypeScript build output:
```
${{ steps.ts-errors.outputs.TS_ERRORS }}
```

Exported symbols sample:
```
${{ steps.exports.outputs.EXPORTS }}
```

Unused exports:
```
${{ steps.unused_exports.outputs.UNUSED_EXPORTS }}
```

Circular dependencies:
```
${{ steps.circular_deps.outputs.CIRCULAR_DEPS }}
```

Naming issues:
```
${{ steps.naming_audit.outputs.NAMING_ISSUES }}
```

Test imports:
```
${{ steps.test_imports.outputs.TEST_IMPORTS }}
```

API proxy exports:
```
${{ steps.apip_exports.outputs.APIP_EXPORTS }}
```
