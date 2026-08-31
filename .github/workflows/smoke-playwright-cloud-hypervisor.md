---
description: Smoke test Playwright CLI loopback access in the Cloud Hypervisor runtime
on:
  workflow_dispatch:
  label_command:
    name: test-playwright-cloud-hypervisor
    events: [pull_request]
    remove_label: false
permissions:
  contents: read
  pull-requests: read
  issues: read
  copilot-requests: write
concurrency:
  job-discriminator: ${{ github.run_id }}
env:
  NPM_CONFIG_REGISTRY: https://packagefeedproxy.microsoft.io/npm/
name: Smoke Playwright Cloud Hypervisor
engine:
  id: copilot
  version: 1.0.34
network:
  allowed:
    - packagefeedproxy.microsoft.io
    - "*.pkgs.visualstudio.com"
  blocked:
    - node
steps:
  - name: Stage Playwright CLI and browser
    run: bash scripts/ci/stage-playwright-loopback-smoke.sh
    timeout-minutes: 10
tools:
  bash:
    - "*"
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
timeout-minutes: 30
sandbox:
  agent:
    id: awf
    version: v0.28.10
    runtime: cloud-hypervisor
strict: false
post-steps:
  - name: Validate Playwright loopback result
    run: node scripts/ci/validate-playwright-loopback-smoke.js cloud-hypervisor
---

# Smoke Test: Playwright CLI Loopback on Cloud Hypervisor

Run `bash scripts/ci/run-playwright-loopback-smoke.sh cloud-hypervisor` exactly once. This starts
a server and Playwright browser inside the agent sandbox, verifies JavaScript
rendering over loopback, and verifies browser egress to a non-allowlisted domain
is blocked.

Read `/tmp/gh-aw/agent/playwright-loopback-results.json` and report the observed
results. On a pull request trigger, call `add_comment` with
`item_number: ${{ github.event.pull_request.number }}`. On `workflow_dispatch`,
call `noop`. Include this exact marker when successful:

`PLAYWRIGHT_LOOPBACK_RESULT runtime=cloud-hypervisor loopback=pass javascript_title=pass blocked_egress=pass`
