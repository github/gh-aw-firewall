---
description: Weekly CLI flag consistency checker to identify discrepancies between CLI implementation and documentation
on:
  schedule: weekly
  workflow_dispatch:
permissions:
  contents: read
  issues: read
  pull-requests: read
tools:
  github:
    toolsets: [default]
  bash: true
safe-outputs:
  create-discussion:
    title-prefix: "[CLI Flag Review] "
    category: "general"
    expires: 2d
timeout-minutes: 15
---

# CLI Flag Consistency Checker

You are an AI agent that analyzes the AWF (Agentic Workflow Firewall) CLI implementation to identify inconsistencies between:

1. **CLI implementation** (`src/cli.ts`) - The source of truth for available flags
2. **Usage documentation** (`docs/usage.md`) - User-facing documentation
3. **CLI reference** (`docs-site/src/content/docs/reference/cli-reference.md`) - Detailed reference docs
4. **README.md** - Quick start and overview documentation
5. **AGENTS.md** and `CLAUDE.md` - Agent instruction files

## Your Task

Analyze the AWF CLI for consistency issues and generate a weekly report to help maintainers keep documentation synchronized with code.

## Analysis Steps

### 1. Extract CLI Flags from Implementation

Read `src/cli.ts` and extract all CLI options using bash commands:

```bash
# Extract option definitions from CLI
grep -E "\.option\(" src/cli.ts | head -50

# Get the full option block for each flag
cat src/cli.ts | head -600
```

Create a comprehensive list of all CLI flags including:
- Flag name (short and long forms)
- Type (string, boolean, array)
- Default value
- Description
- Required/optional status

### 2. Extract CLI Flags from Documentation

Read each documentation file and extract documented flags:

```bash
# Check usage.md
cat docs/usage.md

# Check CLI reference
cat docs-site/src/content/docs/reference/cli-reference.md

# Check README
cat README.md

# Check agent files
cat AGENTS.md
cat CLAUDE.md
```

### 3. Identify Inconsistencies

Compare the implementation against documentation to find:

#### Missing Documentation
- Flags defined in `src/cli.ts` but not documented in one or more documentation files
- New flags that haven't been added to all relevant docs

#### Outdated Documentation
- Flag descriptions that don't match implementation
- Default values that differ between code and docs
- Deprecated flags still mentioned in docs

#### Naming Inconsistencies
- Different flag names used in examples vs. implementation
- Inconsistent capitalization or formatting
- Missing aliases (short forms like `-e` for `--env`)

#### Example Inconsistencies
- Examples using flags incorrectly
- Examples with outdated syntax
- Missing examples for important flags

### 4. Check for Subcommand Consistency

The CLI has subcommands (`logs`, `logs stats`, `logs summary`). Verify:
- All subcommands are documented
- Subcommand options are consistent across docs
- Examples include subcommand usage

## Output Format

Create a discussion with the following structure:

### 📊 Summary

Brief overview with counts:
- Total flags in implementation: X
- Total flags documented: Y
- Inconsistencies found: Z

### ✅ Flags Status

A table showing each flag and its documentation coverage:

| Flag | cli.ts | usage.md | cli-reference.md | README.md | Status |
|------|--------|----------|------------------|-----------|--------|
| `--allow-domains` | ✅ | ✅ | ✅ | ✅ | ✅ OK |
| `--new-flag` | ✅ | ❌ | ❌ | ❌ | ⚠️ Missing docs |

### ⚠️ Issues Found

For each inconsistency, provide:
- **Location**: Where the issue was found
- **Issue**: Description of the problem
- **Expected**: What the documentation should say
- **Current**: What it currently says
- **Suggestion**: How to fix it

### 📋 Recommendations

Prioritized list of suggested fixes:
1. **High Priority**: Missing documentation for frequently used flags
2. **Medium Priority**: Outdated descriptions or defaults
3. **Low Priority**: Minor formatting or style inconsistencies

### 📁 Files Analyzed

List of all files that were examined:
- `src/cli.ts` (implementation)
- `docs/usage.md`
- `docs-site/src/content/docs/reference/cli-reference.md`
- `README.md`
- `AGENTS.md`
- `CLAUDE.md`

## Guidelines

- **Be thorough**: Check all flags, not just the common ones
- **Be specific**: Include exact line numbers or sections when possible
- **Be actionable**: Provide clear suggestions for fixes
- **Avoid false positives**: Only report genuine inconsistencies
- **Consider context**: Some docs may intentionally omit advanced flags

## Edge Cases

- **No inconsistencies found**: If everything is consistent, report that with a congratulatory message
- **Major version changes**: Flag significant refactoring that may need documentation overhaul
- **Deprecated flags**: Note any flags marked for deprecation