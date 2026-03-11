---
description: Smoke test workflow that validates the feature by testing host binary access and comparing versions
on:
  roles: all
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - 'src/**'
      - 'containers/**'
      - 'package.json'
      - '.github/workflows/smoke-chroot.md'
  reaction: "rocket"
permissions:
  contents: read
  issues: read
  pull-requests: read

name: Smoke Chroot
engine:
  id: copilot
strict: true
network:
  allowed:
    - defaults
    - github
sandbox:
  mcp:
    container: "ghcr.io/github/gh-aw-mcpg"
tools:
  github:
    toolsets: [repos, pull_requests]
  bash:
    - "*"
safe-outputs:
    add-comment:
      hide-older-comments: true
    add-labels:
      allowed: [smoke-chroot]
    messages:
      footer: "> Tested by [{workflow_name}]({run_url})"
      run-started: "**Testing chroot feature** [{workflow_name}]({run_url}) is validating functionality..."
      run-success: "**Chroot tests passed!** [{workflow_name}]({run_url}) - All security and functionality tests succeeded."
      run-failure: "**Chroot tests failed** [{workflow_name}]({run_url}) {status} - See logs for details."
timeout-minutes: 20
steps:
  - name: Setup Go
    uses: actions/setup-go@0aaccfd150d50ccaeb58ebd88d36e91967a5f35b
    with:
      go-version: '1.22'
  - name: Capture host versions for verification
    run: |
      echo "=== Capturing host versions for post-verification ==="
      mkdir -p /tmp/gh-aw/chroot-test
      {
        echo "HOST_PYTHON_VERSION='$(python3 --version 2>&1 | head -1)'"
        echo "HOST_NODE_VERSION='$(node --version 2>&1 | head -1)'"
        echo "HOST_GO_VERSION='$(go version 2>&1 | head -1)'"
      } > /tmp/gh-aw/chroot-test/host-versions.env
      cat /tmp/gh-aw/chroot-test/host-versions.env
  - name: Install awf dependencies
    run: npm ci
  - name: Build awf
    run: npm run build
  - name: Install awf binary (local)
    run: |
      WORKSPACE_PATH="${GITHUB_WORKSPACE:-$(pwd)}"
      NODE_BIN="$(command -v node)"
      sudo tee /usr/local/bin/awf > /dev/null <<EOF
      #!/bin/bash
      exec "${NODE_BIN}" "${WORKSPACE_PATH}/dist/cli.js" "\$@"
      EOF
      sudo chmod +x /usr/local/bin/awf
  - name: Build local containers
    run: |
      echo "=== Building local containers ==="
      docker build -t ghcr.io/github/gh-aw-firewall/squid:latest containers/squid/
      docker build -t ghcr.io/github/gh-aw-firewall/agent:latest containers/agent/
  - name: Run chroot version tests
    run: |
      echo "=== Running chroot version tests ==="

      # Capture GOROOT for chroot tests
      export GOROOT=$(go env GOROOT)

      # Test Python version in chroot
      echo "Testing Python..."
      CHROOT_PYTHON=$(sudo -E awf --skip-pull --allow-domains localhost -- python3 --version 2>&1 | grep -oP 'Python \d+\.\d+\.\d+' | head -1) || CHROOT_PYTHON="FAILED"

      # Test Node version in chroot
      echo "Testing Node..."
      CHROOT_NODE=$(sudo -E awf --skip-pull --allow-domains localhost -- node --version 2>&1 | grep -oP 'v\d+\.\d+\.\d+' | head -1) || CHROOT_NODE="FAILED"

      # Test Go version in chroot
      echo "Testing Go..."
      CHROOT_GO=$(sudo -E awf --skip-pull --allow-domains localhost -- go version 2>&1 | grep -oP 'go\d+\.\d+(\.\d+)?' | head -1) || CHROOT_GO="FAILED"

      # Save chroot versions
      {
        echo "CHROOT_PYTHON_VERSION=$CHROOT_PYTHON"
        echo "CHROOT_NODE_VERSION=$CHROOT_NODE"
        echo "CHROOT_GO_VERSION=$CHROOT_GO"
      } > /tmp/gh-aw/chroot-test/chroot-versions.env

      cat /tmp/gh-aw/chroot-test/chroot-versions.env

      # Compare versions and create results
      source /tmp/gh-aw/chroot-test/host-versions.env

      PYTHON_MATCH="NO"
      NODE_MATCH="NO"
      GO_MATCH="NO"

      # Compare Python (extract version number - chroot already extracted as "Python X.Y.Z")
      HOST_PY_NUM=$(echo "$HOST_PYTHON_VERSION" | grep -oP 'Python \d+\.\d+\.\d+' || echo "")
      CHROOT_PY_NUM="$CHROOT_PYTHON"
      [ "$HOST_PY_NUM" = "$CHROOT_PY_NUM" ] && [ -n "$HOST_PY_NUM" ] && PYTHON_MATCH="YES"

      # Compare Node (extract version number - already extracted as v\d+.\d+.\d+)
      HOST_NODE_NUM=$(echo "$HOST_NODE_VERSION" | grep -oP 'v\d+\.\d+\.\d+' || echo "")
      CHROOT_NODE_NUM="$CHROOT_NODE"
      [ "$HOST_NODE_NUM" = "$CHROOT_NODE_NUM" ] && [ -n "$HOST_NODE_NUM" ] && NODE_MATCH="YES"

      # Compare Go (extract version number - chroot already extracted as "goX.Y.Z")
      HOST_GO_NUM=$(echo "$HOST_GO_VERSION" | grep -oP 'go\d+\.\d+(\.\d+)?' || echo "")
      CHROOT_GO_NUM="$CHROOT_GO"
      [ "$HOST_GO_NUM" = "$CHROOT_GO_NUM" ] && [ -n "$HOST_GO_NUM" ] && GO_MATCH="YES"

      # Create results summary
      {
        echo "PYTHON_MATCH=$PYTHON_MATCH"
        echo "NODE_MATCH=$NODE_MATCH"
        echo "GO_MATCH=$GO_MATCH"
        echo "HOST_PY_NUM=$HOST_PY_NUM"
        echo "CHROOT_PY_NUM=$CHROOT_PY_NUM"
        echo "HOST_NODE_NUM=$HOST_NODE_NUM"
        echo "CHROOT_NODE_NUM=$CHROOT_NODE_NUM"
        echo "HOST_GO_NUM=$HOST_GO_NUM"
        echo "CHROOT_GO_NUM=$CHROOT_GO_NUM"
      } > /tmp/gh-aw/chroot-test/results.env

      cat /tmp/gh-aw/chroot-test/results.env

      # Determine overall result
      if [ "$PYTHON_MATCH" = "YES" ] && [ "$NODE_MATCH" = "YES" ] && [ "$GO_MATCH" = "YES" ]; then
        echo "ALL_TESTS_PASSED=true" >> /tmp/gh-aw/chroot-test/results.env
        echo "=== ALL CHROOT TESTS PASSED ==="
      else
        echo "ALL_TESTS_PASSED=false" >> /tmp/gh-aw/chroot-test/results.env
        echo "=== SOME CHROOT TESTS FAILED ==="
      fi
  - name: Cleanup test containers
    if: always()
    run: |
      ./scripts/ci/cleanup.sh || true
  - name: Ensure .copilot directory permissions
    run: |
      mkdir -p /home/runner/.copilot
      sudo chown -R runner:runner /home/runner/.copilot
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

# Analyze Chroot Test Results

The chroot version comparison tests have already been executed in the setup steps. Your job is to analyze the results and report them.

## Step 1: Read Test Results

Read the test results from the files created during setup:

```bash
cat /tmp/gh-aw/chroot-test/host-versions.env
cat /tmp/gh-aw/chroot-test/chroot-versions.env
cat /tmp/gh-aw/chroot-test/results.env
```

## Step 2: Create Summary Comment

Based on the results, add a comment to the PR with a comparison table:

| Runtime | Host Version | Chroot Version | Match? |
|---------|--------------|----------------|--------|
| Python  | (from HOST_PY_NUM) | (from CHROOT_PY_NUM) | (PYTHON_MATCH) |
| Node.js | (from HOST_NODE_NUM) | (from CHROOT_NODE_NUM) | (NODE_MATCH) |
| Go      | (from HOST_GO_NUM) | (from CHROOT_GO_NUM) | (GO_MATCH) |

## Step 3: Add Label if Passed

If ALL_TESTS_PASSED is true, add the `smoke-chroot` label to the PR.

Keep your comment brief and focused on the results.