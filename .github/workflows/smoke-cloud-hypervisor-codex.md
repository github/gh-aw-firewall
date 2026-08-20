---
description: Smoke test Cloud Hypervisor with Codex
on:
  workflow_dispatch:
  label_command:
    name: test-cloud-hypervisor-codex
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
name: Smoke Cloud Hypervisor Codex
model: gpt-5.4
engine:
  id: codex
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
    allowed: [smoke-cloud-hypervisor-codex]
  messages:
    footer: "> Cloud Hypervisor + Codex smoke test by [{workflow_name}]({run_url})"
    run-started: "[{workflow_name}]({run_url}) is testing Cloud Hypervisor with Codex..."
    run-success: "[{workflow_name}]({run_url}) completed. Cloud Hypervisor + Codex passed."
    run-failure: "[{workflow_name}]({run_url}) reports {status}. Cloud Hypervisor + Codex failed."
timeout-minutes: 15
sandbox:
  agent:
    id: awf
    version: v0.28.1
    runtime: cloud-hypervisor
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
        run: node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine codex
post-steps:
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked."
        exit 1
      fi
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ] && ! grep -q '"add_comment"' "$OUTPUTS_FILE"; then
        echo "::error::Agent did not call add_comment on a pull_request trigger."
        exit 1
      fi
---

> **[ASSIGNED WORKFLOW TASK]** Execute the authorized smoke test below.

# Smoke Test: Cloud Hypervisor + Codex

Run these checks inside the Cloud Hypervisor sandbox:

1. Call `github-list_pull_requests` for `${{ github.repository }}` with `limit: 1` and `state: merged`.
2. Confirm `curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com` returns 200 or 301.
3. Write a unique line to `/tmp/gh-aw/agent/smoke-cloud-hypervisor-codex-${GITHUB_RUN_ID}.txt`, then read it back.
4. Confirm `curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://example.com` is blocked with 000 or 403.

Keep the summary under 10 lines with a PASS or FAIL for each check.

On a pull request trigger, call `add_comment` with `item_number: ${{ github.event.pull_request.number }}`. If all checks pass, call `add_labels` with the same item number and label `smoke-cloud-hypervisor-codex`.

On `workflow_dispatch`, call `noop` with the concise summary instead.