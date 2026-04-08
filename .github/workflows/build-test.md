---
description: Build Test Suite
on:
  roles: all
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
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
    - node
    - go
    - rust
    - crates.io
    - java
    - dotnet
    - "bun.sh"
    - "deno.land"
    - "jsr.io"
    - "dl.deno.land"
tools:
  bash:
    - "*"
safe-outputs:
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [build-test]
  messages:
    run-failure: "**Build Test Failed** [{workflow_name}]({run_url}) - See logs for details"
timeout-minutes: 45
strict: true
steps:
  - name: Install Bun and Deno
    run: |
      curl -fsSL https://bun.sh/install | bash || true
      export BUN_INSTALL="$HOME/.bun"
      export PATH="$BUN_INSTALL/bin:$PATH"
      bun --version || echo "Bun install failed"
      curl -fsSL https://deno.land/install.sh | sh || true
      export DENO_INSTALL="$HOME/.deno"
      export PATH="$DENO_INSTALL/bin:$PATH"
      deno --version || echo "Deno install failed"
  - name: Clone all test repositories
    run: |
      for entry in \
        "bun:Mossaka/gh-aw-firewall-test-bun" \
        "cpp:Mossaka/gh-aw-firewall-test-cpp" \
        "deno:Mossaka/gh-aw-firewall-test-deno" \
        "dotnet:Mossaka/gh-aw-firewall-test-dotnet" \
        "go:Mossaka/gh-aw-firewall-test-go" \
        "java:Mossaka/gh-aw-firewall-test-java" \
        "node:Mossaka/gh-aw-firewall-test-node" \
        "rust:Mossaka/gh-aw-firewall-test-rust"; do
        key="${entry%%:*}"
        repo="${entry#*:}"
        echo "=== Cloning $key ==="
        gh repo clone "$repo" "/tmp/test-$key" 2>&1 | tail -5 \
          || echo "CLONE_FAILED: $key"
      done
    env:
      GH_TOKEN: ${{ github.token }}
  - name: Run all build tests
    id: build-results
    run: |
      export BUN_INSTALL="$HOME/.bun"
      export PATH="$BUN_INSTALL/bin:$PATH"
      export DENO_INSTALL="$HOME/.deno"
      export PATH="$DENO_INSTALL/bin:$PATH"

      RESULTS_FILE="/tmp/gh-aw/build-test/results.txt"
      mkdir -p /tmp/gh-aw/build-test
      > "$RESULTS_FILE"

      run_test() {
        local name="$1"; shift
        local rc=0
        local out
        out=$(eval "$@" 2>&1) || rc=$?
        out=$(echo "$out" | tail -20)
        {
          echo "=== $name: exit=$rc ==="
          echo "$out"
          echo ""
        } >> "$RESULTS_FILE"
      }

      run_test "bun/elysia"    "cd /tmp/test-bun/elysia && bun install && bun test"
      run_test "bun/hono"      "cd /tmp/test-bun/hono && bun install && bun test"
      run_test "cpp/fmt"       "cd /tmp/test-cpp/fmt && mkdir -p build && cd build && cmake .. && make -s"
      run_test "cpp/json"      "cd /tmp/test-cpp/json && mkdir -p build && cd build && cmake .. && make -s"
      run_test "deno/oak"      "cd /tmp/test-deno/oak && deno test"
      run_test "deno/std"      "cd /tmp/test-deno/std && deno test"
      run_test "dotnet/hello"  "cd /tmp/test-dotnet/hello-world && dotnet restore -v q && dotnet build -v q && dotnet run"
      run_test "dotnet/json"   "cd /tmp/test-dotnet/json-parse && dotnet restore -v q && dotnet build -v q && dotnet run"
      run_test "go/color"      "cd /tmp/test-go/color && go mod download && go test ./..."
      run_test "go/env"        "cd /tmp/test-go/env && go mod download && go test ./..."
      run_test "go/uuid"       "cd /tmp/test-go/uuid && go mod download && go test ./..."
      run_test "java/gson"     "cd /tmp/test-java/gson && mvn -q compile && mvn -q test"
      run_test "java/caffeine" "cd /tmp/test-java/caffeine && mvn -q compile && mvn -q test"
      run_test "node/clsx"     "cd /tmp/test-node/clsx && npm install --quiet && npm test"
      run_test "node/execa"    "cd /tmp/test-node/execa && npm install --quiet && npm test"
      run_test "node/p-limit"  "cd /tmp/test-node/p-limit && npm install --quiet && npm test"
      run_test "rust/fd"       "cd /tmp/test-rust/fd && cargo build -q && cargo test -q"
      run_test "rust/zoxide"   "cd /tmp/test-rust/zoxide && cargo build -q && cargo test -q"

      echo "=== Build test results ==="
      cat "$RESULTS_FILE"
post-steps:
  - name: Validate safe outputs were invoked
    run: |
      OUTPUTS_FILE="${GH_AW_SAFE_OUTPUTS:-${RUNNER_TEMP}/gh-aw/safeoutputs/outputs.jsonl}"
      if [ ! -s "$OUTPUTS_FILE" ]; then
        echo "::error::No safe outputs were invoked. Build tests require the agent to call safe output tools."
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

# Build Test Suite

The pre-agent steps have already cloned all test repositories, built, and tested all 18 projects across 8 ecosystems. Results are saved in `/tmp/gh-aw/build-test/results.txt`.

## Instructions

1. Read the results file:
   ```bash
   cat /tmp/gh-aw/build-test/results.txt
   ```

2. Parse each entry. Format: `=== name: exit=N ===` followed by output tail. `exit=0` = PASS, otherwise FAIL.

3. Post a **single PR comment** with a summary table:

   ### 🏗️ Build Test Suite Results

   | Ecosystem | Project | Status |
   |-----------|---------|--------|
   | Bun | elysia | ✅ PASS / ❌ FAIL |
   | Bun | hono | ✅ PASS / ❌ FAIL |
   | C++ | fmt | ✅ PASS / ❌ FAIL |
   | C++ | json | ✅ PASS / ❌ FAIL |
   | Deno | oak | ✅ PASS / ❌ FAIL |
   | Deno | std | ✅ PASS / ❌ FAIL |
   | .NET | hello-world | ✅ PASS / ❌ FAIL |
   | .NET | json-parse | ✅ PASS / ❌ FAIL |
   | Go | color | ✅ PASS / ❌ FAIL |
   | Go | env | ✅ PASS / ❌ FAIL |
   | Go | uuid | ✅ PASS / ❌ FAIL |
   | Java | gson | ✅ PASS / ❌ FAIL |
   | Java | caffeine | ✅ PASS / ❌ FAIL |
   | Node.js | clsx | ✅ PASS / ❌ FAIL |
   | Node.js | execa | ✅ PASS / ❌ FAIL |
   | Node.js | p-limit | ✅ PASS / ❌ FAIL |
   | Rust | fd | ✅ PASS / ❌ FAIL |
   | Rust | zoxide | ✅ PASS / ❌ FAIL |

   **Overall: X/18 projects passed — PASS/FAIL**

4. If ALL 18 projects pass (exit=0), add the label `build-test` to the PR.
5. If any test fails, include the last 20 lines of failure output below the table.
6. If the results file is missing or empty, call `safeoutputs-missing_tool` with "BUILD_RESULTS_MISSING: Pre-agent steps may have failed".
