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
timeout-minutes: 15
strict: true
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

You need to verify that the AWF sandbox can reach GitHub Actions service containers running on the host. These services are exposed via `host.docker.internal`.

Install the required client tools first:

```bash
sudo apt-get update && sudo apt-get install -y redis-tools postgresql-client
```

Then run each of the following connectivity checks:

1. Use `redis-cli` to ping the Redis server at `host.docker.internal` on port 6379. A successful response is `PONG`.
2. Use `pg_isready` to check whether the PostgreSQL server at `host.docker.internal` on port 5432 is accepting connections.
3. Use `psql` to execute `SELECT 1` against the `smoketest` database on `host.docker.internal:5432` as user `postgres` with password `testpass`.

## Output

Post a brief comment on the current pull request summarizing which checks succeeded and which failed. If every check succeeded, also apply the `smoke-services` label.