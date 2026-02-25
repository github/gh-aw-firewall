# Integration Tests Coverage Guide

A comprehensive guide to what the gh-aw-firewall integration tests cover, what they don't cover, and how they relate to real-world usage in GitHub Agentic Workflows.

**Last updated:** February 2026

---

## Quick Navigation

| Area | Tests | Doc |
|------|-------|-----|
| Domain filtering, DNS, network security | 6 files, ~50 tests | [domain-network.md](test-analysis/domain-network.md) |
| Chroot sandbox, languages, package managers | 5 files, ~70 tests | [chroot.md](test-analysis/chroot.md) |
| Protocol support, credentials, tokens | 8 files, ~100 tests | [protocol-security.md](test-analysis/protocol-security.md) |
| Containers, volumes, git, env vars | 7 files, ~45 tests | [container-ops.md](test-analysis/container-ops.md) |
| CI workflows, smoke tests, build-test | 27 workflows | [ci-smoke.md](test-analysis/ci-smoke.md) |
| Test fixtures and infrastructure | 6 helper files | [test-infra.md](test-analysis/test-infra.md) |

---

## Overview

The test suite is organized in three tiers:

```
┌─────────────────────────────────────────────────────┐
│  Smoke Tests (5 workflows)                          │
│  Real AI agents (Claude, Copilot, Codex, Gemini)    │
│  running inside AWF sandbox                         │
├─────────────────────────────────────────────────────┤
│  Build-Test Workflows (8 workflows)                 │
│  Real projects (Go, Rust, Java, Node, etc.)         │
│  built and tested through the firewall proxy        │
├─────────────────────────────────────────────────────┤
│  Integration Tests (26 files, ~265 tests)           │
│  End-to-end AWF container execution with            │
│  domain filtering, chroot, security assertions      │
├─────────────────────────────────────────────────────┤
│  Unit Tests (19 files)                              │
│  Individual module testing (parser, config, logger)  │
└─────────────────────────────────────────────────────┘
```

### Test Counts by Category

| Category | Files | Approx Tests | CI Workflow |
|----------|-------|-------------|-------------|
| Domain/Network | 6 | 50 | **None** (not run in CI!) |
| Chroot | 5 | 70 | `test-chroot.yml` (4 jobs) |
| Protocol/Security | 8 | 100 | **None** (not run in CI!) |
| Container/Ops | 7 | 45 | **None** (not run in CI!) |
| Unit Tests | 19 | ~200 | `test-coverage.yml` |
| Smoke Tests | 5 | N/A | Per-workflow (scheduled + PR) |
| Build-Test | 8 | N/A | Per-workflow (PR + dispatch) |

---

## What's Well Covered

### 1. Chroot Filesystem Isolation (Strong)

The chroot tests are the most mature, run in CI, and cover critical scenarios:

- **Language runtimes**: Python, Node.js, Go, Java, .NET, Ruby, Rust all verified accessible through chroot
- **Package managers**: pip, npm, cargo, maven, dotnet, gem, go modules — all tested for registry connectivity
- **Security properties**: NET_ADMIN/SYS_CHROOT capability drop, Docker socket hidden, non-root execution
- **/proc filesystem**: Dynamic mount verified for JVM and .NET CLR compatibility
- **Shell features**: Pipes, redirects, command substitution, compound commands all work in chroot

**CI coverage**: 4 parallel jobs in `test-chroot.yml` exercise these tests on every PR.

### 2. Credential Isolation (Strong)

Multi-layered defense tested at each level:

- **Credential file hiding**: Docker config, GitHub CLI tokens, npmrc auth tokens all verified hidden via `/dev/null` overlays
- **Exfiltration resistance**: base64 encoding, xxd pipelines, grep patterns all tested — return empty
- **Chroot bypass prevention**: Specific regression test for the vulnerability where credentials were accessible at `$HOME` but not `/host$HOME`
- **API proxy sidecar**: Agent gets placeholder tokens; real keys held by proxy. Healthchecks for OpenAI, Anthropic, Copilot
- **One-shot token library**: LD_PRELOAD intercepts `getenv()`, caches value, clears from environment. Tested in both container and chroot modes
- **Token unsetting from /proc/1/environ**: GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY all verified cleared

### 3. Multi-Engine Smoke Tests (Strong)

Real AI agents running through the full AWF pipeline:

- **Claude**: GitHub MCP, Playwright browser automation, file I/O, bash tools
- **Copilot**: Same + web-fetch, agentic-workflows tools
- **Codex**: GH CLI safe inputs, Tavily web search, discussion interactions
- **Gemini**: Same feature set as Codex, different engine path

### 4. Multi-Language Build-Test (Strong)

8 language ecosystems tested with real open-source projects:

- Bun, C++, Deno, .NET, Go, Java, Node.js, Rust
- Each clones a test repo, installs dependencies, builds, and runs tests through AWF

### 5. Exit Code Propagation (Good)

15 tests covering exit codes 0-255, command exit codes, pipeline behavior. Critical for CI/CD integration where non-zero = failure.

---

## Critical Gaps

### Gap 1: Most Integration Tests Don't Run in CI

**Severity: Critical**

The `test-integration.yml` workflow is actually just a TypeScript type-check. It does **not** run the integration test suite. This means 20+ integration test files covering domains, DNS, environment variables, exit codes, error handling, network security, credentials, and protocols have **no CI pipeline**.

Only the 5 chroot test files run in CI (via `test-chroot.yml`).

**Impact**: Regressions in domain filtering, credential hiding, exit code propagation, and network security would go undetected until someone runs tests locally.

### Gap 2: `--block-domains` Completely Untested

**Severity: Critical**

The `--block-domains` CLI flag (deny-list on top of allow-list) has zero integration tests. The `blocked-domains.test.ts` file is a misnomer — it only tests allow-list behavior. The `AwfRunner` test fixture doesn't even expose a `blockDomains` option.

**Impact**: If `--block-domains` breaks, no test catches it.

### Gap 3: `--env-all` Never Tested

**Severity: Critical**

The `--env-all` flag is the **primary production mode** — used by `gh-aw`'s `BuildAWFArgs()` to pass all GitHub Actions environment variables into the container. The `environment-variables.test.ts` file header mentions it, but no test uses `envAll: true`.

**Impact**: The most common production invocation pattern has zero test coverage.

### Gap 4: DNS Restriction Enforcement Untested

**Severity: High**

The `--dns-servers` flag restricts DNS traffic to whitelisted resolvers (preventing DNS-based exfiltration). While `dns-servers.test.ts` exists, no test verifies that queries to **non-whitelisted** DNS servers are actually blocked. All tests use the default or explicitly whitelisted servers.

**Impact**: DNS exfiltration prevention — a key security feature — is unverified.

### Gap 5: No Package Installation Tests

**Severity: High**

Package manager tests (in `chroot-package-managers.test.ts`) only **query** registries (`pip index versions`, `npm view`, `cargo search`, `gem search`) but never **install** packages (`pip install`, `npm install`, `cargo add`). This is the most common real-world operation.

The build-test workflows partially compensate (they run `npm install`, `cargo build`, etc.) but these are AI-agent-driven and non-deterministic.

**Impact**: A regression in package installation through the proxy would not be caught by deterministic tests.

### Gap 6: `git push` and Authenticated Git Untested

**Severity: High**

`git-operations.test.ts` tests clone, ls-remote, and config but **not** `git push` (the most important write operation in agentic workflows) or any authenticated git operation. Every production workflow uses authenticated git to push branches and create PRs.

**Impact**: If authenticated git push breaks through the proxy, no test catches it.

### Gap 7: No Localhost HTTP Request Tests

**Severity: High**

`localhost-access.test.ts` verifies configuration (iptables rules, Squid ACLs) but never makes an actual HTTP request to localhost. MCP servers run on localhost inside the container — a real request test is needed.

### Gap 8: Docker Warning Tests Entirely Skipped

**Severity: Medium**

`docker-warning.test.ts` is wrapped in `describe.skip` with a stale TODO about a build issue. These 5 tests provide zero coverage.

### Gap 9: Fragile Timing Dependencies

**Severity: Medium**

Token-unset tests rely on `sleep 7` to wait for the 5-second unsetting delay. Log-command tests use `if (existsSync())` guards that silently pass when logs aren't created. These patterns mask real failures and cause flakiness.

### Gap 10: No SSL Bump Integration Tests

**Severity: Medium**

The `--ssl-bump` feature is configured in the CLI but has zero integration tests. This feature enables HTTPS content inspection and is important for some security-sensitive deployments.

---

## Coverage Heat Map

A visual overview of what's tested vs. not:

```
Feature                          Unit  Integration  CI   Smoke  Build-Test
─────────────────────────────────────────────────────────────────────────
Domain allow-list                 ✅      ✅         ❌    ✅      ✅
Domain deny-list (--block-domains) ❌      ❌         ❌    ❌      ❌
Wildcard patterns                 ✅      ✅         ❌    ❌      ❌
Empty domains (air-gapped)        ❌      ✅         ❌    ❌      ❌
DNS server restriction            ✅      ⚠️ *       ❌    ❌      ❌
Network security (SSRF, bypass)   ❌      ✅         ❌    ❌      ❌
Chroot languages                  ❌      ✅         ✅    ✅      ✅
Chroot package managers           ❌      ✅         ✅    ❌      ✅
Chroot /proc filesystem           ❌      ✅         ✅    ❌      ❌
Chroot edge cases                 ❌      ✅         ✅    ❌      ❌
Credential hiding                 ❌      ✅         ❌    ❌      ❌
Token unsetting                   ❌      ✅         ❌    ❌      ❌
One-shot tokens (LD_PRELOAD)      ❌      ✅         ❌    ❌      ❌
API proxy sidecar                 ❌      ✅         ❌    ❌      ❌
Protocol support (HTTP/HTTPS)     ❌      ✅         ❌    ❌      ❌
IPv6                              ❌      ✅         ❌    ❌      ❌
Exit code propagation             ❌      ✅         ❌    ❌      ❌
Error handling                    ❌      ✅         ❌    ❌      ❌
Volume mounts                     ❌      ✅         ❌    ❌      ❌
Container workdir                 ❌      ✅         ❌    ❌      ❌
Git operations                    ❌      ✅         ❌    ❌      ❌
Environment variables             ❌      ✅         ❌    ❌      ❌
--env-all                         ❌      ❌         ❌    ❌      ❌
SSL Bump                          ✅      ❌         ❌    ❌      ❌
Log commands                      ✅      ⚠️ *       ❌    ❌      ❌
Docker unavailability             ❌      ✅         ❌    ❌      ❌
Docker warning stub               ❌      ❌ **      ❌    ❌      ❌
Setup action (action.yml)         ❌      ❌         ✅    ❌      ❌
Container security scan           ❌      ❌         ✅    ❌      ❌
Dependency audit                  ❌      ❌         ✅    ❌      ❌

* ⚠️ = Tests exist but have significant gaps (see detailed docs)
** = Tests exist but are skip'd
```

---

## Test Infrastructure Summary

### How Tests Run

- **Serial execution** (`maxWorkers: 1`) — Docker network/container conflicts prevent parallelism
- **120-second timeout** per test — container lifecycle takes 15-25 seconds
- **Batch runner** groups commands sharing the same config into single containers — reduces ~73 startups to ~27 for chroot tests
- **Custom Jest matchers**: `toSucceed()`, `toFail()`, `toExitWithCode()`, `toTimeout()`, `toAllowDomain()`, `toBlockDomain()`
- **4-stage cleanup**: pre-test TypeScript cleanup → AWF normal exit → AWF signal handlers → CI always-cleanup

### Infrastructure Limitations

1. Docker + sudo required — no lightweight local testing
2. Batch runner loses individual stderr (merged via `2>&1`)
3. Log-based matchers require `keepContainers: true`
4. Aggressive `docker prune` in cleanup can affect non-AWF containers
5. No retry logic for flaky network tests

See [test-infra.md](test-analysis/test-infra.md) for full infrastructure analysis.

---

## Recommended Priority Actions

### P0: Run Integration Tests in CI

Create a CI workflow that actually runs the non-chroot integration tests. Currently, ~150 tests across 20+ files have no CI pipeline.

### P1: Add `--block-domains` Tests

Add `blockDomains` support to `AwfRunner` and write tests for the deny-list feature:
- Block specific subdomain while allowing parent
- Block takes precedence over allow
- Wildcard blocking patterns

### P1: Add `--env-all` Tests

Add tests using `envAll: true` to verify:
- All host env vars pass through
- Sensitive tokens are properly filtered
- Proxy env vars (HTTP_PROXY, HTTPS_PROXY) are set correctly

### P1: Add DNS Restriction Enforcement Test

Test that DNS queries to non-whitelisted servers are actually blocked:
```
dig @1.2.3.4 example.com  # Should fail with non-whitelisted DNS
```

### P2: Add Package Installation Tests

Test actual `pip install`, `npm install`, `cargo add` through the proxy instead of just registry queries.

### P2: Add `git push` with Authentication Test

Test authenticated git push through the proxy — the most critical write operation in agentic workflows.

### P2: Enable or Remove Skipped Docker Warning Tests

Either fix the build issue or remove the dead `describe.skip` block.

### P3: Fix Fragile Timing Dependencies

Replace `sleep 7` in token-unset tests with signal-file synchronization. Replace `if (existsSync())` guards with hard assertions.

---

## Detailed Analysis Documents

Each document provides per-test-case analysis with plain-language descriptions, real-world mappings, and gap identification:

- **[Domain & Network Tests](test-analysis/domain-network.md)** — Domain filtering, DNS, network security, localhost
- **[Chroot Tests](test-analysis/chroot.md)** — Sandbox isolation, languages, package managers, /proc, edge cases
- **[Protocol & Security Tests](test-analysis/protocol-security.md)** — HTTP/HTTPS, IPv6, API proxy, credentials, tokens, exit codes
- **[Container & Operations Tests](test-analysis/container-ops.md)** — Workdir, volumes, git, env vars, logging, Docker availability
- **[CI & Smoke Tests](test-analysis/ci-smoke.md)** — All 27 CI/smoke/build-test workflows analyzed
- **[Test Infrastructure](test-analysis/test-infra.md)** — Runner architecture, batch pattern, cleanup strategy, limitations
