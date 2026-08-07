---
description: Smoke test for Copilot CLI in direct BYOK mode against Azure OpenAI (Foundry) via Microsoft Entra (GitHub OIDC → Azure AD) — validates AWF_AUTH_TYPE=github-oidc + COPILOT_PROVIDER_BASE_URL path through the api-proxy sidecar
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
  copilot-requests: write
  contents: read
  pull-requests: read
  issues: read
  actions: read
  id-token: write   # required for GitHub OIDC → Azure AD federated credential exchange
environment: aoai-model
name: Smoke Copilot BYOK AOAI (Entra)
engine:
  id: copilot
  env:
    # Direct-BYOK trigger against Azure OpenAI (Foundry) using Microsoft Entra
    # (GitHub OIDC federated credential) instead of a static api-key.
    COPILOT_PROVIDER_BASE_URL: ${{ secrets.FOUNDRY_OPENAI_ENDPOINT }}
network:
  allowed:
    - defaults
    - github
    # api-proxy sidecar exchanges the GitHub Actions OIDC JWT for an Azure AD
    # access token at login.microsoftonline.com. The agent/sidecar share an
    # egress allowlist via Squid, so this host must be listed here even though
    # only the sidecar talks to it.
    - login.microsoftonline.com
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
    allowed: [smoke-copilot-byok-aoai-entra]
  messages:
    footer: "> 🪪 *BYOK (AOAI Entra) report filed by [{workflow_name}]({run_url})*"
    run-started: "🪪 [{workflow_name}]({run_url}) is testing Azure OpenAI BYOK (Entra / GitHub OIDC) mode on this {event_type}..."
    run-success: "✅ [{workflow_name}]({run_url}) completed. Copilot AOAI BYOK (Entra) mode operational. 🔓"
    run-failure: "❌ [{workflow_name}]({run_url}) reports {status}. AOAI BYOK (Entra) mode investigation needed..."
timeout-minutes: 15
env:
  COPILOT_MODEL: o4-mini-aw
  # AWF_AUTH_* are set at workflow-level env because gh-aw's strict mode
  # engine.env allowlist does not yet include AWF_AUTH_AZURE_* variables.
  # AWF reads these from process.env and forwards them to the api-proxy
  # sidecar for the GitHub OIDC → Azure AD token exchange.
  AWF_AUTH_TYPE: github-oidc
  AWF_AUTH_PROVIDER: azure
  AWF_AUTH_AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
  AWF_AUTH_AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
sandbox:
  agent:
    id: awf
strict: false
steps:
  - name: Pre-compute BYOK smoke test data
    run: |
      echo "::group::Verify BYOK configuration"
      echo "COPILOT_API_TARGET=${COPILOT_API_TARGET:-derived from COPILOT_PROVIDER_BASE_URL}"
      echo "AWF_AUTH_TYPE=${AWF_AUTH_TYPE:-<unset>}"
      echo "AWF_AUTH_PROVIDER=${AWF_AUTH_PROVIDER:-<unset>}"
      echo "AWF_AUTH_AZURE_TENANT_ID set: $([ -n \"${AWF_AUTH_AZURE_TENANT_ID:-}\" ] && echo yes || echo NO)"
      echo "AWF_AUTH_AZURE_CLIENT_ID set: $([ -n \"${AWF_AUTH_AZURE_CLIENT_ID:-}\" ] && echo yes || echo NO)"
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
      TEST_FILE="$TEST_DIR/smoke-test-copilot-byok-aoai-entra-${GITHUB_RUN_ID}.txt"
      mkdir -p "$TEST_DIR"
      echo "BYOK AOAI Entra smoke test passed at $(date)" > "$TEST_FILE"
      FILE_CONTENT=$(cat "$TEST_FILE")
      echo "Wrote and read back: $FILE_CONTENT"
      echo "::endgroup::"

      # Write results to files for agent context
      mkdir -p /tmp/gh-aw/agent
      echo "$HTTP_CODE" > /tmp/gh-aw/agent/smoke-http-code.txt
      echo "$FILE_CONTENT" > /tmp/gh-aw/agent/smoke-file-content.txt
      echo "$TEST_FILE" > /tmp/gh-aw/agent/smoke-file-path.txt
      echo "$PR_DATA" > /tmp/gh-aw/agent/smoke-pr-data.txt
      {
        echo "event=${GITHUB_EVENT_NAME}"
        echo "item_number=${PR_NUMBER:-}"
        echo "http_code=${HTTP_CODE}"
        echo "file_path=${TEST_FILE}"
        echo "file_content=${FILE_CONTENT}"
        echo "recent_prs:"
        echo "$PR_DATA"
      } > /tmp/gh-aw/agent/smoke-context.txt
    env:
      GH_TOKEN: ${{ github.token }}
      PR_NUMBER: ${{ github.event.pull_request.number }}
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
          echo "✅ Detected traffic to $AOAI_HOST via api-proxy (BYOK direct mode to Azure OpenAI via Entra)"
        else
          echo "::warning::No traffic to Azure OpenAI host found in firewall logs"
        fi
        echo "::endgroup::"
      fi
---

# Smoke Test: Copilot BYOK (Direct) Mode — Azure OpenAI (Foundry, Entra / GitHub OIDC)

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Purpose

This smoke test validates that Copilot CLI runs in **direct BYOK mode against Azure OpenAI (Foundry) using Microsoft Entra authentication** — triggered by `AWF_AUTH_TYPE=github-oidc` + `AWF_AUTH_AZURE_TENANT_ID` + `AWF_AUTH_AZURE_CLIENT_ID` + `COPILOT_PROVIDER_BASE_URL` being set on the workflow side. AWF forwards these values to the api-proxy sidecar, which exchanges the GitHub Actions OIDC JWT for an Azure AD access token via workload identity federation and injects it as a bearer token on upstream requests. A placeholder credential is injected into the agent. Inference requests are routed through the api-proxy sidecar to the Foundry endpoint, authenticated with the Entra-issued token held by the sidecar. The sibling `smoke-copilot-byok-aoai-apikey` workflow covers the parallel api-key BYOK path; `smoke-copilot-byok` covers the CAPI (`api.githubcopilot.com`) BYOK path.

## Pre-Computed Test Results

The following tests were already executed in a deterministic pre-agent step. Your job is to verify the results and produce the summary comment.

### 1. GitHub MCP Testing
First read `/tmp/gh-aw/agent/smoke-context.txt` once. It contains the event type, pull request item number, HTTP result, file path/content, and pre-fetched PR data.

Verify MCP connectivity via the GitHub MCP tool `github-list_pull_requests` for ${{ github.repository }} (limit 2, state merged).
- If the tool responds successfully, confirm the result matches the Pre-Fetched PR Data below. ✅
- If the tool is unavailable or its response is filtered by secrecy policy, validate the Pre-Fetched PR Data instead. Mark ✅ (pre-fetched data validated). Filtering is expected isolation, not a test failure. Do **not** call `missing_tool` for this optional fallback.
- If the tool is available but the call fails for another reason, mark ❌ and include the error.
Either way, continue to the **Output** section below and follow the required output rules.

### 2. GitHub.com Connectivity
Pre-step result: HTTP (see `/tmp/gh-aw/agent/smoke-http-code.txt`) from github.com.
✅ if HTTP 200 or 301, ❌ otherwise.

### 3. File Write/Read Test
Pre-step wrote and read back: "(see `/tmp/gh-aw/agent/smoke-file-content.txt`)"
File path: (see `/tmp/gh-aw/agent/smoke-file-path.txt`)
Verify by running `cat` on the file path using bash to confirm it exists.

### 4. BYOK Inference Test
You are running in direct BYOK mode against Azure OpenAI (Foundry) right now, using `o4-mini-aw` authenticated via Microsoft Entra (GitHub OIDC → Azure AD federated credential). The fact that you can read this prompt and respond means the BYOK inference path (agent → api-proxy sidecar → Entra token exchange → Foundry endpoint) is working. Confirm ✅.

## Pre-Fetched PR Data

```
(see `/tmp/gh-aw/agent/smoke-pr-data.txt`)
```

## Output

**If triggered by a pull request** (`event=pull_request` in the context file), call the `add_comment` safe-output exactly once with `item_number` set to the context file's numeric item number and a **very brief** body (max 5-10 lines) containing:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Note: "Running in direct BYOK mode (AWF_AUTH_TYPE=github-oidc + AWF_AUTH_AZURE_* + COPILOT_PROVIDER_BASE_URL) via api-proxy → Azure OpenAI (Foundry, o4-mini-aw) authenticated via Microsoft Entra"
- Overall status: PASS or FAIL
- Mention the pull request author and any assignees

If all tests pass on a pull request trigger:
- Use the `add_labels` safe-output tool to add the label `smoke-copilot-byok-aoai-entra` to the pull request

On a pull request trigger, never call `noop`, even when a test fails; the required final action is always `add_comment`. Do not pass `pr_number` to `add_comment`; the required target field is `item_number`.

**If triggered by workflow_dispatch or schedule** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.
