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
    - node
    - github
tools:
  agentic-workflows:
  cache-memory: true
  bash:
    - "*"
  github:
safe-outputs:
    add-comment:
      hide-older-comments: true
    add-labels:
      allowed: [smoke-services]
    messages:
      footer: "> 🔌 *Service connectivity validated by [{workflow_name}]({run_url})*"
      run-started: "🔌 [{workflow_name}]({run_url}) is testing service connectivity for this {event_type}..."
      run-success: "🔌 [{workflow_name}]({run_url}) — All services reachable! ✅"
      run-failure: "🔌 [{workflow_name}]({run_url}) — Service connectivity {status} ⚠️"
timeout-minutes: 5
strict: true
post-steps:
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-/opt/gh-aw/safeoutputs/outputs.jsonl}"
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

Run these connectivity checks and report the results:

1. **Redis Connectivity**: Run `redis-cli -h localhost -p 6379 ping` and verify the response is `PONG`
2. **PostgreSQL Connectivity**: Run `pg_isready -h localhost -p 5432` and verify it reports the server is accepting connections
3. **PostgreSQL Query**: Run `PGPASSWORD=testpass psql -h localhost -p 5432 -U postgres -d smoketest -c "SELECT 1 AS smoke_test;"` and verify it returns a row

If `redis-cli` or `pg_isready` are not installed, install them first with `sudo apt-get update && sudo apt-get install -y redis-tools postgresql-client`.

## Output

Add a **very brief** comment (max 5-10 lines) to the current pull request with:
- ✅ or ❌ for each connectivity test
- Overall status: PASS or FAIL

If all tests pass, add the label `smoke-services` to the pull request.

