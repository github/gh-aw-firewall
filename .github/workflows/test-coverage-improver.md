---
description: |
  Daily workflow that analyzes test coverage, identifies under-tested security-critical code paths,
  and creates PRs with additional tests. Focuses on iptables manipulation, Squid ACL rules,
  container security, and domain validation - the core security components of the firewall.

on:
  schedule:
    - cron: '0 8 * * *'
  workflow_dispatch:
  skip-if-match:
    query: 'is:pr is:open in:title "[Test Coverage]"'
    max: 1

permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read

sandbox:
  agent:
    id: awf
network:
  allowed:
    - github

tools:
  github:
    toolsets: [repos]
  bash:
    - "npm run test"
    - "npm run lint"
    - "node:*"
    - "./node_modules/.bin/jest:*"
    - "./node_modules/.bin/eslint:*"
    - "cat:src/*.test.ts"
    - "cat:jest.config.js"
    - "cat:jest.config.ts"

safe-outputs:
  threat-detection:
    enabled: false
  create-pull-request:
    draft: true
    title-prefix: "[Test Coverage] "
  add-comment:
    target: "*"

timeout-minutes: 25

steps:
  - name: Install dependencies
    run: npm ci

  - name: Build
    run: npm run build

  - name: Run coverage
    run: npm run test:coverage 2>&1 | tail -10
    id: coverage

  - name: Read COVERAGE_SUMMARY.md
    id: coverage-md
    run: |
      {
        echo "COVERAGE_MD<<EOF"
        cat COVERAGE_SUMMARY.md 2>/dev/null || echo "(COVERAGE_SUMMARY.md not found)"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Select target file and inject content
    id: target
    run: |
      TARGET=$(node -e "
        const d = JSON.parse(require('fs').readFileSync('coverage/coverage-summary.json','utf8'));
        const priority = ['src/docker-manager.ts','src/cli.ts','src/host-iptables.ts','src/squid-config.ts','src/domain-patterns.ts'];
        const low = priority.find(f => {
          const key = Object.keys(d).find(k => k !== 'total' && k.endsWith('/' + f));
          return key && d[key]?.statements?.pct < 80;
        });
        console.log(low || priority[0]);
      " 2>/dev/null || echo "src/docker-manager.ts")
      echo "TARGET_FILE=$TARGET" >> "$GITHUB_OUTPUT"
      {
        echo "SOURCE_CONTENT<<EOF"
        cat "$TARGET" 2>/dev/null || echo "(not found)"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"
      TEST_FILE="${TARGET%.ts}.test.ts"
      echo "TARGET_TEST_FILE=$TEST_FILE" >> "$GITHUB_OUTPUT"
      {
        echo "TEST_CONTENT<<EOF"
        cat "$TEST_FILE" 2>/dev/null || echo "(test file does not exist yet)"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: List files below 80% coverage
    id: low-coverage
    run: |
      {
        echo "LOW_COVERAGE<<EOF"
        node -e "
          const d = JSON.parse(require('fs').readFileSync('coverage/coverage-summary.json', 'utf8'));
          const low = Object.entries(d)
            .filter(([k, v]) => k !== 'total' && v.statements.pct < 80)
            .sort((a, b) => a[1].statements.pct - b[1].statements.pct);
          if (low.length === 0) { console.log('All files are above 80% coverage.'); }
          else { low.forEach(([k, v]) => console.log(k + ' \u2014 ' + v.statements.pct + '%')); }
        " 2>/dev/null || echo "(coverage summary not available)"
        echo "EOF"
      } >> "$GITHUB_OUTPUT"

  - name: Verify injected context
    env:
      COVERAGE_MD: ${{ steps.coverage-md.outputs.COVERAGE_MD }}
      LOW_COVERAGE: ${{ steps.low-coverage.outputs.LOW_COVERAGE }}
      SOURCE_CONTENT: ${{ steps.target.outputs.SOURCE_CONTENT }}
      TARGET_FILE: ${{ steps.target.outputs.TARGET_FILE }}
      TARGET_TEST_FILE: ${{ steps.target.outputs.TARGET_TEST_FILE }}
      TEST_CONTENT: ${{ steps.target.outputs.TEST_CONTENT }}
    run: |
      echo "TARGET_FILE: $TARGET_FILE"
      echo "TARGET_TEST_FILE: $TARGET_TEST_FILE"
      [ -n "$TARGET_FILE" ] || { echo "::error::TARGET_FILE empty"; exit 1; }
      [ -n "$TARGET_TEST_FILE" ] || { echo "::error::TARGET_TEST_FILE empty"; exit 1; }
      [ -n "$SOURCE_CONTENT" ] || { echo "::error::SOURCE_CONTENT empty"; exit 1; }
      [ -n "$TEST_CONTENT" ] || { echo "::error::TEST_CONTENT empty"; exit 1; }
      [ -n "$COVERAGE_MD" ] || { echo "::error::COVERAGE_MD empty"; exit 1; }
      [ -n "$LOW_COVERAGE" ] || { echo "::error::LOW_COVERAGE empty"; exit 1; }

---

# Test Coverage Improver

You are a security-focused test engineer for `${{ github.repository }}`. Your mission is to systematically improve test coverage, prioritizing security-critical code paths in this network firewall tool.

## Repository Context

This is **gh-aw-firewall**, a network firewall for GitHub Copilot CLI that provides L7 (HTTP/HTTPS) egress control using Squid proxy and Docker containers. As a security-critical tool, comprehensive test coverage is essential for:

- **iptables manipulation** - NET_ADMIN capability usage
- **Squid ACL rules** - Domain pattern validation and filtering
- **Container security** - Capability dropping, seccomp profiles
- **Domain validation** - Pattern matching and injection prevention

## Turn Budget

**Complete this task in ≤ 10 tool calls.** The target file and its current tests are already injected below — do not re-read them unless the injected section is unexpectedly empty. The coverage summary is already provided. Jump directly to writing tests.

Expected sequence:
1. Write the new/updated test file (1 call)
2. Targeted rerun only when needed: `./node_modules/.bin/jest --testPathPattern=<file> --no-coverage 2>&1 | tail -60`
3. `npm run test` (1 call, final verification only)
4. `npm run lint` (1 call) — fix any issues in ≤ 1 more call
5. Create PR (1 call)

## Your Task

The target file is pre-selected below. Write Jest unit tests that:
- Cover uncovered functions and branches identified in the coverage data
- Use `jest.mock()` for Docker/iptables/fs dependencies — no real Docker or iptables calls
- Follow the style of `${{ steps.target.outputs.TARGET_TEST_FILE }}` when it exists. Do not glob-read `src/*.test.ts` for style reference.
- Focus on error-handling paths and edge cases (empty input, malformed domains, failures)
- Do NOT modify or remove existing passing tests

If the injected target section below is unexpectedly empty, use `cat` to read `${{ steps.target.outputs.TARGET_FILE }}` directly before writing tests.

Run targeted Jest reruns only when fixing failures, run full `npm run test` at most once for final verification, then run `npm run lint` and open a draft PR titled `[Test Coverage] <target-file>`.

## Target File (pre-selected)

**File to improve:** `${{ steps.target.outputs.TARGET_FILE }}`

The source file content and existing test file content are injected below. Do not use `cat` tools to re-read them.

### Source: `${{ steps.target.outputs.TARGET_FILE }}`
```typescript
${{ steps.target.outputs.SOURCE_CONTENT }}
```

### Existing tests (if any)
```typescript
${{ steps.target.outputs.TEST_CONTENT }}
```

## Current Coverage Status

Use this run-specific context after reviewing the static guidance above.

| File | Expected Coverage | Priority |
|------|-------------------|----------|
| `src/docker-manager.ts` | <20% | High (container lifecycle) |
| `src/cli.ts` | 0% | High (entry point) |
| `src/host-iptables.ts` | ~84% | Medium (edge cases) |

### COVERAGE_SUMMARY.md

```
${{ steps.coverage-md.outputs.COVERAGE_MD }}
```

### Files Below 80% Coverage

```
${{ steps.low-coverage.outputs.LOW_COVERAGE }}
```
