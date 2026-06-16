---
description: Smoke test for Copilot CLI in direct BYOK mode — validates COPILOT_PROVIDER_API_KEY path through the api-proxy sidecar
on:
  roles: all
  schedule: every 12h
  workflow_dispatch:
  label_command:
    name: ready-for-aw
    events: [pull_request]
    remove_label: false
  reaction: "rocket"
permissions:
  contents: read
  pull-requests: read
  issues: read
  actions: read
name: Smoke Copilot BYOK
engine:
  id: copilot
  env:
    # Direct-BYOK trigger. The sibling smoke-copilot workflow already exercises
    # the COPILOT_GITHUB_TOKEN path (auto-injected by gh-aw under the MCP
    # sandbox); this workflow instead drives the COPILOT_PROVIDER_API_KEY code
    # path (via the AWF sandbox + api-proxy sidecar) so both BYOK auth surfaces
    # have CI coverage. We reuse the COPILOT_GITHUB_TOKEN secret value because
    # the target upstream is still api.githubcopilot.com (CAPI), which accepts
    # the same Bearer token regardless of variable name. The value is wired in
    # under engine.env (rather than the workflow-level env) because gh-aw's
    # strict mode allowlists this exact variable here to keep the secret out of
    # the agent container — AWF then forwards it to the api-proxy sidecar and
    # injects a placeholder into the agent env (see
    # src/services/api-proxy-credential-env.ts).
    COPILOT_PROVIDER_API_KEY: ${{ secrets.COPILOT_GITHUB_TOKEN }}
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
    allowed: [smoke-copilot-byok]
  messages:
    footer: "> 🔑 *BYOK report filed by [{workflow_name}]({run_url})*"
    run-started: "🔑 [{workflow_name}]({run_url}) is testing direct BYOK mode on this {event_type}..."
    run-success: "✅ [{workflow_name}]({run_url}) completed. Copilot BYOK mode operational. 🔓"
    run-failure: "❌ [{workflow_name}]({run_url}) reports {status}. BYOK mode investigation needed..."
timeout-minutes: 15
env:
  COPILOT_MODEL: claude-haiku-4.5
sandbox:
  agent:
    id: awf
strict: true
steps:
  - name: Pre-compute BYOK smoke test data
    id: smoke-data
    run: |
      echo "::group::Verify BYOK configuration"
      echo "COPILOT_API_TARGET=${COPILOT_API_TARGET:-api.githubcopilot.com (default)}"
      echo "::endgroup::"

      echo "::group::Fetching last 2 merged PRs"
      PR_DATA=$(gh pr list --repo "$GITHUB_REPOSITORY" --state merged --limit 2 \
        --json number,title,author,mergedAt \
        --jq '.[] | "PR #\(.number): \(.title) (by @\(.author.login), merged \(.mergedAt))"' \
        || echo "(PR fetch failed)")
      echo "$PR_DATA"
      echo "::endgroup::"

      echo "::group::GitHub.com connectivity check"
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com || echo "000")
      echo "github.com returned HTTP $HTTP_CODE"
      echo "::endgroup::"

      echo "::group::File write/read test"
      TEST_DIR="/tmp/gh-aw/agent"
      TEST_FILE="$TEST_DIR/smoke-test-copilot-byok.txt"
      mkdir -p "$TEST_DIR"
      echo "BYOK smoke test passed at $(date)" > "$TEST_FILE"
      FILE_CONTENT=$(cat "$TEST_FILE")
      echo "Wrote and read back: $FILE_CONTENT"
      echo "::endgroup::"

      {
        echo "SMOKE_PR_DATA<<SMOKE_EOF"
        echo "$PR_DATA"
        echo "SMOKE_EOF"
        echo "SMOKE_HTTP_CODE=$HTTP_CODE"
        echo "SMOKE_FILE_CONTENT=$FILE_CONTENT"
        echo "SMOKE_FILE_PATH=$TEST_FILE"
      } >> "$GITHUB_OUTPUT"
    env:
      GH_TOKEN: ${{ github.token }}
post-steps:
  - name: Validate safe outputs were invoked
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
      echo "Safe output validation passed"
  - name: Verify BYOK mode was active
    run: |
      LOGS_DIR="/tmp/gh-aw/sandbox/firewall/logs"
      if [ -d "$LOGS_DIR" ]; then
        echo "::group::Checking firewall logs for direct BYOK traffic"
        if find "$LOGS_DIR" -name '*.log' -exec grep -l "api.githubcopilot.com" {} + 2>/dev/null; then
          echo "✅ Detected traffic to api.githubcopilot.com via api-proxy (BYOK direct mode)"
        else
          echo "::warning::No traffic to api.githubcopilot.com found in firewall logs"
        fi
        echo "::endgroup::"
      fi
---

# Smoke Test: Copilot BYOK (Direct) Mode

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Purpose

This smoke test validates that Copilot CLI runs in **direct BYOK mode** — triggered by `COPILOT_PROVIDER_API_KEY` being set on the workflow side. AWF forwards that key to the api-proxy sidecar and injects a placeholder into the agent. Inference requests are routed through the api-proxy sidecar to `api.githubcopilot.com`, authenticated with the real key held by the sidecar. The agent only sees a dummy placeholder credential. The sibling `smoke-copilot` workflow covers the parallel `COPILOT_GITHUB_TOKEN` BYOK path.

## Pre-Computed Test Results

The following tests were already executed in a deterministic pre-agent step. Your job is to verify the results and produce the summary comment.

### 1. GitHub MCP Testing
Verify MCP connectivity by calling `github-list_pull_requests` for ${{ github.repository }} (limit 2, state merged). Confirm the result matches the pre-fetched data below.

### 2. GitHub.com Connectivity
Check the HTTP code in **Pre-Fetched Data** below.
✅ if HTTP 200 or 301, ❌ otherwise.

### 3. File Write/Read Test
Run `cat` on the file path from **Pre-Fetched Data** below to confirm it exists.

### 4. BYOK Inference Test
You are running in direct BYOK mode right now. The fact that you can read this prompt and respond means the BYOK inference path (agent → api-proxy sidecar → api.githubcopilot.com) is working. Confirm ✅.

## Output

**If triggered by a pull request**, call `add_comment` to post a **very brief** comment (max 5-10 lines) on the current pull request with:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Note: "Running in direct BYOK mode (COPILOT_PROVIDER_API_KEY) via api-proxy → api.githubcopilot.com"
- Overall status: PASS or FAIL
- Mention the pull request author and any assignees

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool to add the label `smoke-copilot-byok` to the pull request

**If triggered by workflow_dispatch or schedule** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.

## Pre-Fetched Data

<!-- Dynamic section — keep all template substitutions here at the end to maximize prefix caching above -->

- HTTP code: `${{ steps.smoke-data.outputs.SMOKE_HTTP_CODE }}`
- File path: `${{ steps.smoke-data.outputs.SMOKE_FILE_PATH }}`
- File content: `${{ steps.smoke-data.outputs.SMOKE_FILE_CONTENT }}`
- PR data:
  ```
  ${{ steps.smoke-data.outputs.SMOKE_PR_DATA }}
  ```