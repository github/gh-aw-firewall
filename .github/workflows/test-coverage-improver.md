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
  copilot-requests: write
  contents: read
  actions: read
  issues: read
  pull-requests: read

env:
  COPILOT_MODEL: claude-haiku-4-5

sandbox:
  agent:
    id: awf
strict: false
network:
  allowed:
    - github

tools:
  github:
    toolsets: [repos]
  bash:
    - "node:*"
    - "./node_modules/.bin/jest:*"
    - "./node_modules/.bin/eslint:*"
    - "cat:jest.config.js"
    - "cat:jest.config.ts"
    - "cat:/tmp/gh-aw/agent/target-file.txt"
    - "cat:/tmp/gh-aw/agent/target-test-file.txt"
    - "cat:/tmp/gh-aw/agent/source-content.txt"
    - "cat:/tmp/gh-aw/agent/test-content.txt"
    - "cat:/tmp/gh-aw/agent/coverage-md.txt"
    - "cat:/tmp/gh-aw/agent/low-coverage.txt"

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
    run: |
      mkdir -p /tmp/gh-aw/agent
      cat COVERAGE_SUMMARY.md > /tmp/gh-aw/agent/coverage-md.txt 2>/dev/null || echo "(COVERAGE_SUMMARY.md not found)" > /tmp/gh-aw/agent/coverage-md.txt

  - name: Select target file and inject content
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
      mkdir -p /tmp/gh-aw/agent
      echo "$TARGET" > /tmp/gh-aw/agent/target-file.txt
      cat "$TARGET" > /tmp/gh-aw/agent/source-content.txt 2>/dev/null || echo "(not found)" > /tmp/gh-aw/agent/source-content.txt
      TEST_FILE="${TARGET%.ts}.test.ts"
      echo "$TEST_FILE" > /tmp/gh-aw/agent/target-test-file.txt
      cat "$TEST_FILE" > /tmp/gh-aw/agent/test-content.txt 2>/dev/null || echo "(test file does not exist yet)" > /tmp/gh-aw/agent/test-content.txt

  - name: List files below 80% coverage
    run: |
      {
        node -e "
          const d = JSON.parse(require('fs').readFileSync('coverage/coverage-summary.json', 'utf8'));
          const low = Object.entries(d)
            .filter(([k, v]) => k !== 'total' && v.statements.pct < 80)
            .sort((a, b) => a[1].statements.pct - b[1].statements.pct);
          if (low.length === 0) { console.log('All files are above 80% coverage.'); }
          else { low.forEach(([k, v]) => console.log(k + ' \u2014 ' + v.statements.pct + '%')); }
        " 2>/dev/null || echo "(coverage summary not available)"
      } > /tmp/gh-aw/agent/low-coverage.txt

  - name: Verify injected context
    run: |
      TARGET_FILE=$(cat /tmp/gh-aw/agent/target-file.txt)
      TARGET_TEST_FILE=$(cat /tmp/gh-aw/agent/target-test-file.txt)
      echo "TARGET_FILE: $TARGET_FILE"
      echo "TARGET_TEST_FILE: $TARGET_TEST_FILE"
      [ -n "$TARGET_FILE" ] || { echo "::error::TARGET_FILE empty"; exit 1; }
      [ -n "$TARGET_TEST_FILE" ] || { echo "::error::TARGET_TEST_FILE empty"; exit 1; }
      [ -s /tmp/gh-aw/agent/source-content.txt ] || { echo "::error::source-content.txt empty"; exit 1; }
      [ -s /tmp/gh-aw/agent/test-content.txt ] || { echo "::error::test-content.txt empty"; exit 1; }
      [ -s /tmp/gh-aw/agent/coverage-md.txt ] || { echo "::error::coverage-md.txt empty"; exit 1; }
      [ -s /tmp/gh-aw/agent/low-coverage.txt ] || { echo "::error::low-coverage.txt empty"; exit 1; }

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

**Complete this task in ≤ 7 tool calls.** Start with one batched read of all staged files before writing tests.

Expected sequence:
1. Read all staged files (1 call): `cat /tmp/gh-aw/agent/target-file.txt /tmp/gh-aw/agent/source-content.txt /tmp/gh-aw/agent/test-content.txt /tmp/gh-aw/agent/coverage-md.txt /tmp/gh-aw/agent/low-coverage.txt`
2. Write the new/updated test file (1 call)
3. Targeted rerun only when needed: `./node_modules/.bin/jest --testPathPattern=<file> --no-coverage 2>&1 | tail -60`
4. Optional targeted lint for changed test file only: `./node_modules/.bin/eslint <file> --max-warnings=0`
5. Create PR (1 call)

## Your Task

The target file is pre-selected below. Read the staged files first (see Turn Budget step 1), then write Jest unit tests that:
- Cover uncovered functions and branches identified in the coverage data
- Use `jest.mock()` for Docker/iptables/fs dependencies — no real Docker or iptables calls
- Follow the style of the existing test file when it exists. Do not glob-read `src/*.test.ts` for style reference.
- Focus on error-handling paths and edge cases (empty input, malformed domains, failures)
- Do NOT modify or remove existing passing tests

Run targeted Jest reruns only when fixing failures, do not run full-suite `npm run test` or `npm run lint` in this workflow, and open a draft PR titled `[Test Coverage] <target-file>`.

## Target File (pre-selected)

**File to improve:** read from `/tmp/gh-aw/agent/target-file.txt`

Read all staged files with a single batched cat command (see Turn Budget step 1):

- Source implementation: `/tmp/gh-aw/agent/source-content.txt`
- Existing test file (if any): `/tmp/gh-aw/agent/test-content.txt`
- Test file path: `/tmp/gh-aw/agent/target-test-file.txt`

## Current Coverage Status

Use this run-specific context after reviewing the static guidance above.

| File | Expected Coverage | Priority |
|------|-------------------|----------|
| `src/docker-manager.ts` | <20% | High (container lifecycle) |
| `src/cli.ts` | 0% | High (entry point) |
| `src/host-iptables.ts` | ~84% | Medium (edge cases) |

### COVERAGE_SUMMARY.md

```
(see `/tmp/gh-aw/agent/coverage-md.txt`)
```

### Files Below 80% Coverage

```
(see `/tmp/gh-aw/agent/low-coverage.txt`)
```
