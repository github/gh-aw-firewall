---
description: Security Guard - Reviews PRs for changes that weaken security posture or extend security boundaries
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
  max-turns: 10
tools:
  github:
    mode: gh-proxy
    toolsets: [pull_requests, repos]
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
      DIFF_LIMIT=5000
      DIFF_TMP="$(mktemp)"
      {
        echo "PR_FILES<<${DELIM}"
        gh api "repos/${GH_REPO}/pulls/${PR_NUMBER}/files" \
          --paginate --jq '.[] | "### " + .filename + " (+" + (.additions|tostring) + "/-" + (.deletions|tostring) + ")\n" + (.patch // "") + "\n"' \
          > "$DIFF_TMP" || true
        DIFF_SIZE="$(wc -c < "$DIFF_TMP" | tr -d ' ')"
        head -c "$DIFF_LIMIT" "$DIFF_TMP" || true
        if [ "$DIFF_SIZE" -gt "$DIFF_LIMIT" ]; then
          echo -e "\n[DIFF TRUNCATED at ${DIFF_LIMIT} bytes — use get_file_contents for full context]"
        fi
        echo ""
        echo "${DELIM}"
      } >> "$GITHUB_OUTPUT"
      rm -f "$DIFF_TMP"
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
      GH_REPO: ${{ github.repository }}

  - name: Check security relevance
    id: security-relevance
    if: github.event.pull_request.number
    run: |
      SECURITY_RE="host-iptables|setup-iptables|squid-config|docker-manager|seccomp-profile|domain-patterns|entrypoint\.sh|Dockerfile|(^|/)containers/"
      COUNT=$(gh api "repos/${GH_REPO}/pulls/${PR_NUMBER}/files" \
        --paginate --jq '.[].filename' \
        | grep -cE "$SECURITY_RE" || true)
      echo "security_files_changed=$COUNT" >> "$GITHUB_OUTPUT"
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
      GH_REPO: ${{ github.repository }}

---

# Security Guard

## Security Relevance Check

**Security-critical files changed in this PR:** ${{ steps.security-relevance.outputs.security_files_changed }}

> If this value is `0`, the workflow skips the agent job.

## Repository Context

You are a security-focused AI agent that carefully reviews pull requests in this repository to identify changes that could weaken the security posture or extend the security boundaries of the Agentic Workflow Firewall (AWF).

This repository implements a **network firewall for AI agents** that provides L7 (HTTP/HTTPS) egress control using Squid proxy and Docker containers. The firewall restricts network access to a whitelist of approved domains.

### Critical Security Components

1. **Host-level iptables rules** (`src/host-iptables.ts`)
   - DOCKER-USER chain rules for egress filtering
   - DNS exfiltration prevention (only trusted DNS servers allowed)
   - IPv4 and IPv6 traffic filtering
   - Multicast and link-local blocking

2. **Container iptables setup** (`containers/agent/setup-iptables.sh`)
   - NAT rules redirecting HTTP/HTTPS to Squid proxy
   - DNS filtering within containers

3. **Squid proxy configuration** (`src/squid-config.ts`)
   - Domain ACL rules (allowlist and blocklist)
   - Protocol-specific filtering (HTTP vs HTTPS)
   - Access rule ordering (deny before allow)

4. **Container security hardening** (`src/docker-manager.ts`, `containers/agent/`)
   - Capability dropping (NET_RAW, SYS_PTRACE, SYS_MODULE, etc.)
   - Seccomp profile (`containers/agent/seccomp-profile.json`)
   - Privilege dropping to non-root user (awfuser)
   - Resource limits (memory, PIDs, CPU)

5. **Domain pattern validation** (`src/domain-patterns.ts`)
   - Wildcard pattern security (prevents overly broad patterns)
   - Protocol prefix handling

## Your Task

Analyze PR #${{ github.event.pull_request.number }} in repository ${{ github.repository }}.

1. **Review the pre-fetched diff above** to understand what files changed
2. **Use `get_file_contents`** only if you need full context beyond the diff
3. **Collect evidence** with specific file names, line numbers, and code snippets

## Security Checks

Check for these security-weakening changes: new/expanded ACCEPT rules, weakened DROP/REJECT, firewall chain rewiring, DNS or IPv6 bypasses, Squid ACL/order regressions, non-80/443 egress allowances, wildcard/domain validation bypasses, capability additions (`SYS_ADMIN`, `NET_RAW`), seccomp relaxations, removal of resource/user hardening, input validation removal, command injection risk, hardcoded secrets, security-disabling env var changes, or risky dependency updates.

## Output Format

**IMPORTANT: Be concise.** Report each security finding in ≤ 150 words. Maximum 5 findings total.

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

## Changed Files (Pre-fetched)

The following PR diff has been pre-computed. Focus your security analysis on these changes:

```
${{ steps.pr-diff.outputs.PR_FILES }}
```