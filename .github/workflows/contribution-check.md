---
description: Contribution Check - Reviews PRs against CONTRIBUTING.md guidelines
on:
  roles: all
  workflow_dispatch:
  label_command:
    name: ready-for-aw
    events: [pull_request]
    remove_label: false
permissions:
  contents: read
  pull-requests: read
  issues: read
max-turns: 5
concurrency:
  group: "contribution-check-${{ github.event.pull_request.number || github.ref }}"
  cancel-in-progress: true
engine:
  id: copilot
  model: gpt-5.4-mini
tools:
  github:
    mode: gh-proxy
    toolsets: [pull_requests]
sandbox:
  mcp:
    version: "latest"
  agent:
    id: awf
strict: false
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
  - name: Fetch CONTRIBUTING.md
    id: contributing
    run: |
      CONTEXT_DIR=/tmp/gh-aw/contribution-check-context
      mkdir -p "$CONTEXT_DIR"
      gh api "repos/${GH_REPO}/contents/CONTRIBUTING.md" --jq '.content' 2>/dev/null \
        | tr -d '\n' | base64 -d 2>/dev/null \
        > "$CONTEXT_DIR/contributing.md" \
        || echo "(CONTRIBUTING.md not found)" > "$CONTEXT_DIR/contributing.md"
    env:
      GH_TOKEN: ${{ github.token }}
      GH_REPO: ${{ github.repository }}
  - name: Fetch PR changed files
    id: pr-diff
    if: github.event.pull_request.number || github.event.inputs.item_number
    run: |
      CONTEXT_DIR=/tmp/gh-aw/contribution-check-context
      mkdir -p "$CONTEXT_DIR"
      DIFF_LIMIT=50000
      DIFF_TMP="$(mktemp)"
      gh api "repos/${GH_REPO}/pulls/${PR_NUMBER}/files" \
        --paginate --jq '.[] | "### " + .filename + " (+" + (.additions|tostring) + "/-" + (.deletions|tostring) + ")\n" + (.patch // "") + "\n"' \
        > "$DIFF_TMP" || true
      DIFF_SIZE="$(wc -c < "$DIFF_TMP" | tr -d ' ')"
      head -c "$DIFF_LIMIT" "$DIFF_TMP" > "$CONTEXT_DIR/pr-files.md" || true
      if [ "$DIFF_SIZE" -gt "$DIFF_LIMIT" ]; then
        echo -e "\n[DIFF TRUNCATED at ${DIFF_LIMIT} bytes]" >> "$CONTEXT_DIR/pr-files.md"
      fi
      rm -f "$DIFF_TMP"
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number || github.event.inputs.item_number }}
      GH_REPO: ${{ github.repository }}

  - name: Fetch PR metadata
    id: pr-meta
    if: github.event.pull_request.number || github.event.inputs.item_number
    run: |
      CONTEXT_DIR=/tmp/gh-aw/contribution-check-context
      mkdir -p "$CONTEXT_DIR"
      gh pr view "$PR_NUMBER" --repo "$GH_REPO" \
        --json title,author,baseRefName,headRefName,body \
        --jq '"**Title:** " + .title + "\n**Author:** " + .author.login + "\n**Base→Head:** " + .baseRefName + "→" + .headRefName + "\n**Description:**\n" + (.body // "")' \
        > "$CONTEXT_DIR/pr-meta.md"
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number || github.event.inputs.item_number }}
      GH_REPO: ${{ github.repository }}

---

# Contribution Check

You are a contribution guidelines reviewer for the `gh-aw-firewall` (AWF) repository. Your task is to check whether this pull request follows the contribution guidelines in `CONTRIBUTING.md`.

## Your Task

Review PR #${{ github.event.pull_request.number }} in repository ${{ github.repository }}.

Read the following pre-fetched context files before proceeding:
- `/tmp/gh-aw/contribution-check-context/pr-meta.md` — PR metadata (title, author, base/head branch, description)
- `/tmp/gh-aw/contribution-check-context/pr-files.md` — Changed files with diffs
- `/tmp/gh-aw/contribution-check-context/contributing.md` — CONTRIBUTING.md content

**Use ONLY the pre-fetched data in these context files.** Do NOT call `gh pr diff`, `gh pr view`, `gh api`, `git diff`, `git log`, or `git show`. Do not read other files from the checkout.

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