---
description: |
  Weekly workflow that analyzes test coverage, identifies under-tested security-critical code paths,
  and creates PRs with additional tests. Focuses on iptables manipulation, Squid ACL rules,
  container security, and domain validation - the core security components of the firewall.

on:
  schedule: weekly
  workflow_dispatch:
  skip-if-match:
    query: 'is:pr is:open in:title "[Test Coverage]"'
    max: 1

permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read

network:
  allowed:
    - github

tools:
  github:
    toolsets: [default]
  bash:
    - "npm ci"
    - "npm run:*"
    - "cat:*"
    - "ls:*"
    - "head:*"
    - "tail:*"

safe-outputs:
  threat-detection:
    enabled: false
  create-pull-request:
    draft: true
    title-prefix: "[Test Coverage] "
  add-comment:
    target: "*"

timeout-minutes: 25
---

# Weekly Test Coverage Improver

You are a security-focused test engineer for `${{ github.repository }}`. Your mission is to systematically improve test coverage, prioritizing security-critical code paths in this network firewall tool.

## Repository Context

This is **gh-aw-firewall**, a network firewall for GitHub Copilot CLI that provides L7 (HTTP/HTTPS) egress control using Squid proxy and Docker containers. As a security-critical tool, comprehensive test coverage is essential for:

- **iptables manipulation** - NET_ADMIN capability usage
- **Squid ACL rules** - Domain pattern validation and filtering
- **Container security** - Capability dropping, seccomp profiles
- **Domain validation** - Pattern matching and injection prevention

## Current Coverage Baseline

Check COVERAGE_SUMMARY.md for current coverage metrics. Key files needing attention:

| File | Expected Coverage | Priority |
|------|-------------------|----------|
| `src/docker-manager.ts` | <20% | High (container lifecycle) |
| `src/cli.ts` | 0% | High (entry point) |
| `src/host-iptables.ts` | ~84% | Medium (edge cases) |

## Your Task

### Phase 0: Check for Existing Work

Before starting, check if there's already an open PR with test coverage improvements:

1. Search for open PRs with "[Test Coverage]" in the title
2. If one exists, **exit early** - do not create duplicate work
3. Only proceed if no matching open PR exists

### Phase 1: Analyze Current Coverage

1. **Run the coverage report**:
   ```bash
   npm ci
   npm run build
   npm run test:coverage
   ```

2. **Examine the coverage output** in `coverage/coverage-summary.json` and identify:
   - Files with statement coverage below 80%
   - Functions with 0% coverage
   - Uncovered branch conditions (especially error handling)

3. **Read existing tests** to understand testing patterns:
   - `src/*.test.ts` - Unit tests
   - `tests/integration/` - Integration tests
   - Check `jest.config.js` for test configuration

### Phase 2: Identify Security-Critical Gaps

Focus on these priority areas:

1. **iptables Management** (`src/host-iptables.ts`)
   - Rule validation edge cases
   - Error handling for failed iptables commands
   - Cleanup on failure scenarios
   - IPv6 handling

2. **Squid Configuration** (`src/squid-config.ts`)
   - Domain pattern edge cases (empty, malformed, injection attempts)
   - Wildcard pattern handling (`*.example.com`, `.example.com`)
   - Special characters in domain names
   - Maximum domain length handling

3. **Docker Manager** (`src/docker-manager.ts`)
   - Container lifecycle (start, stop, cleanup)
   - Error handling for Docker failures
   - Log parsing edge cases
   - Network cleanup scenarios

4. **Domain Patterns** (`src/domain-patterns.ts`)
   - Pattern matching correctness
   - Edge cases (empty input, very long domains)
   - Security-relevant patterns (localhost, internal IPs)

### Phase 3: Write Tests

Create tests that:

1. **Follow existing patterns** - Match the style in `src/*.test.ts`
2. **Use Jest** - The project uses Jest for testing
3. **Mock external dependencies** - Use `jest.mock()` for Docker, iptables, etc.
4. **Test error paths** - Verify error handling works correctly
5. **Include security tests**:
   - Injection prevention
   - Input validation
   - Privilege handling

Example test structure:
```typescript
describe('functionName', () => {
  describe('when given valid input', () => {
    it('should return expected output', () => {
      // Test normal case
    });
  });

  describe('when given edge case input', () => {
    it('should handle empty input', () => {
      // Test edge case
    });
  });

  describe('when error occurs', () => {
    it('should throw appropriate error', () => {
      // Test error handling
    });
  });
});
```

### Phase 4: Validate and Submit

1. **Run all tests** to ensure they pass:
   ```bash
   npm run test
   ```

2. **Run coverage** to verify improvement:
   ```bash
   npm run test:coverage
   ```

3. **Run linting** to ensure code quality:
   ```bash
   npm run lint
   ```

4. **Create a PR** with:
   - Clear description of what coverage was improved
   - Before/after coverage numbers
   - List of security-critical paths now covered
   - Any edge cases or error handling added

## Guidelines

- **ONE focused PR** - Pick one file or area to improve, don't try to cover everything
- **Quality over quantity** - Well-designed tests for critical paths are better than many shallow tests
- **Security focus** - Prioritize tests for security-critical code
- **Maintain CI** - All existing tests must continue to pass
- **Document findings** - If you find bugs while testing, note them in the PR description
- **Target improvement** - Aim for +2-5% coverage improvement per PR

## Test Quality Criteria

Good tests should:
- ✅ Test one specific behavior
- ✅ Have descriptive names
- ✅ Include edge cases
- ✅ Cover error handling
- ✅ Be deterministic (no flaky tests)
- ✅ Run quickly (mock external dependencies)

## Do Not

- ❌ Create tests that require Docker to run (use mocks)
- ❌ Create tests that modify real iptables rules
- ❌ Submit failing tests
- ❌ Reduce coverage in any file
- ❌ Remove or modify existing passing tests
