---
description: Build Test Suite
on:
  roles: all
  workflow_dispatch:
  label_command:
    name: ready-for-aw
    events: [pull_request]
    remove_label: false
permissions:
  copilot-requests: write
  contents: read
  pull-requests: read
  issues: read
name: Build Test Suite
engine: copilot
runtimes:
  node:
    version: "20"
  go:
    version: "1.22"
  rust:
    version: "stable"
  java:
    version: "21"
  dotnet:
    version: "8.0"
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - "*"
  github:
    mode: gh-proxy
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
    max: 1
  add-labels:
    allowed: [build-test]
  messages:
    run-failure: "**Build Test Failed** [{workflow_name}]({run_url}) - See logs for details"
timeout-minutes: 45
sandbox:
  agent:
    id: awf
strict: true
steps:
  - name: Run build-test matrix
    timeout-minutes: 40
    run: bash scripts/ci/build-test-matrix.sh
    continue-on-error: true
---

# Build Test Suite

Read `/tmp/gh-aw/build-test/results.json`, produced by the pre-agent matrix step. Post one concise comment with a table containing one row per project:

| Ecosystem | Project | Build/Install | Tests | Status |
|-----------|---------|---------------|-------|--------|
| `<ecosystem>` | `<project>` | `<build>` | `<passed>/<total> passed` or `N/A` | `<status>` |

Report any recorded project errors below the table and include the overall ecosystem count and PASS/FAIL status.

If `allClonesFailed` is true, also call `safeoutputs-missing_tool` with `ALL_CLONES_FAILED: Unable to clone any test repositories`.
Add the `build-test` label only when all eight ecosystems pass and this run was triggered by a pull request.
Do not report success if any build/install or test fails.
