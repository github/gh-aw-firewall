---
description: Smoke test for Copilot CLI in direct BYOK mode against Azure OpenAI (Foundry) via Microsoft Entra (GitHub OIDC → Azure AD) — validates AWF_AUTH_TYPE=github-oidc + COPILOT_PROVIDER_BASE_URL path through the api-proxy sidecar
on:
  roles: all
  schedule: every 12h
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
  reaction: "rocket"
permissions:
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
    # (GitHub OIDC federated credential) instead of a static api-key. The
    # sibling smoke-copilot-byok-aoai-apikey workflow exercises the same code
    # path with COPILOT_PROVIDER_API_KEY; this workflow instead lets the
    # api-proxy sidecar exchange the GitHub Actions OIDC JWT for an Azure AD
    # access token (via workload identity federation) and inject it as a
    # bearer token on upstream requests to the Foundry deployment.
    #
    # Only COPILOT_PROVIDER_BASE_URL is wired in under engine.env (because
    # gh-aw's strict mode allowlists this exact variable here to keep the
    # secret out of the agent container). The AWF_AUTH_* values live at
    # workflow-level env (see below) instead, because gh-aw's strict-mode
    # engine.env secret-leak allowlist does not yet include them.
    #
    # For Actions OIDC to work, the agent step must run under an Actions
    # environment named `aoai-model` (see `environment:` above) whose
    # protection rules / federated credential subject claim are configured to
    # accept this repository's workflow.
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
  # AWF_AUTH_* are set at workflow-level env (rather than engine.env) because
  # gh-aw's strict mode allowlist for engine.env does not currently include
  # the AWF_AUTH_AZURE_* variables. awf reads these from the agent step's
  # process.env (via `sudo -E awf …`) and forwards them to the api-proxy
  # sidecar (see src/services/api-proxy-service-config.ts), which uses them
  # for the GitHub OIDC → Azure AD federated-credential token exchange. The
  # agent container itself does not need these values — only the sidecar.
  AWF_AUTH_TYPE: github-oidc
  AWF_AUTH_PROVIDER: azure
  AWF_AUTH_AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
  AWF_AUTH_AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
sandbox:
  agent:
    id: awf
# strict: false because gh-aw's strict-mode engine.env/env secret-leak
# allowlist currently covers COPILOT_PROVIDER_API_KEY / COPILOT_PROVIDER_BASE_URL
# but does not yet include the AWF_AUTH_AZURE_* keys, so referencing
# ${{ secrets.AZURE_TENANT_ID }} / ${{ secrets.AZURE_CLIENT_ID }} would fail
# strict-mode compilation. AWF still forwards these values exclusively to the
# api-proxy sidecar (see src/services/api-proxy-service-config.ts); they are
# never written into the agent container's env.
strict: false
steps:
  - name: Pre-compute BYOK smoke test data
    id: smoke-data
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
Verify MCP connectivity by calling `github-list_pull_requests` for ${{ github.repository }} (limit 1, state merged). Confirm the result matches the pre-fetched data below.

### 2. GitHub.com Connectivity
Pre-step result: HTTP ${{ steps.smoke-data.outputs.SMOKE_HTTP_CODE }} from github.com.
✅ if HTTP 200 or 301, ❌ otherwise.

### 3. File Write/Read Test
Pre-step wrote and read back: "${{ steps.smoke-data.outputs.SMOKE_FILE_CONTENT }}"
File path: ${{ steps.smoke-data.outputs.SMOKE_FILE_PATH }}
Verify by running `cat` on the file path using bash to confirm it exists.

### 4. BYOK Inference Test
You are running in direct BYOK mode against Azure OpenAI (Foundry) right now, using `o4-mini-aw` authenticated via Microsoft Entra (GitHub OIDC → Azure AD federated credential). The fact that you can read this prompt and respond means the BYOK inference path (agent → api-proxy sidecar → Entra token exchange → Foundry endpoint) is working. Confirm ✅.

## Pre-Fetched PR Data

```
${{ steps.smoke-data.outputs.SMOKE_PR_DATA }}
```

## Output

**If triggered by a pull request**, call `add_comment` to post a **very brief** comment (max 5-10 lines) to the current pull request with:
- PR titles only (no descriptions)
- ✅ or ❌ for each test result
- Note: "Running in direct BYOK mode (AWF_AUTH_TYPE=github-oidc + AWF_AUTH_AZURE_* + COPILOT_PROVIDER_BASE_URL) via api-proxy → Azure OpenAI (Foundry, o4-mini-aw) authenticated via Microsoft Entra"
- Overall status: PASS or FAIL
- Mention the pull request author and any assignees

If all tests pass on a pull request trigger, add the label `smoke-copilot-byok-aoai-entra` to the pull request.

**If triggered by workflow_dispatch or schedule** (no PR context), call `noop` with a concise PASS/FAIL summary instead. Do NOT attempt to add pull request comments or labels when there is no pull request.
