---
description: Smoke test that validates --allow-host-service-ports by connecting to Redis and PostgreSQL GitHub Actions services from inside the AWF sandbox
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
name: Smoke Services
engine: copilot
network:
  allowed:
    - defaults
    - github
tools:
  bash:
    - "*"
  github:
safe-outputs:
    threat-detection:
      enabled: false
    add-comment:
      hide-older-comments: true
    add-labels:
      allowed: [smoke-services]
    messages:
      footer: "> 🔌 *Service connectivity validated by [{workflow_name}]({run_url})*"
      run-started: "🔌 [{workflow_name}]({run_url}) is testing service connectivity for this {event_type}..."
      run-success: "🔌 [{workflow_name}]({run_url}) — All services reachable! ✅"
      run-failure: "🔌 [{workflow_name}]({run_url}) — Service connectivity {status} ⚠️"
timeout-minutes: 10
sandbox:
  agent:
    version: v0.25.29
strict: true
steps:
  - name: Pre-install service client tools
    run: |
      sudo apt-get update -qq && sudo apt-get install -y -qq redis-tools postgresql-client
      echo "redis-cli: $(redis-cli --version)"
      echo "psql: $(psql --version)"
post-steps:
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

# Smoke Test: GitHub Actions Services Connectivity

**IMPORTANT: Keep all outputs extremely short and concise. Use single-line responses where possible. No verbose explanations.**

## Test Requirements

Verify that the AWF sandbox can reach GitHub Actions service containers running on the host via `host.docker.internal`. The `redis-cli` and `psql` binaries are already installed — do NOT run `apt-get`.

Run all connectivity checks in a **single bash command**:

```bash
REDIS=$(redis-cli -h host.docker.internal -p 6379 PING 2>&1); \
PG_READY=$(pg_isready -h host.docker.internal -p 5432 -U postgres 2>&1); \
PG_QUERY=$(PGPASSWORD=testpass psql -h host.docker.internal -p 5432 -U postgres -d smoketest -c "SELECT 1" -t -A 2>&1); \
echo "REDIS=$REDIS"; echo "PG_READY=$PG_READY"; echo "PG_QUERY=$PG_QUERY"
```

Interpret results:
- Redis: ✅ if output contains `PONG`
- PostgreSQL pg_isready: ✅ if output contains `accepting connections`
- PostgreSQL SELECT 1: ✅ if output is `1`

## Output

Post a brief comment (max 5-10 lines) summarizing which checks succeeded (✅) and which failed (❌), plus overall PASS or FAIL. If every check succeeded, also apply the `smoke-services` label.