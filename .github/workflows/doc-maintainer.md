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
if: needs.check_relevant_changes.outputs.has_changes == 'true' && needs.check_relevant_changes.outputs.skip_agent != 'true'
jobs:
  check_relevant_changes:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      has_changes: ${{ steps.check.outputs.has_changes }}
      changed_count: ${{ steps.check.outputs.changed_count }}
      skip_agent: ${{ steps.check.outputs.skip_agent }}
    steps:
      - name: Checkout
        uses: actions/checkout@v6.0.3
        with:
          fetch-depth: 0
      - name: Check for relevant changes
        id: check
        run: |
          DIFF_PREVIEW=$(mktemp)
          COUNT=$(git log --since="7 days ago" --oneline -- src/ containers/ scripts/ | wc -l | tr -d ' ')
          git log --since="7 days ago" --format="=== Commit %H: %s ===" --patch --stat --unified=1 -- src/ containers/ scripts/ docs/ '*.md' | grep -v '^Binary' | head -50 > "$DIFF_PREVIEW"
          DIFF_BYTES=$(wc -c < "$DIFF_PREVIEW" | tr -d ' ')
          HAS_CHANGES=false
          SKIP_AGENT=false
          if [ "$COUNT" -gt 0 ]; then
            HAS_CHANGES=true
          fi
          if [ "$HAS_CHANGES" = "true" ] && [ "$DIFF_BYTES" -lt 100 ]; then
            SKIP_AGENT=true
            echo "::warning::Recent diffs are minimal ($DIFF_BYTES bytes). Skipping agent run."
          fi
          {
            echo "changed_count=$COUNT"
            echo "has_changes=$HAS_CHANGES"
            echo "skip_agent=$SKIP_AGENT"
          } >> "$GITHUB_OUTPUT"
max-turns: 8
engine:
  id: claude
  model: claude-haiku-4-5
tools:
  edit:
  bash: false
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
  - name: Build documentation maintainer context
    id: context
    env:
      EXPR_NEEDS_CHECK_RELEVANT_CHANGES_OUTPUTS_CHANGED_COUNT: ${{ needs.check_relevant_changes.outputs.changed_count }}
    run: |
      CONTEXT_DIR=/tmp/gh-aw/doc-maintainer-context
      mkdir -p "$CONTEXT_DIR"
      DOC_POOL=$(mktemp)
      TOKENS=$(mktemp)
      AFFECTED=$(mktemp)
      COUNT="$EXPR_NEEDS_CHECK_RELEVANT_CHANGES_OUTPUTS_CHANGED_COUNT"

      {
        find docs/ -name "*.md" 2>/dev/null
        find . -maxdepth 1 -name "*.md"
      } | sort > "$DOC_POOL"

      git log --since="7 days ago" --format="=== Commit %H: %s ===" --patch --stat --unified=1 -- src/ containers/ scripts/ docs/ '*.md' | grep -v '^Binary' | head -50 > "$CONTEXT_DIR/recent-diffs.txt"

      git log --since="7 days ago" --format="%H" -- src/ containers/ scripts/ | \
        while read -r sha; do
          git show --name-only --format="" "$sha" -- docs/ '*.md' 2>/dev/null
        done | grep -E '(^docs/.*\.md$|^[^/]+\.md$)' | sort -u | head -3 > "$AFFECTED" || true

      if [ ! -s "$AFFECTED" ]; then
        git log --since="7 days ago" --name-only --format="" -- src/ containers/ scripts/ | \
          grep -v '^$' | sed -E 's|.*/||; s|\.[^.]+$||' | \
          tr '[:upper:]' '[:lower:]' | tr '[:punct:]' '\n' | grep -E '^[a-z0-9]{3,}$' | sort -u > "$TOKENS" || true
        if [ -s "$TOKENS" ]; then
          grep -i -F -f "$TOKENS" "$DOC_POOL" | head -3 > "$AFFECTED" || true
        fi
      fi

      if [ ! -s "$AFFECTED" ]; then
        head -3 "$DOC_POOL" > "$AFFECTED"
      fi

      cp "$AFFECTED" "$CONTEXT_DIR/affected-docs.txt"
      {
        echo "## Changes"
        echo "- changed_count: $COUNT"
        echo "- has_changes: true"
        echo ""
        echo "## Affected Documentation"
        cat "$CONTEXT_DIR/affected-docs.txt"
        echo ""
        echo "## Recent Git Diffs"
        cat "$CONTEXT_DIR/recent-diffs.txt"
      } > "$CONTEXT_DIR/context.md"

      CONTEXT_SIZE=$(wc -c < "$CONTEXT_DIR/context.md" | tr -d ' ')
      DIFF_LINES=$(wc -l < "$CONTEXT_DIR/recent-diffs.txt" | tr -d ' ')
      echo "Context size: ${CONTEXT_SIZE} bytes"
      echo "Diff lines: ${DIFF_LINES}"
      cat "$CONTEXT_DIR/affected-docs.txt" || echo "(empty)"
      if [ "$CONTEXT_SIZE" -lt 100 ]; then
        echo "::warning::Context file is empty or minimal ($CONTEXT_SIZE bytes). Skipping agent run."
        echo "skip_agent=true" >> "$GITHUB_OUTPUT"
      else
        echo "skip_agent=false" >> "$GITHUB_OUTPUT"
      fi
  - name: Pre-load affected documentation content
    run: |
      CONTEXT_DIR=/tmp/gh-aw/doc-maintainer-context
      AFFECTED="$CONTEXT_DIR/affected-docs.txt"

      if [ ! -s "$AFFECTED" ]; then
        echo "No affected docs to pre-load"
        exit 0
      fi

      {
        echo ""
        echo "## Affected Documentation Content (pre-loaded — do not re-read these files)"
        echo ""
        head -3 "$AFFECTED" | while read -r doc; do
          if [ -f "$doc" ]; then
            echo "### File: $doc"
            echo '```'
            head -200 "$doc"
            echo '```'
            echo ""
          fi
        done
      } >> "$CONTEXT_DIR/context.md"

      SIZE=$(wc -c < "$CONTEXT_DIR/context.md" | tr -d ' ')
      echo "Final context.md size: ${SIZE} bytes"
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

### 1. Analyze Pre-computed Changes

Read `/tmp/gh-aw/doc-maintainer-context/context.md` first.

Use the **Recent Git Diffs** section from that file as your **sole source** for recent source changes. **Do not run any `git` commands** — all required git data is already pre-computed. Running `git show`, `git log`, or `git diff` wastes turns.

### 2. Identify Documentation Gaps

The full content of up to 3 affected documentation files is pre-loaded in `context.md` under **Affected Documentation Content**. Read from `context.md` directly and do not use the `edit` tool to re-read those files before making edits.

Review only the files listed under **Affected Documentation** in `/tmp/gh-aw/doc-maintainer-context/context.md` (max 3 files) and identify what needs to be updated. Do not proactively read additional files not in this list.

### 3. Verify Code Examples

Ensure code examples in documentation match current CLI flags, environment variables, Docker configuration, and file paths.

### 4. Make Documentation Updates

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

### 5. Create Pull Request

After making updates, the safe-outputs system will automatically create a PR. Include in your changes:

**PR Description**: Summarize updated docs, reference the triggering code changes, and list what was verified.

## Guidelines

- Be conservative, accurate, minimal, and consistent with existing style.
- Reference the commits that triggered your updates.
- Do not attempt to use bash commands or GitHub tools — they are unavailable in this environment.

**Success**: Review 7-day commits, update out-of-sync docs, verify examples, and create a clear PR summary.