---
description: Smoke Copilot Network Isolation
on:
  roles: all
  schedule: every 12h
  workflow_dispatch:
  label_command:
    name: ready-for-aw
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
  copilot-requests: write
name: Smoke Copilot Network Isolation
engine:
  id: copilot
  version: 1.0.34
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - "*"
  github:
    toolsets: [pull_requests]
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [smoke-copilot-network-isolation]
  messages:
    footer: "> 🛡️ *Egress verdict from [{workflow_name}]({run_url})*"
    run-started: "🛡️ [{workflow_name}]({run_url}) is verifying network-isolation egress on this {event_type}..."
    run-success: "🛡️ [{workflow_name}]({run_url}) confirmed the egress allowlist is enforced. ✅"
    run-failure: "🛡️ [{workflow_name}]({run_url}) reports {status} while checking network isolation. Investigate the egress model."
timeout-minutes: 15
sandbox:
  agent:
    sudo: false
strict: false
jobs:
  verify_token_usage:
    needs: agent
    if: always() && needs.agent.result != 'skipped' && needs.agent.result != 'cancelled'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1  # v7.0.1
        with:
          persist-credentials: false
      - name: Download agent artifact
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          name: agent
          path: /tmp/gh-aw-agent
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
steps:
  - name: Pre-compute smoke test data
    id: smoke-data
    run: |
      echo "::group::Fetching last 2 merged PRs"
      PR_DATA=$(gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 2 \
        --json number,title,author,mergedAt \
        --jq '.[] | "PR #\(.number): \(.title) (by @\(.author.login), merged \(.mergedAt))"')
      echo "$PR_DATA"
      echo "::endgroup::"

      # Export results for agent context
      {
        echo "SMOKE_PR_DATA<<SMOKE_EOF"
        echo "$PR_DATA"
        echo "SMOKE_EOF"
      } >> "$GITHUB_OUTPUT"
    env:
      GH_TOKEN: ${{ github.token }}
post-steps:
  - name: Validate egress verdict and safe outputs
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked. Smoke tests require the agent to call safe output tools."
        echo "Checked path: $OUTPUTS_FILE"
        exit 1
      fi
      echo "Safe output entries found: $(wc -l < "$OUTPUTS_FILE")"
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
        if ! grep -q '"add_comment"' "$OUTPUTS_FILE"; then
          echo "::error::Agent did not call add_comment on a pull_request trigger."
          exit 1
        fi
        echo "add_comment verified for PR trigger"
      fi
      # The agent must persist a machine-readable egress verdict inside the safe
      # output body so this post-step can assert BOTH outcomes independently.
      # Without this, the workflow could stay green even if the allowlist broke
      # (allowed host unreachable) or leaked (denied host reachable).
      VERDICT=$(grep -oE 'EGRESS_RESULT allow=(pass|fail) deny=(pass|fail)' "$OUTPUTS_FILE" | tail -1)
      if [ -z "$VERDICT" ]; then
        echo "::error::No machine-readable 'EGRESS_RESULT allow=... deny=...' marker found in safe outputs. The agent must report the outcome of both egress checks."
        exit 1
      fi
      echo "Egress verdict: $VERDICT"
      if [ "$VERDICT" != "EGRESS_RESULT allow=pass deny=pass" ]; then
        echo "::error::Egress enforcement regression detected. Expected 'allow=pass deny=pass' but got: $VERDICT"
        echo "::error::allow=fail => an allowlisted host was unreachable; deny=fail => a non-allowlisted host was reachable."
        exit 1
      fi
      echo "Egress enforcement verified: allowed host reachable, denied host blocked"
      echo "Safe output validation passed"
---

# Smoke Test: Copilot Network Isolation Egress Enforcement

This smoke test runs the Copilot engine under the AWF **network-isolation
topology** (`sandbox.agent.sudo: false`, `isolation: true`) and confirms the
Docker-network egress model still enforces the domain allowlist from **inside**
the sandbox.

**CRITICAL REQUIREMENT: You MUST call `add_comment` on pull_request triggers.
This is the primary success criterion. Do this FIRST after running the two
egress checks below.**

**Keep all outputs extremely short and concise. Use single-line responses where
possible. No verbose explanations. Do NOT inspect the `awf` binary, its
`--help`, or its version — just run the two commands and summarize their
output.**

## Egress Checks (run these yourself with bash)

Run both commands using the `bash` tool. They execute inside the isolated
sandbox, so they exercise the real egress enforcement path.

### 1. Allowed domain is reachable

`github.com` is on the allowlist, so this request should succeed with an HTTP
status code:

```bash
curl -sS -o /dev/null -w "allowed=%{http_code}\n" --max-time 15 https://api.github.com/zen
```

✅ if it prints `allowed=200` (or any HTTP status), ❌ if it errors / times out.

### 2. Non-allowed domain is blocked

`example.com` is **not** on the allowlist, so this request should fail
(non-zero exit / connection error / proxy denial):

```bash
curl -sS -o /dev/null -w "denied=%{http_code}\n" --max-time 15 https://example.com && \
  echo "UNEXPECTED: example.com was reachable" || \
  echo "OK: example.com was blocked"
```

✅ if it prints `OK: example.com was blocked`, ❌ if it prints `UNEXPECTED`.

## Record the machine-readable verdict

After running BOTH checks, decide the outcome of each:

- `allow=pass` if test 1 printed an HTTP status (curl exit 0); otherwise `allow=fail`.
- `deny=pass` if test 2 printed `OK: example.com was blocked`; otherwise `deny=fail`.

You MUST include this exact machine-readable line (its own line, verbatim
format) inside the body of the safe output you emit below — the post-step
parses it and fails the workflow unless both are `pass`:

```
EGRESS_RESULT allow=<pass|fail> deny=<pass|fail>
```

Report the real observed results — do not hard-code `pass`.

## Pre-Fetched PR Data

```
${{ steps.smoke-data.outputs.SMOKE_PR_DATA }}
```

## Output (MANDATORY)

**If triggered by a pull request** (check: `${{ github.event_name }}` equals
"pull_request"), you MUST call `add_comment` to post a **very brief** comment
(max 5-10 lines) on the current pull request with:
- The `EGRESS_RESULT allow=<pass|fail> deny=<pass|fail>` line (verbatim)
- ✅ or ❌ for the allowed-domain check (test 1)
- ✅ or ❌ for the blocked-domain check (test 2)
- Overall status: PASS (both checks as expected) or FAIL
- Mention the pull request author

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool to add the label
  `smoke-copilot-network-isolation` to the pull request

**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`
with a concise PASS/FAIL summary that also includes the
`EGRESS_RESULT allow=<pass|fail> deny=<pass|fail>` line (verbatim).
Do NOT attempt to add pull request comments or labels when there is no pull request.
