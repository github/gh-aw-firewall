---
description: Build Test Java
on:
  roles: all
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read
  issues: read
name: Build Test Java
engine: copilot
runtimes:
  java:
    version: "21"
network:
  allowed:
    - defaults
    - github
    - java
tools:
  bash:
    - "*"
  github:
    github-token: "${{ secrets.GH_AW_GITHUB_MCP_SERVER_TOKEN }}"
sandbox:
  mcp:
    container: "ghcr.io/github/gh-aw-mcpg"
safe-outputs:
  add-comment:
    hide-older-comments: true
  add-labels:
    allowed: [build-test-java]
  messages:
    run-failure: "**Build Test Failed** [{workflow_name}]({run_url}) - See logs for details"
timeout-minutes: 15
strict: true
---

# Build Test: Java

**IMPORTANT: Keep all outputs concise. Report results clearly with pass/fail status.**

## Test Requirements

Clone and test the following projects from the test repository:

1. **Clone Repository**: `gh repo clone Mossaka/gh-aw-firewall-test-java /tmp/test-java`
   - **CRITICAL**: If clone fails, immediately call `safeoutputs-missing_tool` with message "CLONE_FAILED: Unable to clone test repository" and stop execution

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

4. **For each project**, capture:
   - Compile success/failure
   - Test pass/fail count
   - Any error messages

## Output

Add a comment to the current pull request with a summary table:

| Project  | Compile | Tests | Status |
|----------|---------|-------|--------|
| gson     | ✅/❌   | X/Y   | PASS/FAIL |
| caffeine | ✅/❌   | X/Y   | PASS/FAIL |

**Overall: PASS/FAIL**

If ALL tests pass, add the label `build-test-java` to the pull request.
If ANY test fails, report the failure with error details.

## Error Handling

**CRITICAL**: This workflow MUST fail visibly when errors occur:

1. **Clone failure**: If repository clone fails, call `safeoutputs-missing_tool` with "CLONE_FAILED: [error message]"
2. **Build failure**: Report in comment table with ❌ and include error output
3. **Test failure**: Report in comment table with FAIL status and include failure details

DO NOT report success if any step fails. The workflow should produce a clear, actionable error message.