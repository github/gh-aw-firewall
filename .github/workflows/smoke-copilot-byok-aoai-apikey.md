---
description: Smoke test for Copilot CLI in direct BYOK mode against Azure OpenAI (Foundry) via api-key — validates COPILOT_PROVIDER_API_KEY + COPILOT_PROVIDER_BASE_URL path through the api-proxy sidecar
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
name: Smoke Copilot BYOK AOAI (api-key)
engine:
  id: copilot
  env:
    # Direct-BYOK trigger against Azure OpenAI (Foundry) using an api-key. The
    # sibling smoke-copilot-byok workflow exercises the same code path against
    # api.githubcopilot.com (CAPI) with a GitHub token; this workflow instead
    # points the api-proxy sidecar at a Foundry deployment so the
    # COPILOT_PROVIDER_BASE_URL + COPILOT_PROVIDER_API_KEY combination has CI
    # coverage. Both values are wired in under engine.env (rather than the
    # workflow-level env) because gh-aw's strict mode allowlists these exact
    # variables here to keep the secret out of the agent container — AWF then
    # forwards them to the api-proxy sidecar and injects a placeholder into the
    # agent env (see src/services/api-proxy-credential-env.ts).
    COPILOT_PROVIDER_BASE_URL: ${{ secrets.FOUNDRY_OPENAI_ENDPOINT }}
    COPILOT_PROVIDER_API_KEY: ${{ secrets.FOUNDRY_API_KEY }}
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
    allowed: [smoke-copilot-byok-aoai-apikey]
  messages:
    footer: "> 🔑 *BYOK (AOAI api-key) report filed by [{workflow_name}]({run_url})*"
    run-started: "🔑 [{workflow_name}]({run_url}) is testing Azure OpenAI BYOK (api-key) mode on this {event_type}..."
    run-success: "✅ [{workflow_name}]({run_url}) completed. Copilot AOAI BYOK (api-key) mode operational. 🔓"
    run-failure: "❌ [{workflow_name}]({run_url}) reports {status}. AOAI BYOK (api-key) mode investigation needed..."
timeout-minutes: 15
env:
  COPILOT_MODEL: o4-mini-aw
sandbox:
  agent:
    id: awf
strict: true
jobs:
  activation:
    pre-steps:
      - name: Pre-compute BYOK smoke test data
        id: smoke-data
        run: |
          echo "::group::Verify BYOK configuration"
          echo "COPILOT_API_TARGET=${COPILOT_API_TARGET:-derived from COPILOT_PROVIDER_BASE_URL}"
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
          TEST_FILE="$TEST_DIR/smoke-test-copilot-byok-aoai-apikey-${GITHUB_RUN_ID}.txt"
          mkdir -p "$TEST_DIR"
          echo "BYOK AOAI api-key smoke test passed at $(date)" > "$TEST_FILE"
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
        echo "::group::Checking firewall logs for direct BYOK (AOAI) traffic"
        # Extract the Foundry hostname from the configured base URL so the grep
        # works regardless of the specific Azure region / resource name.
        AOAI_HOST=$(printf '%s' "${COPILOT_PROVIDER_BASE_URL:-}" | sed -E 's#^https?://([^/]+).*#\1#')
        if [ -n "$AOAI_HOST" ] && find "$LOGS_DIR" -name '*.log' -exec grep -l "$AOAI_HOST" {} + 2>/dev/null; then
          echo "✅ Detected traffic to $AOAI_HOST via api-proxy (BYOK direct mode to Azure OpenAI)"
        else
          echo "::warning::No traffic to Azure OpenAI host found in firewall logs"
        fi
        echo "::endgroup::"
      fi
---

# Smoke Test: Copilot BYOK (Direct) Mode — Azure OpenAI (Foundry, api-key)

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Purpose

This smoke test validates that Copilot CLI runs in **direct BYOK mode against Azure OpenAI (Foundry) using an api-key** — triggered by `COPILOT_PROVIDER_API_KEY` + `COPILOT_PROVIDER_BASE_URL` being set on the workflow side. AWF forwards both values to the api-proxy sidecar and injects a placeholder into the agent. Inference requests are routed through the api-proxy sidecar to the Foundry endpoint, authenticated with the real api-key held by the sidecar. The agent only sees a dummy placeholder credential. The sibling `smoke-copilot-byok` workflow covers the parallel CAPI (`api.githubcopilot.com`) BYOK path.

## Pre-Computed Test Results

The following tests were already executed in a deterministic pre-agent step. Your job is to verify the results and produce the summary comment.

### 1. GitHub MCP Testing
Verify MCP connectivity by calling `github-list_pull_requests` for ${{ github.repository }} (limit 1, state merged). Confirm the result matches the pre-fetched data below.

### 2. GitHub.com Connectivity
Pre-step result: HTTP ${{ steps.smoke-data.outputs.SMOKE_HTTP_CODE }} from github.com.
✅ if HTTP 200 or 301, ❌ otherwise.

### 3. File Write/Read Test
The activation pre-step wrote and read back: "${{ steps.smoke-data.outputs.SMOKE_FILE_CONTENT }}" (that file lives on the activation runner, not here). To exercise agent-side file I/O in the sandbox, write a short string to `/tmp/gh-aw/agent/agent-write-test.txt` and `cat` it back with bash. ✅ if the read-back matches.

### 4. BYOK Inference Test
You are running in direct BYOK mode against Azure OpenAI (Foundry) right now, using `o4-mini-aw` via an api-key. The fact that you can read this prompt and respond means the BYOK inference path (agent → api-proxy sidecar → Foundry endpoint) is working. Confirm ✅.

## Pre-Fetched PR Data

```
${{ steps.smoke-data.outputs.SMOKE_PR_DATA }}
```

## Output

**If triggered by a pull request**, call `add_comment` to post a **very brief** comment (max 5-10 lines) on the current pull request with:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Note: "Running in direct BYOK mode (COPILOT_PROVIDER_API_KEY + COPILOT_PROVIDER_BASE_URL) via api-proxy → Azure OpenAI (Foundry, o4-mini-aw)"
- Overall status: PASS or FAIL
- Mention the pull request author and any assignees

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool to add the label `smoke-copilot-byok-aoai-apikey` to the pull request

**If triggered by workflow_dispatch or schedule** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.
