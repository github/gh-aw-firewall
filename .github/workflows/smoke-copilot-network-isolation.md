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
  version: 1.0.101
  checksums-sha256: 018625eac68670d66ede904b9b82cdcd6ab8f87ba20e6e1fbdf0b62c8295d5be
  model: claude-haiku-4.5
  args:
    - --allow-url=api.github.com
    - --allow-url=example.com
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - curl
    - echo
  github: false
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
        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333  # v8.0.2
        with:
          name: agent
          path: /tmp/gh-aw-agent
      - name: Token-usage sanity check
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot
steps:
  - name: Build local AWF smoke images
    timeout-minutes: 35
    run: bash "${RUNNER_TEMP}/awf-smoke/build-smoke-images.sh"
  - name: Pre-compute smoke test data
    run: |
      echo "::group::Fetching last 2 merged PRs"
      PR_DATA=$(gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 2 \
        --json number,title,author,mergedAt \
        --jq '.[] | "PR #\(.number): \(.title) (by @\(.author.login), merged \(.mergedAt))"')
      echo "$PR_DATA"
      echo "::endgroup::"

      # Write results to file for agent context
      mkdir -p /tmp/gh-aw/agent
      echo "$PR_DATA" > /tmp/gh-aw/agent/smoke-pr-data.txt
    env:
      GH_TOKEN: ${{ github.token }}
post-steps:
  - name: Validate egress verdict and safe outputs
    env:
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
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

# Smoke Test: Copilot Network Isolation

Run both egress checks in one `bash` call inside the isolated sandbox:

```bash
if curl -sS -o /dev/null -w "allowed=%{http_code}\n" --max-time 15 https://api.github.com/zen; then allow=pass; else allow=fail; fi
if curl -sS -o /dev/null -w "denied=%{http_code}\n" --max-time 15 https://example.com; then deny=fail; else deny=pass; fi
echo "EGRESS_RESULT allow=$allow deny=$deny"
```

An HTTP response from `api.github.com` means `allow=pass`; a failed request means
`allow=fail`. A failed request to non-allowlisted `example.com` means
`deny=pass`; a successful request means `deny=fail`. Report the observed results,
not assumed results.

## Output

Include the exact `EGRESS_RESULT allow=<pass|fail> deny=<pass|fail>` line in
every safe-output body.

- On a `pull_request` trigger, call `add_comment` with a brief summary, both
  check results, and the overall PASS/FAIL. If both checks pass, also call
  `add_labels` for `smoke-copilot-network-isolation`. Issue both calls in the
  same response (parallel tool calls where supported). Never call `noop` on a
  PR trigger.
- On `workflow_dispatch` or `schedule`, call `noop` with a concise PASS/FAIL
  summary. Do not attempt PR comments or labels without a PR.
