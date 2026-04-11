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
  github:
    github-token: "${{ secrets.GH_AW_GITHUB_MCP_SERVER_TOKEN }}"
safe-outputs:
  threat-detection:
    enabled: false
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [build-test]
  messages:
    run-failure: "**Build Test Failed** [{workflow_name}]({run_url}) - See logs for details"
timeout-minutes: 45
strict: true
---

# Build Test Suite

**IMPORTANT: Keep all outputs concise. Report results clearly with pass/fail status.**

You must run ALL of the following build test tasks sequentially. After completing all tasks, produce a single combined summary table and post it as a comment on the current pull request.

---

## Task 1: Bun

1. **Install Bun**:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   export BUN_INSTALL="$HOME/.bun"
   export PATH="$BUN_INSTALL/bin:$PATH"
   ```

2. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-bun /tmp/test-bun`
   - **CRITICAL**: If clone fails, record CLONE_FAILED for Bun and continue to next task.

3. **Test Projects**:
   - `elysia`: `cd /tmp/test-bun/elysia && bun install && bun test`
   - `hono`: `cd /tmp/test-bun/hono && bun install && bun test`

4. Record install success/failure, test pass/fail count, and any error messages for each project.

---

## Task 2: C++

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-cpp /tmp/test-cpp`
   - **CRITICAL**: If clone fails, record CLONE_FAILED for C++ and continue to next task.

2. **Test Projects**:
   - `fmt`:
     ```bash
     cd /tmp/test-cpp/fmt
     mkdir -p build && cd build
     cmake ..
     make
     ```
   - `json`:
     ```bash
     cd /tmp/test-cpp/json
     mkdir -p build && cd build
     cmake ..
     make
     ```

3. Record CMake configuration success/failure, build success/failure, and any error messages for each project.

---

## Task 3: Deno

1. **Install Deno**:
   ```bash
   curl -fsSL https://deno.land/install.sh | sh
   export DENO_INSTALL="$HOME/.deno"
   export PATH="$DENO_INSTALL/bin:$PATH"
   ```

2. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-deno /tmp/test-deno`
   - **CRITICAL**: If clone fails, record CLONE_FAILED for Deno and continue to next task.

3. **Test Projects**:
   - `oak`: `cd /tmp/test-deno/oak && deno test`
   - `std`: `cd /tmp/test-deno/std && deno test`

4. Record test pass/fail count and any error messages for each project.

---

## Task 4: .NET

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-dotnet /tmp/test-dotnet`
   - **CRITICAL**: If clone fails, record CLONE_FAILED for .NET and continue to next task.

2. **Test Projects**:
   - `hello-world`: `cd /tmp/test-dotnet/hello-world && dotnet restore && dotnet build && dotnet run`
   - `json-parse`: `cd /tmp/test-dotnet/json-parse && dotnet restore && dotnet build && dotnet run`

3. Record restore, build, and run success/failure, and any error messages for each project.

---

## Task 5: Go

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-go /tmp/test-go`
   - **CRITICAL**: If clone fails, record CLONE_FAILED for Go and continue to next task.

2. **Test Projects**:
   - `color`: `cd /tmp/test-go/color && go mod download && go test ./...`
   - `env`: `cd /tmp/test-go/env && go mod download && go test ./...`
   - `uuid`: `cd /tmp/test-go/uuid && go mod download && go test ./...`

3. Record module download success/failure, test pass/fail count, and any error messages for each project.

---

## Task 6: Java

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-java /tmp/test-java`
   - **CRITICAL**: If clone fails, record CLONE_FAILED for Java and continue to next task.

2. **Configure Maven Proxy**: Maven ignores Java system properties for proxy configuration, so you must create `~/.m2/settings.xml` before running any Maven commands. **IMPORTANT**: Use the literal values `squid-proxy` and `3128` directly in the XML - do NOT use shell variables or environment variable syntax:
   ```bash
   mkdir -p ~/.m2
   cat > ~/.m2/settings.xml << 'SETTINGS'
   <settings>
     <proxies>
       <proxy>
         <id>awf-http</id><active>true</active><protocol>http</protocol>
         <host>squid-proxy</host><port>3128</port>
       </proxy>
       <proxy>
         <id>awf-https</id><active>true</active><protocol>https</protocol>
         <host>squid-proxy</host><port>3128</port>
       </proxy>
     </proxies>
   </settings>
   SETTINGS
   ```

3. **Test Projects**:
   - `gson`: `cd /tmp/test-java/gson && mvn compile && mvn test`
   - `caffeine`: `cd /tmp/test-java/caffeine && mvn compile && mvn test`

4. Record compile success/failure, test pass/fail count, and any error messages for each project.

---

## Task 7: Node.js

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-node /tmp/test-node`
   - **CRITICAL**: If clone fails, record CLONE_FAILED for Node.js and continue to next task.

2. **Test Projects**:
   - `clsx`: `cd /tmp/test-node/clsx && npm install && npm test`
   - `execa`: `cd /tmp/test-node/execa && npm install && npm test`
   - `p-limit`: `cd /tmp/test-node/p-limit && npm install && npm test`

3. Record install success/failure, test pass/fail count, and any error messages for each project.

---

## Task 8: Rust

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-rust /tmp/test-rust`
   - **CRITICAL**: If clone fails, record CLONE_FAILED for Rust and continue to next task.

2. **Test Projects**:
   - `fd`: `cd /tmp/test-rust/fd && cargo build && cargo test`
   - `zoxide`: `cd /tmp/test-rust/zoxide && cargo build && cargo test`

3. Record build success/failure, test pass/fail count, and any error messages for each project.

---

## Combined Output

After completing ALL tasks, add a **single comment** to the current pull request with a combined summary table:

### 🏗️ Build Test Suite Results

| Ecosystem | Project | Build/Install | Tests | Status |
|-----------|---------|---------------|-------|--------|
| Bun | elysia | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Bun | hono | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| C++ | fmt | ✅/❌ | N/A | ✅ PASS / ❌ FAIL |
| C++ | json | ✅/❌ | N/A | ✅ PASS / ❌ FAIL |
| Deno | oak | N/A | X/Y passed | ✅ PASS / ❌ FAIL |
| Deno | std | N/A | X/Y passed | ✅ PASS / ❌ FAIL |
| .NET | hello-world | ✅/❌ | N/A | ✅ PASS / ❌ FAIL |
| .NET | json-parse | ✅/❌ | N/A | ✅ PASS / ❌ FAIL |
| Go | color | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Go | env | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Go | uuid | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Java | gson | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Java | caffeine | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Node.js | clsx | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Node.js | execa | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Node.js | p-limit | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Rust | fd | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |
| Rust | zoxide | ✅/❌ | X/Y passed | ✅ PASS / ❌ FAIL |

**Overall: X/8 ecosystems passed — PASS/FAIL**

If ALL tests across all ecosystems pass **and** this run was triggered by a pull request (not `workflow_dispatch`), add the label `build-test` to the pull request.
If ANY test fails, report the failure with error details below the table.

## Error Handling

**CRITICAL**: This workflow MUST fail visibly when errors occur:

1. **Clone failure**: Record failure for that ecosystem and continue to next task. Do NOT stop the entire workflow.
2. **Build/install failure**: Record in the summary table with ❌ and include error output.
3. **Test failure**: Record in the summary table with FAIL status and include failure details.
4. **If ALL ecosystems fail to clone**: Call `safeoutputs-missing_tool` with "ALL_CLONES_FAILED: Unable to clone any test repositories"

DO NOT report success if any step fails. The workflow should produce a clear, actionable error message for any failure.
