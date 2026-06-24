---
description: Network Isolation Test - Minimal manual smoke test for the experimental AWF network-isolation topology
on:
  workflow_dispatch:
permissions:
  contents: read
engine:
  id: copilot
  model: claude-haiku-4-5
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - "*"
sandbox:
  mcp:
    version: "latest"
  agent:
    network-isolation: true
    version: "latest"
strict: false
max-turns: 5
timeout-minutes: 10
---

# Network Isolation Test

This is a minimal, manually-triggered smoke test for the **experimental AWF
network-isolation topology** (`sandbox.agent.network-isolation: true`). It
confirms the Docker-network egress model still enforces the domain allowlist.

Run the two checks below and report the results in your final message.

## 1. Allowed domain is reachable

`github.com` is on the allowlist, so this request should succeed:

```bash
curl -sS -o /dev/null -w "allowed=%{http_code}\n" https://api.github.com/zen
```

## 2. Non-allowed domain is blocked

`example.com` is **not** on the allowlist, so this request should fail
(non-zero exit / connection error / proxy denial):

```bash
curl -sS -o /dev/null -w "denied=%{http_code}\n" https://example.com && \
  echo "UNEXPECTED: example.com was reachable" || \
  echo "OK: example.com was blocked"
```

## Report

Summarize whether network isolation is enforcing the egress allowlist as
expected: the allowed domain should return an HTTP status code, and the
non-allowed domain should be blocked.
