---
description: Smoke test that validates OpenTelemetry tracing in the api-proxy sidecar — span creation, token usage attributes, OTLP export, and parent context propagation
on:
  roles: all
  schedule: weekly
  workflow_dispatch:
  label_command:
    name: ready-for-aw
    events: [pull_request]
    remove_label: false
  reaction: "rocket"
permissions:
  copilot-requests: write
  contents: read
  issues: read
  pull-requests: read
  actions: read

observability:
  otlp:
    endpoint:
      - url: ${{ secrets.GH_AW_OTEL_SENTRY_ENDPOINT }}
        headers:
          x-sentry-auth: ${{ secrets.GH_AW_OTEL_SENTRY_AUTHORIZATION }}

name: Smoke OTel Tracing
engine:
  id: copilot
  version: 1.0.101
  checksums-sha256: 018625eac68670d66ede904b9b82cdcd6ab8f87ba20e6e1fbdf0b62c8295d5be
sandbox:
  agent:
    id: awf
strict: false
network:
  allowed:
    - defaults
    - node
    - github
    - "*.ingest.us.sentry.io"
tools:
  bash:
    - "*"
  github:
    toolsets: [repos, pull_requests]
safe-outputs:
  threat-detection:
    enabled: false
  create-issue:
    title-prefix: "[smoke-otel-tracing] "
    labels: [smoke-test, otel, tracing, automation]
    expires: 7d
    group: true
    close-older-issues: true
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [smoke-otel]
  messages:
    footer: "> 📡 *OTel tracing validated by [{workflow_name}]({run_url})*"
    run-started: "📡 [{workflow_name}]({run_url}) is starting OTel tracing validation..."
    run-success: "📡 [{workflow_name}]({run_url}) completed. All tracing scenarios validated. ✅"
    run-failure: "📡 [{workflow_name}]({run_url}) reports {status}. OTel tracing regression detected. ⚠️"
timeout-minutes: 15
steps:
  - name: Build local AWF smoke images
    timeout-minutes: 35
    run: bash "${RUNNER_TEMP}/awf-smoke/build-smoke-images.sh"
  - name: Install api-proxy dependencies
    run: |
      cd containers/api-proxy
      npm ci
  - name: Run api-proxy OTEL tests
    run: |
      cd containers/api-proxy
      npx jest --verbose --ci --testPathPatterns='otel' 2>&1
      echo "OTEL test execution complete"
  - name: Validate OTEL module loads
    run: |
      cd containers/api-proxy
      node -e "
        const assert = require('node:assert/strict');
        const otel = require('./otel');
        assert.equal(otel.isEnabled(), true);
        console.log('OTEL module loaded successfully');
        console.log('isEnabled:', otel.isEnabled());
        console.log('exports:', Object.keys(otel).join(', '));
      "
  - name: Validate OTEL env var forwarding
    run: |
      echo "Checking agent and api-proxy OTEL env var forwarding..."

      # Agent passthrough: trace context identifiers only (no collector credentials)
      grep -q 'GITHUB_AW_OTEL_TRACE_ID' src/services/agent-environment/env-passthrough.ts \
        || { echo "❌ GITHUB_AW_OTEL_TRACE_ID missing from env-passthrough.ts"; exit 1; }
      grep -q 'GITHUB_AW_OTEL_PARENT_SPAN_ID' src/services/agent-environment/env-passthrough.ts \
        || { echo "❌ GITHUB_AW_OTEL_PARENT_SPAN_ID missing from env-passthrough.ts"; exit 1; }

      # api-proxy env config: collector endpoint and full trace context
      grep -q 'GH_AW_OTLP_ENDPOINTS' src/services/api-proxy-env-config.ts \
        || { echo "❌ GH_AW_OTLP_ENDPOINTS missing from api-proxy-env-config.ts"; exit 1; }
      grep -q 'OTEL_EXPORTER_OTLP_ENDPOINT' src/services/api-proxy-env-config.ts \
        || { echo "❌ OTEL_EXPORTER_OTLP_ENDPOINT missing from api-proxy-env-config.ts"; exit 1; }
      grep -q 'GITHUB_AW_OTEL_TRACE_ID' src/services/api-proxy-env-config.ts \
        || { echo "❌ GITHUB_AW_OTEL_TRACE_ID missing from api-proxy-env-config.ts"; exit 1; }
      grep -q 'GITHUB_AW_OTEL_PARENT_SPAN_ID' src/services/api-proxy-env-config.ts \
        || { echo "❌ GITHUB_AW_OTEL_PARENT_SPAN_ID missing from api-proxy-env-config.ts"; exit 1; }

      echo "✅ All required OTEL env vars forwarded through the correct paths"
  - name: Validate token-tracker OTEL integration
    run: |
      cd containers/api-proxy
      node -e "
        // Verify token-tracker-http-finalize.js has onUsage callback support (OTEL hook point)
        const src = require('fs').readFileSync('./token-tracker-http-finalize.js', 'utf8');
        if (src.includes('onUsage')) {
          console.log('✅ token-tracker-http-finalize.js has onUsage callback (OTEL integration point)');
        } else {
          console.log('❌ token-tracker-http-finalize.js missing onUsage callback');
          process.exit(1);
        }
      "
post-steps:
  - name: Collect OTEL diagnostics
    if: always()
    run: |
      echo "=== OTEL Diagnostics ==="
      echo "OTLP collector mode configured; collector delivery requires backend span evidence."
      if [ -f /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/otel.jsonl ]; then
        echo "Local fallback OTEL span records (not collector delivery evidence):"
        wc -l /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/otel.jsonl
        echo "Sample spans:"
        head -5 /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/otel.jsonl
      else
        echo "No local fallback span file; expected in OTLP collector mode, not proof of export."
      fi
      if [ -f /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl ]; then
        echo ""
        echo "Token usage records (existing tracking):"
        wc -l /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl
      fi
  - name: Validate safe outputs were invoked
    env:
      OUTPUTS_FILE: ${{ steps.set-runtime-paths.outputs.GH_AW_SAFE_OUTPUTS }}
    run: |
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked. Smoke tests require the agent to call safe output tools."
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
---

# Smoke Test: API Proxy OpenTelemetry Tracing

**IMPORTANT: Keep all outputs concise. Report results as single-line summaries.**

## Context

The AWF api-proxy sidecar (`containers/api-proxy/`) handles all LLM API requests from the
agent, injecting credentials and tracking token usage. This workflow validates that the
OTEL tracing integration works correctly:

1. **OTEL module initialization** — `otel.js` loads and detects endpoint config
2. **Span creation** — Each proxied request produces a span with correct attributes
3. **Token usage attributes** — GenAI semantic conventions (`gen_ai.usage.*`) on spans
4. **Parent context propagation** — Spans link to workflow trace via env vars
5. **OTLP export** — Spans are exported through Squid proxy to the configured endpoint
6. **File fallback** — Without OTLP endpoints, tracing stays enabled with `FileSpanExporter`

## Test Scenarios

Run the validation steps and report results. The pre-steps have already executed the tests.

### Scenario 1: Module Loading

Check the output from "Validate OTEL module loads" step. Report whether `otel.js` loaded
successfully and what functions it exports.

### Scenario 2: Test Suite

Check the output from "Run api-proxy OTEL tests" step. Report test pass/fail counts.
Missing tests or a failed test command are failures, not expected-pending results.

### Scenario 3: Env Var Forwarding

Check the output from "Validate OTEL env var forwarding" step. Confirm that
`src/services/agent-environment/env-passthrough.ts` forwards the trace context into the
agent container and `src/services/api-proxy-env-config.ts` forwards the OTEL vars into the
api-proxy container.

### Scenario 4: Token Tracker Integration

Check the output from "Validate token-tracker OTEL integration" step. Confirm the
`onUsage` callback exists in `token-tracker-http-finalize.js` as the OTEL hook point.

### Scenario 5: OTEL Diagnostics

The "Collect OTEL diagnostics" post-step runs after the agent and is not available yet.
It checks `api-proxy-logs/` for local fallback records, not collector delivery.
This workflow configures OTLP endpoints, so a missing `otel.jsonl` is expected.
Only report collector delivery as confirmed with backend span evidence for this run;
otherwise report it as unverified, not failed. Unit tests and local files alone do not
prove collector delivery.

### Scenario 6: File Fallback

Check that `uses FileSpanExporter when no OTLP config at all` in `otel-fanout.test.js`
passed. It clears OTLP configuration and asserts that tracing stays enabled with
`FileSpanExporter` targeting `/var/log/api-proxy/otel.jsonl`, rather than assuming
tracing is disabled when no endpoint is configured.

## Reporting

Report a brief summary of all scenario results:
- **If triggered by pull request**: add a comment with ✅/❌ per scenario
- **If not triggered by pull request**: use noop to report results

If all local validation scenarios pass, report local success and state separately
whether collector delivery is confirmed or unverified.
If any scenario shows an unexpected failure, file an issue with details.
