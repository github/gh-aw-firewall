---
description: Contribution Check - Reviews PRs against CONTRIBUTING.md guidelines
on:
  roles: all
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: read
  issues: read
engine:
  id: claude
  model: claude-haiku-4-5
  max-turns: 5
tools:
  github:
    mode: gh-proxy
    toolsets: [pull_requests]
sandbox:
  agent:
    id: awf
network:
  allowed:
    - github
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    max: 1
timeout-minutes: 10
steps:
  - name: Verify DIFC proxy liveness
    run: |
      if ! nc -z localhost 18443 2>/dev/null; then
        echo "::error::DIFC proxy not reachable at localhost:18443. Halting to prevent unbounded agent retries."
        exit 1
      fi
      echo "DIFC proxy liveness check passed (localhost:18443)"

  - name: Fetch CONTRIBUTING.md
    id: contributing
    run: |
      DELIM="GHAW_CONTRIBUTING_$(date +%s)"
      {
        echo "CONTENT<<${DELIM}"
        cat CONTRIBUTING.md 2>/dev/null || echo "(CONTRIBUTING.md not found)"
        echo "${DELIM}"
      } >> "$GITHUB_OUTPUT"

  - name: Fetch PR changed files
    id: pr-diff
    if: github.event.pull_request.number
    run: |
      DELIM="GHAW_PR_FILES_$(date +%s)"
      DIFF_LIMIT=50000
      DIFF_TMP="$(mktemp)"
      {
        echo "PR_FILES<<${DELIM}"
        gh api "repos/${GH_REPO}/pulls/${PR_NUMBER}/files" \
          --paginate --jq '.[] | "### " + .filename + " (+" + (.additions|tostring) + "/-" + (.deletions|tostring) + ")\n" + (.patch // "") + "\n"' \
          > "$DIFF_TMP" || true
        DIFF_SIZE="$(wc -c < "$DIFF_TMP" | tr -d ' ')"
        head -c "$DIFF_LIMIT" "$DIFF_TMP" || true
        if [ "$DIFF_SIZE" -gt "$DIFF_LIMIT" ]; then
          echo -e "\n[DIFF TRUNCATED at ${DIFF_LIMIT} bytes]"
        fi
        echo ""
        echo "${DELIM}"
      } >> "$GITHUB_OUTPUT"
      rm -f "$DIFF_TMP"
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
      GH_REPO: ${{ github.repository }}

  - name: Fetch PR metadata
    id: pr-meta
    if: github.event.pull_request.number
    run: |
      DELIM="GHAW_PR_META_$(date +%s)"
      PR_INFO=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" \
        --json title,author,baseRefName,headRefName,body \
        --jq '"**Title:** " + .title + "\n**Author:** " + .author.login + "\n**Base→Head:** " + .baseRefName + "→" + .headRefName + "\n**Description:**\n" + (.body // "")')
      {
        echo "PR_META<<${DELIM}"
        printf '%s\n' "$PR_INFO"
        echo "${DELIM}"
      } >> "$GITHUB_OUTPUT"
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
      GH_REPO: ${{ github.repository }}

---

# Contribution Check

You are a contribution guidelines reviewer for the `gh-aw-firewall` (AWF) repository. Your task is to check whether this pull request follows the contribution guidelines in `CONTRIBUTING.md`.

## Your Task

Review PR #${{ github.event.pull_request.number }} in repository ${{ github.repository }}.

**Use ONLY the pre-fetched data below.** Do NOT call `gh pr diff`, `gh pr view`, `gh api`, `git diff`, `git log`, or `git show`. Do not read files from the checkout.

## Pre-Fetched PR Metadata

${{ steps.pr-meta.outputs.PR_META }}

## Pre-Fetched Changed Files

```
${{ steps.pr-diff.outputs.PR_FILES }}
```

## CONTRIBUTING.md (Pre-Fetched)

${{ steps.contributing.outputs.CONTENT }}

## Review Checklist

Check the PR against each applicable item in CONTRIBUTING.md:

1. **Code style** — Does the code follow TypeScript best practices?
2. **Tests** — Are tests included for new functionality?
3. **Documentation** — Is documentation updated where needed?
4. **Commit/PR description** — Is the PR description clear and does it reference related issues?
5. **File organization** — Are new files placed in the correct directories (`src/`, `containers/`, `scripts/ci/`)?

## Output Format

Be concise. If the PR follows all applicable guidelines, use the noop safe-output — do not add a comment.

If the PR is missing something important (no tests for new functionality, unclear description for a significant change), add a **single helpful comment** that:
- Lists the specific missing items
- References the relevant section of CONTRIBUTING.md
- Keeps the tone constructive and welcoming

Do not comment on minor style preferences or things already covered by the automated linter/tests.
