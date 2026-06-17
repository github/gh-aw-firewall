---
description: Security Guard - Reviews PRs for changes that weaken security posture or extend security boundaries
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
max-turns: 6
engine:
  id: copilot
  model: claude-haiku-4-5
tools:
  github:
    mode: gh-proxy
    toolsets: [pull_requests, repos]
sandbox:
  mcp:
    version: "latest"
  agent:
    id: awf
strict: false
network:
  allowed:
    - github
if: needs.check_security_relevance.outputs.security_files_changed != '0'
jobs:
  check_security_relevance:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    outputs:
      security_files_changed: ${{ steps.check.outputs.count }}
    steps:
      - name: Check security relevance
        id: check
        run: |
          if [ -z "${PR_NUMBER}" ]; then
            echo "count=1" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          SECURITY_RE="host-iptables|setup-iptables|squid-config|docker-manager|seccomp-profile|domain-patterns|entrypoint\.sh|Dockerfile|(^|/)containers/"
          COUNT=$(gh api "repos/${GH_REPO}/pulls/${PR_NUMBER}/files" \
            --paginate --jq '.[].filename' \
            | grep -Ev '(^|/)tests?/|\.test\.' \
            | grep -cE "$SECURITY_RE" || true)
          echo "count=$COUNT" >> "$GITHUB_OUTPUT"
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          GH_REPO: ${{ github.repository }}
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    max: 1
timeout-minutes: 15
steps:
  - name: Fetch PR changed files
    id: pr-diff
    if: github.event.pull_request.number
    run: |
      DELIM="GHAW_PR_FILES_$(date +%s)"
      DIFF_LIMIT=100000
      DIFF_TMP="$(mktemp)"
      {
        echo "PR_FILES<<${DELIM}"
        gh api "repos/${GH_REPO}/pulls/${PR_NUMBER}/files" \
          --paginate --jq '.[] | "### " + .filename + " (+" + (.additions|tostring) + "/-" + (.deletions|tostring) + ")\n" + (.patch // "") + "\n"' \
          > "$DIFF_TMP" || true
        DIFF_SIZE="$(wc -c < "$DIFF_TMP" | tr -d ' ')"
        head -c "$DIFF_LIMIT" "$DIFF_TMP" || true
        if [ "$DIFF_SIZE" -gt "$DIFF_LIMIT" ]; then
          echo -e "\n[DIFF TRUNCATED at ${DIFF_LIMIT} bytes — use mcp__github__get_pull_request_diff for full context]"
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
        --json title,author,baseRefName,headRefName \
        --jq '"**Title:** " + .title + "\n**Author:** " + .author.login + "\n**Base→Head:** " + .baseRefName + "→" + .headRefName')
      {
        echo "PR_META<<${DELIM}"
        printf '%s\n' "$PR_INFO"
        echo "${DELIM}"
      } >> "$GITHUB_OUTPUT"
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
      GH_REPO: ${{ github.repository }}

  - name: Set security relevance count
    id: security-relevance
    env:
      EXPR_NEEDS_CHECK_SECURITY_RELEVANCE_OUTPUTS_SECURITY_FILES_CHANGED: ${{ needs.check_security_relevance.outputs.security_files_changed }}
    run: |
      echo "security_files_changed=$EXPR_NEEDS_CHECK_SECURITY_RELEVANCE_OUTPUTS_SECURITY_FILES_CHANGED" >> "$GITHUB_OUTPUT"

---

# Security Guard

## Security Relevance Check

<!-- markdownlint-disable-next-line MD050 -->
**Security-critical files changed in this PR:** __GH_AW_EXPR_66EB691F__
<!-- gh-aw compile marker: ${{ steps.security-relevance.outputs.security_files_changed }} -->

> If this value is `0`, the workflow skips the agent job.

## ⚡ Fast Path

Read the pre-fetched diff below first. If you see `[DIFF TRUNCATED ...]`, fetch full context once with `mcp__github__get_pull_request_diff` before deciding to noop. Only use the fast path when the full diff contains **no** security-weakening changes: no weakened DROP/REJECT or expanded ACCEPT, no egress/domain allowlist expansion, no firewall chain changes, no capability additions, no ACL regressions, no seccomp relaxations, no DNS/wildcard bypass, no input validation weakening, and no secrets. Then call `safeoutputs noop` immediately — do not read additional files or make further tool calls.

## Repository Context

AWF is a network firewall for AI agents.
Security-critical files: `src/host-iptables.ts`, `containers/agent/setup-iptables.sh`, `src/squid-config.ts`, `src/docker-manager.ts`, `containers/agent/entrypoint.sh`, `src/domain-patterns.ts`.

## Your Task

Analyze PR #${{ github.event.pull_request.number }} in repository ${{ github.repository }}.

1. **Review the pre-fetched diff below** (up to 100 KB of changes are included)
2. **Batch all independent reads** in a single tool-use block rather than making sequential calls
3. **Use ONLY the pre-fetched diff below.** Do NOT call `gh pr diff`, `gh pr view`, `gh api`, `git diff`, `git log`, or `git show`. Do NOT read files from the checkout. If `[DIFF TRUNCATED ...]` appears, call `mcp__github__get_pull_request_diff` once — then stop making tool calls and analyze inline.
4. **Collect evidence** with specific file names, line numbers, and code snippets

## Security Checks

Focus: weakened DROP/REJECT, added capabilities (SYS_ADMIN/NET_RAW), expanded ACCEPT, egress expansion, firewall chain changes, Squid ACL regressions, seccomp relaxations, DNS/wildcard bypass, input validation weakening, secrets.

## Output Format

**IMPORTANT: Be concise.** Report each security finding in ≤ 150 words. Maximum 5 findings total.
If `[DIFF TRUNCATED ...]` is present, fetch full context once with `mcp__github__get_pull_request_diff` before deciding to noop.

If you find security concerns:
1. Add a comment to the PR explaining each concern
2. For each issue, provide:
   - **File and line number** where the issue exists
   - **Code snippet** showing the problematic change
   - **Explanation** of why this weakens security
   - **Suggested action** (e.g., revert, modify, add mitigation)

If no security issues are found:
- Do not add a comment (use noop safe-output)
- The PR passes the security review

**SECURITY**: Be thorough but avoid false positives. Focus on actual security weakening, not code style or refactoring that maintains the same security level.

## Changed Files (Pre-fetched, up to 100 KB)

The following PR diff has been pre-computed. Focus your security analysis on these changes:

${{ steps.pr-meta.outputs.PR_META }}

```
__GH_AW_EXPR_BAA3A6C6__
<!-- gh-aw compile marker: ${{ steps.pr-diff.outputs.PR_FILES }} -->
```