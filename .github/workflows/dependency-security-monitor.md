---
description: |
  Daily workflow that monitors dependencies for security vulnerabilities, creates issues for HIGH/CRITICAL CVEs,
  and proposes safe dependency updates. Detects vulnerabilities within 24 hours, creates actionable security
  issues, and bundles safe patch-level updates into a single pull request.

on:
  schedule: daily
  workflow_dispatch:

permissions:
  contents: read
  issues: read
  pull-requests: read
  security-events: read

imports:
  - shared/mcp-pagination.md

tools:
  github:
    toolsets: [default, code_security, dependabot]
  bash: true

network:
  allowed:
    - node

safe-outputs:
  create-issue:
    title-prefix: "[Security] "
    labels: [security, dependencies]
    max: 10
    expires: 3d
  create-pull-request:
    title-prefix: "[Deps] "
    labels: [dependencies, automated]
    draft: true
    expires: 7d
  add-comment:
    max: 5
    target: "*"

timeout-minutes: 10
---

# Dependency Security Monitor

You are a security-focused AI agent responsible for monitoring the dependency health of the `${{ github.repository }}` repository. This is a security-critical firewall tool, so maintaining secure dependencies is paramount.

## Your Mission

Proactively monitor dependencies for security vulnerabilities, create actionable issues for HIGH/CRITICAL CVEs within 24 hours, and propose safe dependency updates to keep the project secure.

## Current Context

- **Repository**: ${{ github.repository }}
- **Run Time**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Phase 1: Vulnerability Assessment

### 1.1 Check for Known Vulnerabilities

Run `npm audit` to identify known security vulnerabilities in dependencies:

```bash
# Run npm audit and capture JSON output for analysis
npm audit --json 2>/dev/null || true

# Get human-readable summary
npm audit 2>/dev/null || true
```

Parse the audit results and categorize vulnerabilities by severity:

| Severity | Action Required | Timeline |
|----------|-----------------|----------|
| CRITICAL | Create issue immediately with urgent label | Immediate |
| HIGH | Create issue with security label | Within 24 hours |
| MODERATE | Track for weekly summary (note only) | Within 7 days |
| LOW | Track for next update cycle (note only) | Next release |

### 1.2 Check Dependabot Alerts

Use the GitHub API to check for Dependabot security alerts:

1. Use `list_dependabot_alerts` to get all open alerts
2. Use `get_dependabot_alert` for detailed information on each alert
3. Correlate with npm audit findings to avoid duplicates

### 1.3 Check for Existing Security Issues

Before creating new issues, search for existing security issues to avoid duplicates:

1. Search for open issues with the `security` and `dependencies` labels
2. Check if the vulnerability is already being tracked
3. Only create new issues for vulnerabilities not already tracked

## Phase 2: Create Security Issues for HIGH/CRITICAL Vulnerabilities

For each HIGH or CRITICAL vulnerability found that is not already tracked, create a security issue with:

### Issue Format

**Title**: `[CVE-XXXX-XXXXX] Vulnerability in <package-name>`

**Body** (use this template):

```markdown
## Security Vulnerability Report

### Summary
- **Package**: `<package-name>`
- **Affected Version**: `<current-version>`
- **Severity**: `<CRITICAL|HIGH>`
- **CVE**: `<CVE-ID if available>`
- **CVSS Score**: `<score if available>`

### Vulnerability Details
<Description of the vulnerability and its potential impact>

### Impact on gh-aw-firewall
<Analysis of how this vulnerability could affect the firewall functionality>

### Remediation Steps

1. **Recommended Fix**: Update to version `<fixed-version>`
2. **Command**: `npm update <package-name>` or `npm install <package-name>@<fixed-version>`
3. **Workarounds**: <Any temporary mitigations if update not immediately possible>

### Testing Required
- [ ] Run full test suite after update
- [ ] Verify firewall functionality
- [ ] Test Docker container builds

### References
- [Advisory Link](<link to security advisory>)
- [Package Changelog](<link to changelog>)

### Detection Details
- **Detected by**: Dependency Security Monitor Workflow
- **Detection Time**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- **Source**: npm audit / Dependabot
```

Use the `create_issue` safe output for each HIGH/CRITICAL vulnerability.

## Phase 3: Propose Safe Dependency Updates

After addressing critical security issues, identify and bundle safe dependency updates:

### 3.1 Identify Safe Updates

Safe updates are defined as:
- **Patch version updates** of direct dependencies (x.y.Z → x.y.Z+1)
- Updates that do not have breaking changes documented
- Updates that fix security vulnerabilities
- Updates where the test suite passes

Run the following to identify available updates:

```bash
# Check for outdated packages
npm outdated --json 2>/dev/null || true

# List direct dependencies only
npm outdated --depth=0 2>/dev/null || true
```

### 3.2 Apply Safe Updates

For each identified safe update:

1. Update the package version in `package.json`
2. Run `npm install` to update `package-lock.json`
3. Run the test suite to verify no regressions:
   ```bash
   npm test
   ```
4. If tests fail, revert the problematic update and document the issue

### 3.3 Create a Single Pull Request

Bundle all successful safe updates into ONE pull request with:

**Title**: `Safe dependency updates ($(date +%Y-%m-%d))`

**Body**:
```markdown
## Automated Safe Dependency Updates

This PR contains safe patch-level dependency updates that have been verified to:
- ✅ Pass all tests
- ✅ Have no breaking changes
- ✅ Address known security vulnerabilities (where applicable)

### Updated Dependencies

| Package | Previous | Updated | Type |
|---------|----------|---------|------|
| <package> | <old-version> | <new-version> | patch |

### Security Fixes Included
<List any CVEs or security issues addressed by these updates>

### Verification
- [x] All tests pass
- [x] No breaking changes detected
- [x] Docker build verified (if applicable)

### Notes
<Any important notes about specific updates>

---
Generated by Dependency Security Monitor Workflow
```

## Phase 4: Summary Report

After completing all phases, provide a summary:

### Vulnerability Summary
- **CRITICAL**: X vulnerabilities found, X issues created
- **HIGH**: X vulnerabilities found, X issues created  
- **MODERATE**: X vulnerabilities noted for weekly review
- **LOW**: X vulnerabilities tracked for next cycle

### Update Summary
- **Safe updates applied**: X packages
- **Updates requiring review**: X packages (with reasons)
- **Updates skipped**: X packages (incompatible with Node version, breaking changes, etc.)

### Dependency Freshness
- **Average dependency age**: X days
- **Dependencies > 30 days old**: X
- **Dependencies > 90 days old**: X (consider major updates)

## Guidelines

- **Be conservative**: Only apply updates you're confident are safe
- **Prioritize security**: CRITICAL and HIGH severity issues take precedence
- **Avoid duplicates**: Always check for existing issues before creating new ones
- **Document everything**: Include detailed reasoning in issues and PRs
- **Test thoroughly**: Never merge updates that break tests
- **One PR per run**: Bundle all safe updates into a single PR to reduce noise
- **Respect timeouts**: Complete within the 10-minute timeout

## Error Handling

- If `npm audit` fails, log the error and continue with Dependabot alerts
- If PR creation fails, ensure issues are still created for vulnerabilities
- If tests fail during updates, document which packages caused failures
- Always complete the vulnerability assessment even if updates fail