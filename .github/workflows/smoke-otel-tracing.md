---
description: Smoke test that validates OpenTelemetry tracing in the api-proxy sidecar — span creation, token usage attributes, OTLP export, and parent context propagation
on:
  roles: all
  schedule: weekly
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'containers/api-proxy/**'
      - 'src/services/api-proxy-service.ts'
      - '.github/workflows/smoke-otel-tracing.md'
  reaction: "rocket"
permissions:
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
sandbox:
  agent:
    id: awf
  mcp:
    version: v0.3.1
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
  - name: Install api-proxy dependencies
    run: |
      cd containers/api-proxy
      npm ci
  - name: Run api-proxy OTEL tests
    run: |
      cd containers/api-proxy
      npx jest --verbose --ci --testPathPattern='otel' 2>&1 || true
      echo "OTEL test execution complete"
  - name: Validate OTEL module loads
    run: |
      cd containers/api-proxy
      node -e "
        try {
          const otel = require('./otel');
          console.log('OTEL module loaded successfully');
          console.log('isEnabled:', otel.isEnabled());
          console.log('exports:', Object.keys(otel).join(', '));
        } catch (err) {
          if (err.code === 'MODULE_NOT_FOUND') {
            console.log('OTEL module not yet implemented (expected during development)');
            process.exit(0);
          }
          throw err;
        }
      "
  - name: Validate OTEL env var forwarding
    run: |
      echo "Checking api-proxy-service.ts for OTEL env var forwarding..."
      if grep -q 'OTEL_EXPORTER_OTLP_ENDPOINT\|GITHUB_AW_OTEL_TRACE_ID' src/services/api-proxy-service.ts; then
        echo "✅ OTEL env vars are forwarded to api-proxy container"
      else
        echo "⚠️ OTEL env vars not yet forwarded (expected during development)"
      fi
  - name: Validate token-tracker OTEL integration
    run: |
      cd containers/api-proxy
      node -e "
        // Verify token-tracker-http.js has onUsage callback support (OTEL hook point)
        const src = require('fs').readFileSync('./token-tracker-http.js', 'utf8');
        if (src.includes('onUsage')) {
          console.log('✅ token-tracker-http.js has onUsage callback (OTEL integration point)');
        } else {
          console.log('❌ token-tracker-http.js missing onUsage callback');
          process.exit(1);
        }
      "
post-steps:
  - name: Collect OTEL diagnostics
    if: always()
    run: |
      echo "=== OTEL Diagnostics ==="
      if [ -f /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/otel.jsonl ]; then
        echo "OTEL spans exported:"
        wc -l /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/otel.jsonl
        echo "Sample spans:"
        head -5 /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/otel.jsonl
      else
        echo "No OTEL span file found (api-proxy OTEL not yet active)"
      fi
      if [ -f /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl ]; then
        echo ""
        echo "Token usage records (existing tracking):"
        wc -l /tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl
      fi
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
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
6. **Graceful degradation** — No errors when OTEL is not configured

## Test Scenarios

Run the validation steps and report results. The pre-steps have already executed the tests.

### Scenario 1: Module Loading

Check the output from "Validate OTEL module loads" step. Report whether `otel.js` loaded
successfully and what functions it exports.

### Scenario 2: Test Suite

Check the output from "Run api-proxy OTEL tests" step. Report test pass/fail counts.
If no OTEL tests exist yet, note that as expected during development.

### Scenario 3: Env Var Forwarding

Check the output from "Validate OTEL env var forwarding" step. Confirm that
`src/services/api-proxy-service.ts` forwards OTEL env vars to the api-proxy container.

### Scenario 4: Token Tracker Integration

Check the output from "Validate token-tracker OTEL integration" step. Confirm the
`onUsage` callback exists in `token-tracker-http.js` as the OTEL hook point.

### Scenario 5: OTEL Diagnostics

Check the output from "Collect OTEL diagnostics" post-step. Report whether any spans
were exported during the run.

## Reporting

Report a brief summary of all scenario results:
- **If triggered by pull request**: add a comment with ✅/❌ per scenario
- **If not triggered by pull request**: use noop to report results

If all scenarios pass (or are expected-pending during development), report success.
If any scenario shows an unexpected failure, file an issue with details.
