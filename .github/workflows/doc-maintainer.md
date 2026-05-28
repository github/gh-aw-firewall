---
description: Daily documentation review and sync with code changes from the past 7 days
on:
  schedule: daily
  workflow_dispatch:
  skip-if-match:
    query: 'is:pr is:open in:title "[docs]"'
    max: 1
permissions:
  contents: read
  issues: read
  pull-requests: read
sandbox:
  agent:
    id: awf
engine:
  id: claude
  model: claude-haiku-4-5
  max-turns: 15
tools:
  edit:
  bash: true
  github: false
safe-outputs:
  threat-detection:
    enabled: false
  create-pull-request:
    title-prefix: "[docs] "
    labels: [documentation, ai-generated]
    reviewers: copilot
    draft: false
timeout-minutes: 15
steps:
  - name: Ensure recent git history is available
    run: |
      if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
        git fetch --prune --unshallow
      fi
  - name: Check for relevant changes
    id: has-changes
    run: |
      mkdir -p /tmp/gh-aw/doc-maintainer-context
      COUNT=$(git log --since="7 days ago" --oneline -- src/ containers/ scripts/ | wc -l | tr -d ' ')
      HAS_CHANGES=false
      if [ "$COUNT" -gt 0 ]; then
        HAS_CHANGES=true
      fi
      {
        echo "changed_count=$COUNT"
        echo "has_changes=$HAS_CHANGES"
      } >> "$GITHUB_OUTPUT"
      printf '%s\n' "$COUNT" > /tmp/gh-aw/doc-maintainer-context/changed-count.txt
      printf '%s\n' "$HAS_CHANGES" > /tmp/gh-aw/doc-maintainer-context/has-changes.txt
  - name: Gather recent git diffs
    id: git-changes
    env:
      EXPR_STEPS_HAS_CHANGES_OUTPUTS_HAS_CHANGES: ${{ steps.has-changes.outputs.has_changes }}
    run: |
      CONTEXT_DIR=/tmp/gh-aw/doc-maintainer-context
      if [ "$EXPR_STEPS_HAS_CHANGES_OUTPUTS_HAS_CHANGES" = "true" ]; then
        git log --since="7 days ago" --format="=== Commit %H: %s ===" --patch --stat --unified=2 -- src/ containers/ scripts/ docs/ '*.md' | head -200 > "$CONTEXT_DIR/recent-diffs.txt"
      else
        echo "No relevant source changes detected in the past 7 days." > "$CONTEXT_DIR/recent-diffs.txt"
      fi
      DELIM="GH_AW_RECENT_DIFFS_$(date +%s%N)_$RANDOM"
      {
        echo "RECENT_DIFFS<<$DELIM"
        cat "$CONTEXT_DIR/recent-diffs.txt"
        echo "$DELIM"
      } >> "$GITHUB_OUTPUT"
  - name: List documentation files
    id: doc-files
    run: |
      CONTEXT_DIR=/tmp/gh-aw/doc-maintainer-context
      {
        find docs/ -name "*.md" 2>/dev/null
        find . -maxdepth 1 -name "*.md"
      } | sort > "$CONTEXT_DIR/doc-files.txt"
      DELIM="GH_AW_DOC_FILES_$(date +%s%N)_$RANDOM"
      {
        echo "DOC_FILES<<$DELIM"
        cat "$CONTEXT_DIR/doc-files.txt"
        echo "$DELIM"
      } >> "$GITHUB_OUTPUT"
  - name: Identify affected docs
    id: affected-docs
    env:
      EXPR_STEPS_HAS_CHANGES_OUTPUTS_HAS_CHANGES: ${{ steps.has-changes.outputs.has_changes }}
    run: |
      CONTEXT_DIR=/tmp/gh-aw/doc-maintainer-context
      DOC_POOL=$(mktemp)
      TOKENS=$(mktemp)
      AFFECTED=$(mktemp)

      cat "$CONTEXT_DIR/doc-files.txt" > "$DOC_POOL"

      if [ "$EXPR_STEPS_HAS_CHANGES_OUTPUTS_HAS_CHANGES" = "true" ]; then
        git log --since="7 days ago" --format="%H" -- src/ containers/ scripts/ | \
          while read -r sha; do
            git show --name-only --format="" "$sha" -- docs/ '*.md' 2>/dev/null
          done | grep -E '(^docs/.*\.md$|^[^/]+\.md$)' | sort -u | head -10 > "$AFFECTED" || true
      fi

      if [ ! -s "$AFFECTED" ] && [ "$EXPR_STEPS_HAS_CHANGES_OUTPUTS_HAS_CHANGES" = "true" ]; then
        git log --since="7 days ago" --name-only --format="" -- src/ containers/ scripts/ | \
          grep -v '^$' | sed -E 's|.*/||; s|\.[^.]+$||' | \
          tr '[:upper:]' '[:lower:]' | tr '[:punct:]' '\n' | grep -E '^[a-z0-9]{3,}$' | sort -u > "$TOKENS" || true
        if [ -s "$TOKENS" ]; then
          grep -i -F -f "$TOKENS" "$DOC_POOL" | head -10 > "$AFFECTED" || true
        fi
      fi

      if [ ! -s "$AFFECTED" ]; then
        head -10 "$DOC_POOL" > "$AFFECTED"
      fi

      cp "$AFFECTED" "$CONTEXT_DIR/affected-docs.txt"

      DELIM="GH_AW_AFFECTED_DOCS_$(date +%s%N)_$RANDOM"
      {
        echo "AFFECTED_DOCS<<$DELIM"
        cat "$CONTEXT_DIR/affected-docs.txt"
        echo "$DELIM"
      } >> "$GITHUB_OUTPUT"
---

# Documentation Maintainer

You are an AI agent responsible for keeping documentation synchronized with code changes in the gh-aw-firewall repository.

## Your Mission

Review git commits from the past 7 days, identify documentation that has drifted out of sync with code, and create a PR with the necessary updates.

## Context

This repository is a security-critical firewall for GitHub Copilot CLI. Accurate documentation is essential for safe usage. The documentation frequently drifts out of sync with code changes, especially:
- Architecture changes (Docker, containers, networking, iptables)
- CLI flag additions and modifications
- MCP configuration changes
- Security guidance updates

## Task Steps

### 0. Check For Changes First (Do This Before Anything Else)

Read `/tmp/gh-aw/doc-maintainer-context/has-changes.txt`.

- If `false`: call `safeoutputs noop` immediately and stop. Do not read any other files.
- If `true`: proceed to Step 1.

### 1. Analyze Pre-computed Changes

Read `/tmp/gh-aw/doc-maintainer-context/changed-count.txt`.

Use `/tmp/gh-aw/doc-maintainer-context/recent-diffs.txt` as your **sole source** for recent source changes. **Do not run any `git` commands** — all required git data is already pre-computed. Running `git show`, `git log`, or `git diff` wastes turns.

### 2. Identify Documentation Gaps

Review only the files listed in `/tmp/gh-aw/doc-maintainer-context/affected-docs.txt` (max 10 files) and identify what needs to be updated. Do not proactively read additional files not in this list.

### 3. Review Current Documentation

Review only `/tmp/gh-aw/doc-maintainer-context/affected-docs.txt`. Do not expand review scope to `/tmp/gh-aw/doc-maintainer-context/doc-files.txt`.

### 4. Verify Code Examples

For any code examples in documentation:
- Check that CLI commands use the correct flags
- Verify environment variable names match the code
- Ensure Docker configuration examples are current
- Validate that file paths referenced in examples exist

### 5. Make Documentation Updates

Use the edit tool to update documentation files:

- **Add missing documentation** for new features
- **Update outdated content** that no longer matches code
- **Fix broken examples** with correct syntax
- **Update version numbers** if applicable
- **Add deprecation notices** for removed features

Keep updates:
- Minimal and focused
- Consistent with existing style
- Clear and accurate

### 6. Create Pull Request

After making updates, the safe-outputs system will automatically create a PR. Include in your changes:

**PR Description**: Summarize updated docs, reference the triggering code changes, and list what was verified.

## Guidelines

- Be conservative, accurate, minimal, and consistent with existing style.
- Reference the commits that triggered your updates.

**Success**: Review 7-day commits, update out-of-sync docs, verify examples, and create a clear PR summary.

---

## Context for This Run

Pre-agent steps generate the following context files:

- `/tmp/gh-aw/doc-maintainer-context/has-changes.txt`
- `/tmp/gh-aw/doc-maintainer-context/changed-count.txt`
- `/tmp/gh-aw/doc-maintainer-context/recent-diffs.txt`
- `/tmp/gh-aw/doc-maintainer-context/affected-docs.txt`
- `/tmp/gh-aw/doc-maintainer-context/doc-files.txt`