# Protocol, Proxy, and Security Integration Tests Analysis

This document provides a detailed analysis of the integration tests covering protocol support, IPv6, API proxy, credential hiding, token unsetting, one-shot tokens, exit code propagation, and error handling in the AWF (Agentic Workflow Firewall).

---

## Table of Contents

1. [Protocol Support Tests](#1-protocol-support-tests)
2. [IPv6 Integration Tests](#2-ipv6-integration-tests)
3. [API Proxy Sidecar Tests](#3-api-proxy-sidecar-tests)
4. [Credential Hiding Security Tests](#4-credential-hiding-security-tests)
5. [Token Unsetting Tests](#5-token-unsetting-tests)
6. [One-Shot Token Protection Tests](#6-one-shot-token-protection-tests)
7. [Exit Code Propagation Tests](#7-exit-code-propagation-tests)
8. [Error Handling Tests](#8-error-handling-tests)
9. [Cross-Cutting Observations](#9-cross-cutting-observations)

---

## 1. Protocol Support Tests

**File:** `tests/integration/protocol-support.test.ts`

### What It Tests

| Test Case | Description |
|-----------|-------------|
| **HTTPS to allowed domain** | Sends `curl -fsS https://api.github.com/zen` with `github.com` allowed. Verifies the request succeeds (exit code 0). |
| **HTTPS to non-allowed domain** | Sends `curl -f https://example.com` with only `github.com` allowed. Verifies the CONNECT is denied by Squid and curl fails. |
| **HTTPS verbose output** | Runs `curl -v` and greps for SSL/TLS connection info, confirming TLS handshakes happen through the proxy. |
| **HTTP/2 connections** | Uses `curl --http2` to verify HTTP/2 negotiation works through the Squid CONNECT tunnel. |
| **HTTP/1.1 fallback** | Uses `curl --http1.1` to verify HTTP/1.1 also works, confirming protocol negotiation flexibility. |
| **HTTP requests** | Attempts plain HTTP to `github.com`. Expects failure because HTTP requests hit Squid's intercept port where HTTP-to-HTTPS redirects fail. Documents a known limitation. |
| **Custom headers** | Passes `-H "Accept: application/json"` to verify headers traverse the proxy. |
| **User-Agent header** | Passes `-A "Test-Agent/1.0"` to verify custom User-Agent traverses the proxy. |
| **IPv4 connections** | Uses `curl -4` to force IPv4, verifying IPv4-only connectivity works. |
| **IPv6 (may not be available)** | Uses `curl -6` with `|| exit 0` fallback. Tests IPv6 connectivity but gracefully handles environments without IPv6. |
| **curl max-time** | Uses `--max-time 5` to verify the timeout option works through the proxy. |
| **curl connect-timeout** | Uses `--connect-timeout 10` to verify connection timeout works through the proxy. |

### Real-World Mapping

These tests map to the core firewall functionality: when an AI agent (Claude, Copilot, Codex) makes HTTP/HTTPS requests, the proxy must:
- Allow HTTPS to whitelisted domains (API calls to `api.github.com`, `api.anthropic.com`, etc.)
- Block HTTPS to non-whitelisted domains (preventing data exfiltration)
- Support various HTTP versions and headers that real tools use
- Handle connection timeouts gracefully when domains are blocked

### Gaps and Missing Coverage

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| **No test for multiple allowed domains simultaneously** | Real workflows allow 5-10+ domains. No test verifies correct behavior with many domains. | Add test with 3-5 allowed domains, verify each works and a non-listed one is blocked. |
| **No test for wildcard subdomain matching** | Allowing `github.com` should also allow `api.github.com`, `raw.githubusercontent.com`, etc. | Add test verifying subdomain matching behavior. |
| **No test for large request/response bodies** | AI agents may download large files (repos, models). | Add test downloading a file >1MB through the proxy. |
| **No test for concurrent requests** | AI agents make many parallel requests. | Add test making 5-10 concurrent curl requests. |
| **No test for WebSocket upgrade** | Some MCP servers use WebSocket. | Add test attempting WebSocket connection through proxy (expected to fail or document limitation). |
| **No test for POST/PUT/PATCH/DELETE methods** | Only GET-like requests are tested. AI agents use POST for API calls. | Add test for POST with JSON body through the proxy. |
| **HTTP intercept mode behavior not thoroughly validated** | The HTTP test documents a "known limitation" but doesn't verify the exact failure mode. | Add test that checks the specific error (403 page vs connection refused). |
| **No test for redirect following** | `curl -L` following redirects across domains. | Test that redirects from allowed domain to non-allowed domain are blocked. |

### Edge Cases

- What happens when Squid is slow to start and the first request arrives before it's ready?
- What happens with very long domain names (>255 chars)?
- What about requests to IP addresses directly (bypassing DNS)?

---

## 2. IPv6 Integration Tests

**File:** `tests/integration/ipv6.test.ts`

### What It Tests

| Test Case | Description |
|-----------|-------------|
| **Accept IPv6 DNS servers** | Configures `dnsServers: ['2001:4860:4860::8888', '2001:4860:4860::8844']` and verifies they appear in debug logs. |
| **Accept mixed IPv4/IPv6 DNS** | Configures both `8.8.8.8` and `2001:4860:4860::8888`, verifies both appear in logs. |
| **DNS resolution with IPv4-only DNS** | Runs `nslookup github.com` with IPv4 DNS only, verifies resolution works. |
| **IPv6 traffic blocked for non-whitelisted** | When IPv6 is available, attempts `curl -6 https://example.com` (not in allowlist). Expects failure. |
| **IPv6 curl graceful failure** | Tests `curl -6` with fallback, ensuring graceful handling when IPv6 is unavailable. |
| **ip6tables status logging** | Verifies that starting with IPv6 DNS servers logs ip6tables availability status. |
| **IPv6 chain cleanup** | Verifies that ip6tables chains are cleaned up on exit. |
| **IPv4 curl with IPv4 DNS** | Baseline test confirming IPv4 curl works with IPv4 DNS servers. |
| **Dual-stack DNS configuration** | Configures 4 DNS servers (2 IPv4 + 2 IPv6), verifies all appear in logs. |
| **Valid IPv6 loopback** | Tests that `::1` (loopback) is accepted as a DNS server. |
| **Link-local addresses** | Tests graceful handling by using IPv4 DNS to avoid link-local issues. |
| **Empty IPv6 DNS server list** | Tests that IPv4-only DNS servers work and DNS resolution succeeds. |

### Real-World Mapping

GitHub Actions runners may have IPv6 enabled. The firewall must handle IPv6 DNS configuration correctly to prevent DNS-based data exfiltration while allowing legitimate IPv6 DNS resolution. The ip6tables rules must match the iptables rules for IPv4.

### Gaps and Missing Coverage

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| **No test for actual IPv6 traffic through proxy** | Only tests DNS config and curl -6 blocking. Doesn't verify IPv6 traffic flows correctly through Squid when allowed. | Add conditional test (when IPv6 available) that makes successful IPv6 request to allowed domain. |
| **Invalid IPv6 address rejection not tested** | The test for "Invalid IPv6 address rejected at CLI level" actually uses a valid IPv6 address (`::1`). | Add test with genuinely invalid IPv6 like `not:an:ipv6` and verify CLI error. |
| **No test for IPv6-only environment** | All tests either have IPv4 or mixed. What if IPv4 is unavailable? | Add conditional test for IPv6-only DNS configuration. |
| **Link-local test doesn't actually test link-local** | Uses IPv4 DNS "to avoid link-local issues" - doesn't actually test `fe80::` handling. | Add test with `fe80::1%eth0` to verify proper rejection or handling. |
| **ip6tables cleanup not strongly verified** | Checks for presence of log keywords but doesn't verify rules are actually removed. | After cleanup, run `ip6tables -L` and verify no AWF rules remain. |
| **Many tests only check log output** | Several tests just verify strings appear in stderr rather than testing actual network behavior. | Where feasible, add actual connectivity tests. |

### Edge Cases

- What happens when IPv6 is available but ip6tables is not installed?
- Race condition: ip6tables rules being applied while IPv6 traffic is already in flight.
- DNS64/NAT64 environments where IPv6 traffic is translated to IPv4.

---

## 3. API Proxy Sidecar Tests

**File:** `tests/integration/api-proxy.test.ts`

### What It Tests

| Test Case | Description |
|-----------|-------------|
| **Anthropic healthcheck** | Starts API proxy with `ANTHROPIC_API_KEY`, checks `/health` on port 10001. Expects `"status":"healthy"` and `"anthropic-proxy"`. |
| **OpenAI healthcheck** | Same pattern with `OPENAI_API_KEY` on port 10000. |
| **ANTHROPIC_BASE_URL set** | Verifies the agent container has `ANTHROPIC_BASE_URL=http://172.30.0.30:10001`. |
| **ANTHROPIC_AUTH_TOKEN placeholder** | Verifies the agent gets `ANTHROPIC_AUTH_TOKEN=placeholder-token-for-credential-isolation` (real key held by sidecar). |
| **OPENAI_BASE_URL set** | Verifies `OPENAI_BASE_URL=http://172.30.0.30:10000`. |
| **Anthropic API routing through Squid** | Makes actual POST to `/v1/messages` via proxy. Expects authentication error (proving the request reached Anthropic's servers through Squid). |
| **Health endpoint with Anthropic-only** | Verifies port 10000 health shows `openai:false, anthropic:true` when only Anthropic key is provided. |
| **Copilot healthcheck** | Starts with `COPILOT_GITHUB_TOKEN` on port 10002. |
| **COPILOT_API_URL set** | Verifies `COPILOT_API_URL=http://172.30.0.30:10002`. |
| **COPILOT_TOKEN placeholder** | Verifies `COPILOT_TOKEN=placeholder-token-for-credential-isolation`. |
| **Copilot in health providers** | Verifies health endpoint reports `copilot:true`. |

### Real-World Mapping

The API proxy sidecar is the core credential isolation mechanism. In production agentic workflows:
- The AI agent never sees the real API key (only a placeholder)
- The sidecar injects the real key when proxying requests to the API
- This prevents prompt injection attacks from exfiltrating API keys
- All API traffic still routes through Squid for domain filtering

### Gaps and Missing Coverage

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| **No test for OpenAI API routing** | Anthropic routing is tested end-to-end, but OpenAI routing is not. | Add test making POST to OpenAI endpoint and verifying auth error response. |
| **No test for Copilot API routing** | Only healthcheck and env vars tested for Copilot. | Add end-to-end routing test for Copilot. |
| **No test for all three keys simultaneously** | Real workflows may have multiple API keys. | Test with all three keys and verify all proxies are healthy. |
| **No test for API proxy with blocked domain** | What happens when Squid blocks the API domain? | Test with `enableApiProxy: true` but without the API domain in allowDomains. |
| **No test for API proxy failure/crash** | What if the sidecar crashes mid-request? | Test resilience to sidecar failures. |
| **No negative test for key leakage** | Should verify the real API key is NOT accessible in agent container. | Add test that greps for the fake API key in `/proc/*/environ` and other locations. |
| **No test for streaming responses** | Claude and OpenAI APIs use SSE streaming. | Test that streaming responses work through the proxy chain. |
| **No test for concurrent API requests** | AI agents make many parallel API calls. | Test multiple concurrent requests through the proxy. |

### Edge Cases

- What happens if `ANTHROPIC_API_KEY` is set but `api.anthropic.com` is not in allowed domains?
- What if the API proxy sidecar starts but Squid hasn't passed healthcheck yet?
- What about API key rotation during a long-running agent session?

---

## 4. Credential Hiding Security Tests

**File:** `tests/integration/credential-hiding.test.ts`

### What It Tests

| Test Case | Description |
|-----------|-------------|
| **Docker config.json hidden (normal mode)** | Reads `~/.docker/config.json` inside container. Expects empty output (file mounted from `/dev/null`). |
| **GitHub CLI hosts.yml hidden** | Reads `~/.config/gh/hosts.yml`. Expects no `oauth_token` or `gho_` strings. |
| **NPM .npmrc hidden** | Reads `~/.npmrc`. Expects no `_authToken` or `npm_` strings. |
| **Credential files are 0 bytes** | Uses `wc -c` on multiple credential files. All should be 0 bytes. |
| **Debug logs show credential hiding** | Verifies debug output contains "Using selective mounting" or "Hidden.*credential". |
| **Chroot mode hides at /host paths** | Reads `/host$HOME/.docker/config.json`. Expects empty or "No such file". |
| **Chroot mode debug logs** | Verifies chroot-specific credential hiding log messages. |
| **Chroot bypass prevention** | Critical security test: verifies credentials hidden at direct `$HOME` path (not just `/host` path). Previously a bypass vulnerability. |
| **Chroot GitHub CLI tokens hidden at direct path** | Same bypass prevention for `hosts.yml`. |
| **Simulated exfiltration: base64 encoding** | Runs `cat ... | base64` on hidden credential file. Gets empty output. |
| **Multiple encoding attempts** | Runs `cat ... | base64 | xxd -p` pipeline. Still gets empty output. |
| **Grep for tokens finds nothing** | Greps for `oauth_token`, `_authToken`, `auth:` patterns. Finds nothing. |
| **MCP logs /tmp/gh-aw/mcp-logs/ hidden (normal)** | Verifies the MCP logs directory is hidden (tmpfs overlay). |
| **MCP logs hidden (chroot)** | Same at `/host/tmp/gh-aw/mcp-logs/`. |
| **MCP log files unreadable** | Tries to read a specific log file path. Expects "No such file". |

### Real-World Mapping

This is a critical security layer. In real agentic workflows:
- The AI agent has filesystem access to write code, run tests, etc.
- A prompt injection attack could instruct the agent to read credential files
- Credential hiding prevents exfiltration of Docker Hub tokens, GitHub CLI tokens, NPM auth tokens
- The MCP logs hiding prevents reading log files that might contain sensitive operation details

### Gaps and Missing Coverage

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| **No test for Cargo credentials** | `~/.cargo/credentials.toml` may contain crates.io tokens. | Add test verifying Cargo credentials are hidden. |
| **No test for Composer auth** | `~/.composer/auth.json` may contain Packagist tokens. | Add test for Composer credentials. |
| **No test for pip/PyPI credentials** | `~/.pip/pip.conf` or `~/.config/pip/pip.conf` may contain index tokens. | Add test for Python package manager credentials. |
| **No test for SSH keys** | `~/.ssh/id_rsa`, `~/.ssh/id_ed25519` could be exfiltrated. | Add test verifying SSH keys are not accessible (or document if they're needed). |
| **No test for `/proc/self/environ` credential reading** | Agent could read its own environment via `/proc/self/environ`. | Add test reading `/proc/self/environ` and verifying sensitive tokens are cleared. (Covered partially by token-unset tests.) |
| **No test for symlink bypass** | Agent could create symlinks from accessible paths to hidden paths. | Test that symlinks to credential files resolve to `/dev/null` content. |
| **No test for bind mount information leakage** | `mount` or `cat /proc/mounts` could reveal the `/dev/null` pattern. | Test that mount info doesn't reveal the hiding mechanism. |
| **No test for credential files that don't exist on host** | Tests assume credential files exist on the host machine. | Add conditional logic or mock files for test portability. |
| **No test for cloud provider credentials** | `~/.aws/credentials`, `~/.config/gcloud/`, `~/.azure/` could contain cloud tokens. | Add tests for cloud provider credential files. |

### Edge Cases

- What if a credential file is a symlink on the host?
- What if the agent creates a new credential file (e.g., `docker login` creates `~/.docker/config.json`)?
- What about credential discovery via `find / -name "*.json" -exec grep -l auth`?
- What if a tool writes credentials to a non-standard location?

---

## 5. Token Unsetting Tests

**File:** `tests/integration/token-unset.test.ts`

### What It Tests

| Test Case | Description |
|-----------|-------------|
| **GITHUB_TOKEN unset from /proc/1/environ** | After 7s delay, reads `/proc/1/environ` and verifies `GITHUB_TOKEN` is gone. Also verifies agent can still read via `getenv`. |
| **OPENAI_API_KEY unset** | Same pattern for OpenAI key. |
| **ANTHROPIC_API_KEY unset** | Same pattern for Anthropic key. |
| **Multiple tokens simultaneously** | Sets all three tokens, verifies all cleared from `/proc/1/environ` after 7s. |
| **Works in non-chroot mode** | Sets `AWF_CHROOT_ENABLED=false`, verifies token clearing works in container-only mode. |

### Real-World Mapping

The entrypoint.sh runs the agent in the background, waits 5 seconds for initialization, then unsets sensitive tokens from the parent shell's environment. This prevents a secondary attack vector: even if credential files are hidden, an attacker could read `/proc/1/environ` to find API keys passed as environment variables. The one-shot token library caches values so the agent process can still use them.

### Gaps and Missing Coverage

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| **Fixed 7s sleep is fragile** | If agent startup takes longer (or shorter), tests may be flaky. | Use a more robust synchronization mechanism (e.g., signal file). |
| **No test for COPILOT_GITHUB_TOKEN** | Listed in `unset_sensitive_tokens()` but not tested here. | Add test for `COPILOT_GITHUB_TOKEN`. |
| **No test for all tokens in sensitive list** | `unset_sensitive_tokens()` lists 12+ tokens. Only 3 are tested. | Add tests for `GH_TOKEN`, `GITHUB_API_TOKEN`, `GITHUB_PAT`, `CLAUDE_API_KEY`, etc. |
| **No test for /proc/self/environ** | Tests check `/proc/1/environ` (PID 1) but not `/proc/self/environ` of child processes. | Add test reading `/proc/self/environ` from a child process. |
| **No test for timing race** | What if agent reads `/proc/1/environ` before the 5s unsetting delay? | Add test that reads immediately (before sleep) and after, showing the transition. |
| **No test for token values in /proc/*/cmdline** | Tokens passed via `--env` might appear in cmdline. | Verify token values don't appear in `/proc/*/cmdline`. |
| **No negative test: token not set** | Should verify that unsetting a non-existent token doesn't cause errors. | Add test with no tokens set. |

### Edge Cases

- What if the agent process forks and the child inherits the pre-unset environment?
- What if `/proc/1/environ` is not readable (restricted `/proc` mount)?
- What about tokens set via `--env` flag vs inherited from host environment?

---

## 6. One-Shot Token Protection Tests

**File:** `tests/integration/one-shot-tokens.test.ts`

### What It Tests

#### Container Mode (7 tests)

| Test Case | Description |
|-----------|-------------|
| **Cache GITHUB_TOKEN** | Uses `printenv` (forks new process each time). Both reads succeed. Verifies debug log shows token access with value preview. |
| **Cache COPILOT_GITHUB_TOKEN** | Same pattern for Copilot token. |
| **Cache OPENAI_API_KEY** | Same pattern for OpenAI key. |
| **Multiple tokens independently** | Sets GITHUB_TOKEN and OPENAI_API_KEY. Verifies both cached independently. |
| **Non-sensitive vars unaffected** | Sets `NORMAL_VAR`. Verifies it's readable multiple times without one-shot-token log messages. |
| **Python same-process caching** | Uses Python `os.getenv()` to call getenv() directly (same process). Both reads succeed via cache. |
| **Clear from /proc/self/environ** | Python test: verifies first getenv() caches, checks `os.environ` dict, second getenv() returns cached value. |

#### Chroot Mode (5 tests)

| Test Case | Description |
|-----------|-------------|
| **Cache GITHUB_TOKEN in chroot** | Same as container mode but in chroot. Verifies library copied to chroot. |
| **Cache COPILOT_GITHUB_TOKEN in chroot** | Same for Copilot token in chroot. |
| **Python caching in chroot** | Python `os.getenv()` test in chroot mode. |
| **Non-sensitive vars in chroot** | Verifies non-sensitive vars unaffected in chroot. |
| **Multiple tokens in chroot** | Multiple independent tokens in chroot mode. |

#### Edge Cases (3 tests)

| Test Case | Description |
|-----------|-------------|
| **Empty token value** | Sets `GITHUB_TOKEN=''`. Both reads return empty. |
| **Token not set** | `NONEXISTENT_TOKEN` not in environment. Both reads return empty. |
| **Special characters** | Sets token with `@#$%` characters. Both reads preserve special chars. |

### Real-World Mapping

The one-shot token library (`LD_PRELOAD`) is the core mechanism preventing token theft within the agent process. When an AI agent like Claude Code calls `getenv("ANTHROPIC_API_KEY")`:
1. First call: library caches value in memory, unsets from environment
2. Subsequent calls: library returns cached value
3. `/proc/self/environ` no longer contains the token
4. A prompt injection attack that reads `/proc/self/environ` or spawns a subprocess to `printenv` gets nothing

### Gaps and Missing Coverage

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| **No test for ANTHROPIC_API_KEY caching** | Tested in container mode but not explicitly with debug log verification like GITHUB_TOKEN. | Already covered (Test 3 in container mode). |
| **No test for Node.js `process.env` access** | Python is tested but Node.js (used by Claude Code, Copilot CLI) is not. | Add Node.js test with `process.env.GITHUB_TOKEN`. |
| **No test for Go `os.Getenv()` access** | Go is common in GitHub Actions. | Add Go test verifying LD_PRELOAD works with Go binaries. |
| **No test for compiled C program** | The library intercepts C's `getenv()`. Testing with a compiled C program would be most direct. | Add test with simple C program calling getenv(). |
| **No test for `environ` global variable** | Some programs access the `environ` array directly instead of getenv(). | Test that `extern char **environ` iteration doesn't show tokens. |
| **No test for token very long values** | What if a token is 10KB+? | Test with very long token value. |
| **No test for concurrent getenv() calls** | Multi-threaded programs calling getenv() simultaneously. | Test thread safety of the LD_PRELOAD library. |
| **No test for LD_PRELOAD being stripped** | If agent can modify LD_PRELOAD before forking. | Verify LD_PRELOAD is preserved in child processes. |
| **No test for `CLAUDE_API_KEY` or `CODEX_API_KEY`** | Listed in sensitive tokens but not tested. | Add tests for all listed sensitive tokens. |

### Edge Cases

- What if LD_PRELOAD is disabled by the runtime (e.g., setuid binaries)?
- What about statically linked binaries that don't use dynamic getenv()?
- What if a program calls `secure_getenv()` instead of `getenv()`?
- Race condition: what if two threads call getenv() for the same token simultaneously?

---

## 7. Exit Code Propagation Tests

**File:** `tests/integration/exit-code-propagation.test.ts`

### What It Tests

#### Basic Exit Codes (6 tests)

| Test Case | Description |
|-----------|-------------|
| **Exit code 0** | `exit 0` propagates as 0. Verifies "Process exiting with code: 0" in stderr. |
| **Exit code 1** | `exit 1` propagates as 1. |
| **Exit code 2** | `exit 2` propagates as 2. |
| **Exit code 42** | Custom exit code propagates correctly. |
| **Exit code 127** | Running `nonexistent_command_xyz` produces 127 (command not found). |
| **Exit code 255** | Maximum standard exit code propagates correctly. |

#### Command Exit Codes (6 tests)

| Test Case | Description |
|-----------|-------------|
| **true** | `true` command returns 0. |
| **false** | `false` command returns 1. |
| **test success** | `test 1 -eq 1` returns 0. |
| **test failure** | `test 1 -eq 2` returns 1. |
| **grep found** | `echo "hello world" \| grep hello` returns 0. |
| **grep not found** | `echo "hello world" \| grep xyz` returns 1. |

#### Pipeline Exit Codes (3 tests)

| Test Case | Description |
|-----------|-------------|
| **Last command in pipeline** | `echo "test" \| cat \| exit 5` returns 5. |
| **Compound command success** | `echo "a" && echo "b" && exit 0` returns 0. |
| **Compound command failure** | `echo "a" && false && echo "c"` returns 1 (short-circuits at `false`). |

### Real-World Mapping

Exit code propagation is essential for CI/CD integration. When AWF runs in a GitHub Actions step:
- Exit code 0 means the agent succeeded → workflow continues
- Non-zero exit code means the agent failed → workflow marks step as failed
- The correct exit code helps users diagnose what went wrong

### Gaps and Missing Coverage

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| **No test for signal-induced exit codes** | SIGTERM → 143, SIGKILL → 137. Not tested. | Add tests for signal exit codes. |
| **No test for exit codes > 255** | Shell wraps codes modulo 256. | Test `exit 256` returns 0, `exit 257` returns 1. |
| **No test for exit code from killed process** | What exit code does a `kill -9`'d process produce? | Test that AWF propagates signal-killed process codes. |
| **No test for exit code from timeout** | When `--max-time` causes curl to timeout. | Test exit code from timed-out commands. |
| **No test for exit code from OOM-killed process** | When a command is killed by OOM. | Document behavior (may not be testable in CI). |
| **No test for pipefail behavior** | `set -o pipefail` changes which exit code is returned from pipelines. | Test with `set -o pipefail` to verify behavior. |
| **No test for nested AWF invocations** | AWF running AWF (if that's ever a pattern). | May not be relevant but worth documenting. |

### Edge Cases

- What if the Docker container itself crashes (not the command)?
- What if `docker wait` returns a different code than the process's actual exit code?
- What about exit codes from `exec`'d processes within the command?

---

## 8. Error Handling Tests

**File:** `tests/integration/error-handling.test.ts`

### What It Tests

#### Network Errors (3 tests)

| Test Case | Description |
|-----------|-------------|
| **Blocked domain** | `curl -f https://example.com` with only `github.com` allowed. Expects non-zero exit. |
| **Connection refused** | `curl http://localhost:12345` where no server listens. Expects "connection failed". |
| **DNS resolution failure** | curl to non-existent domain (in allowlist). Expects "dns failed". |

#### Command Errors (3 tests)

| Test Case | Description |
|-----------|-------------|
| **Command not found** | `nonexistent_command_xyz123` returns exit code 127. |
| **Permission denied** | `cat /etc/shadow` fails with permission denied. |
| **File not found** | `cat /nonexistent/file/path` fails with "No such file". |

#### Script Errors (2 tests)

| Test Case | Description |
|-----------|-------------|
| **Bash syntax error** | `bash -c "if then fi"` caught with `\|\| echo`. |
| **Division by zero** | `bash -c "echo $((1/0))"` caught with `\|\| echo`. |

#### Process Signals (1 test)

| Test Case | Description |
|-----------|-------------|
| **SIGTERM from command** | `kill -TERM $$` self-terminates. Verifies firewall handles it gracefully (result is defined). |

#### Recovery After Errors (1 test)

| Test Case | Description |
|-----------|-------------|
| **Continue after failure** | Runs `false` then `echo "recovery test"`. Verifies second command works (they're separate AWF invocations). |

### Real-World Mapping

Error handling is critical for production reliability:
- Network errors occur when agents try to access domains not in the allowlist
- Command errors occur when agent-generated commands have bugs
- Script errors happen when AI-generated code has syntax issues
- Signal handling ensures the firewall cleans up properly when interrupted
- Recovery after errors ensures the system doesn't enter a broken state

### Gaps and Missing Coverage

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| **No test for Docker daemon unavailable** | What if Docker is not running when AWF starts? | Test CLI behavior when Docker socket is missing. |
| **No test for disk full** | What if `/tmp` is full and work directory can't be created? | Test behavior with limited disk space. |
| **No test for Squid proxy crash** | What if Squid crashes mid-session? | Test agent behavior when Squid becomes unreachable. |
| **No test for network partition** | What if the Docker network goes down? | Test behavior when `awf-net` becomes unavailable. |
| **No test for SIGKILL handling** | SIGKILL cannot be caught. What state is left behind? | Document and test cleanup behavior after SIGKILL. |
| **No test for SIGINT (Ctrl+C) during command** | The most common user interruption pattern. | Test that SIGINT properly stops containers and cleans up. |
| **No test for concurrent error + cleanup** | What if error occurs during cleanup? | Test nested error handling scenarios. |
| **No test for invalid CLI arguments** | What happens with `--allow-domains ""` or `--dns-servers invalid`? | Already tested at unit level but not integration. |
| **No test for container startup timeout** | What if container image pull takes too long? | Test behavior with unreachable registry. |
| **No test for resource cleanup verification** | After error, verify Docker networks/containers/volumes are cleaned up. | Add post-test assertions checking Docker state. |

### Edge Cases

- What if the error occurs in a `trap` handler itself?
- What if multiple signals arrive in rapid succession?
- What about errors in the iptables cleanup phase?
- What if the work directory is deleted by another process during execution?

---

## 9. Cross-Cutting Observations

### Strengths

1. **Defense in depth**: The security tests cover multiple layers (credential hiding, token unsetting, one-shot tokens, API proxy isolation).
2. **Both modes tested**: Most security tests cover both normal and chroot mode.
3. **Real-world attack simulation**: The credential hiding tests simulate actual exfiltration attacks (base64, xxd, grep patterns).
4. **Custom matchers**: The `toSucceed()`, `toFail()`, `toExitWithCode()` matchers provide clear, readable assertions.
5. **Bypass prevention**: Tests specifically cover the chroot bypass vulnerability (Test 8) that was previously discovered and fixed.
6. **Broad API proxy coverage**: Tests cover all three API providers (OpenAI, Anthropic, Copilot) for healthchecks and env wiring; end-to-end request routing and credential isolation are currently verified in depth only for Anthropic.

### Systemic Gaps

1. **No stress testing**: No tests verify behavior under load, concurrent requests, or resource exhaustion.
2. **No timing/performance tests**: No tests verify that proxy overhead is within acceptable bounds.
3. **Limited negative testing for security**: While credential hiding is well-tested, other security bypasses (iptables manipulation, network namespace escape, container escape) are not tested.
4. **Fragile timing dependencies**: The token-unset tests rely on fixed `sleep 7` delays which could be flaky in slow CI environments.
5. **Test isolation concerns**: Tests share cleanup fixtures. A failed test could leave state that affects subsequent tests.
6. **No test for the full workflow**: No end-to-end test runs an actual AI agent (even a mock one) through the complete AWF pipeline.
7. **Missing SSL Bump tests**: The `--ssl-bump` feature is configured in the CLI but has no integration tests in this set.
8. **Missing blocked-domains tests**: The `--block-domains` feature (deny-list on top of allow-list) has no integration tests.
9. **No test for `--env-all` security implications**: Passing all host env vars could leak credentials.
10. **No test for log output sanitization**: Verifying that real API keys never appear in logs/stderr.
