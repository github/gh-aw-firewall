---
description: Smoke test Cloud Hypervisor with Copilot
on:
  roles: all
  workflow_dispatch:
  label_command:
    name: [ready-for-aw, test-cloud-hypervisor-copilot]
    events: [pull_request]
    remove_label: false
  reaction: "eyes"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
  copilot-requests: write
name: Smoke Cloud Hypervisor
concurrency:
  job-discriminator: ${{ github.run_id }}
model: gpt-5.4-mini
engine:
  id: copilot
  args:
    - --allow-url=https://github.com
    - --allow-url=https://example.com
network:
  allowed:
    - defaults
    - github
tools:
  github: false
  bash:
    - "*"
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    max: 1
    target: triggering
    hide-older-comments: true
  add-labels:
    max: 1
    allowed: [smoke-cloud-hypervisor]
  noop:
    max: 1
    report-as-issue: false
  messages:
    footer: "> Cloud Hypervisor + Copilot smoke test by [{workflow_name}]({run_url})"
    run-started: "[{workflow_name}]({run_url}) is testing Cloud Hypervisor with Copilot..."
    run-success: "[{workflow_name}]({run_url}) completed. Cloud Hypervisor + Copilot passed."
    run-failure: "[{workflow_name}]({run_url}) reports {status}. Cloud Hypervisor + Copilot failed."
timeout-minutes: 15
sandbox:
  agent:
    id: awf
    version: v0.28.31
    runtime: cloud-hypervisor
    config:
      filesystem:
        allow-write:
          - /tmp/gh-aw/aw_info.json
strict: false
steps:
  - name: Pre-compute merged PR check
    env:
      GH_TOKEN: ${{ github.token }}
    run: |
      mkdir -p /tmp/gh-aw/agent
      gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 1 --json number,title > /tmp/gh-aw/agent/merged-pr.json
jobs:
  verify_token_usage:
    needs: agent
    if: needs.agent.result == 'success'
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
post-steps:
  - name: Validate safe outputs were invoked
    env:
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked."
        exit 1
      fi
      if [ "$GITHUB_EVENT_NAME" = "pull_request" ] && ! jq -se 'any(.[]; .type == "add_comment")' "$OUTPUTS_FILE" >/dev/null; then
        echo "::error::Agent did not call add_comment on a pull_request trigger."
        exit 1
      fi
---

# Smoke Test: Cloud Hypervisor + Copilot

The `test-cloud-hypervisor-copilot` PR label runs only this smoke test; use it
for a focused rerun without reapplying the shared `ready-for-aw` label.

Run these checks inside the Cloud Hypervisor sandbox:

1. In the same bash invocation, read `/tmp/gh-aw/agent/merged-pr.json` with one
   `cat` command. Initialize `MERGED_PR_RESULT=FAIL`; set it to `PASS` only if
   `jq -e 'type == "array" and length > 0'` validates the contents.

Make exactly one bash invocation for all four checks, the summary, and safe
outputs. Run the entire block unchanged; do not split it or skip the reporting
commands. A PR comment is mandatory even when a check fails. The success label
is optional reporting after the required comment, never a replacement for it.

```bash
set -e -o pipefail
MERGED_PR_RESULT=FAIL
MERGED_PR_JSON=$(cat /tmp/gh-aw/agent/merged-pr.json 2>/dev/null || :)
if [ -n "$MERGED_PR_JSON" ] && printf '%s' "$MERGED_PR_JSON" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then MERGED_PR_RESULT=PASS; fi
GITHUB_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com || :)
[ -n "$GITHUB_CODE" ] || GITHUB_CODE=000
if [ "$GITHUB_CODE" = 200 ] || [ "$GITHUB_CODE" = 301 ]; then GITHUB_RESULT=PASS; else GITHUB_RESULT=FAIL; fi
TEST_FILE="/tmp/gh-aw/agent/smoke-cloud-hypervisor-${GITHUB_RUN_ID}.txt"
EXPECTED="Cloud Hypervisor smoke test ${GITHUB_RUN_ID}"
printf '%s\n' "$EXPECTED" > "$TEST_FILE"
FILE_CONTENT=$(cat "$TEST_FILE")
if [ "$FILE_CONTENT" = "$EXPECTED" ]; then FILE_RESULT=PASS; else FILE_RESULT=FAIL; fi
BLOCKED_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://example.com || :)
[ -n "$BLOCKED_CODE" ] || BLOCKED_CODE=000
if [ "$BLOCKED_CODE" = 000 ] || [ "$BLOCKED_CODE" = 403 ]; then BLOCKED_RESULT=PASS; else BLOCKED_RESULT=FAIL; fi
OVERALL_RESULT=PASS
if [ "$MERGED_PR_RESULT" != PASS ] || [ "$GITHUB_RESULT" != PASS ] || [ "$FILE_RESULT" != PASS ] || [ "$BLOCKED_RESULT" != PASS ]; then OVERALL_RESULT=FAIL; fi
cat <<'EOF' > /tmp/gh-aw/agent/comment-body.md
Cloud Hypervisor + Copilot smoke test
EOF
printf '1. Merged PR lookup: %s\n2. github.com connectivity: %s (HTTP %s)\n3. File write/read: %s\n4. example.com blocked: %s (HTTP %s)\nOverall: %s\n' "$MERGED_PR_RESULT" "$GITHUB_RESULT" "$GITHUB_CODE" "$FILE_RESULT" "$BLOCKED_RESULT" "$BLOCKED_CODE" "$OVERALL_RESULT" >> /tmp/gh-aw/agent/comment-body.md
cat /tmp/gh-aw/agent/comment-body.md
if [ '${{ github.event_name }}' = pull_request ]; then
  jq -Rs --argjson item_number '${{ github.event.pull_request.number }}' '{item_number: $item_number, body: .}' /tmp/gh-aw/agent/comment-body.md | safeoutputs add_comment .
  if [ "$OVERALL_RESULT" = PASS ]; then
    jq -n --argjson item_number '${{ github.event.pull_request.number }}' '{item_number: $item_number, labels: ["smoke-cloud-hypervisor"]}' | safeoutputs add_labels .
  fi
else
  jq -Rs '{message: .}' /tmp/gh-aw/agent/comment-body.md | safeoutputs noop .
fi
```

The two CLI URL approvals only let `curl` execute; AWF still enforces the
network allowlist, so `example.com` must remain blocked. The summary has a PASS
or FAIL for every check and overall status. Use the existing summary file
without rewriting it; `jq` encodes it as data, not shell instructions.

Do not use command substitution or Python to construct safe-output payloads.
On `pull_request`, `add_comment` must succeed before `add_labels` is attempted;
never substitute `noop` or a final text response for the required comment.
On `workflow_dispatch`, the block calls only `noop`. After the block finishes,
stop without issuing any additional safe outputs.