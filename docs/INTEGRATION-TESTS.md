# Integration Tests Coverage Guide

A reference guide to what the gh-aw-firewall integration tests cover and how they relate to real-world usage in GitHub Agentic Workflows.

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
│  Smoke Tests (4 workflows)                          │
│  Smoke workflows (Claude, Copilot, Codex, Chroot)   │
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
| Domain/Network | 6 | 50 | None |
| Chroot | 5 | 70 | `test-chroot.yml` (4 jobs) |
| Protocol/Security | 8 | 100 | None |
| Container/Ops | 7 | 45 | None |
| Unit Tests | 19 | ~200 | `test-coverage.yml` |
| Smoke Tests | 4 | N/A | Per-workflow (scheduled + PR) |
| Build-Test | 8 | N/A | Per-workflow (PR + dispatch) |

---

## What's Covered

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

### 4. Multi-Language Build-Test (Strong)

8 language ecosystems tested with real open-source projects:

- Bun, C++, Deno, .NET, Go, Java, Node.js, Rust
- Each clones a test repo, installs dependencies, builds, and runs tests through AWF

### 5. Exit Code Propagation (Good)

15 tests covering exit codes 0-255, command exit codes, pipeline behavior. Critical for CI/CD integration where non-zero = failure.

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
** = Tests exist but are skipped
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

## Detailed Analysis Documents

Each document provides per-test-case analysis with plain-language descriptions, real-world mappings, and gap identification:

- **[Domain & Network Tests](test-analysis/domain-network.md)** — Domain filtering, DNS, network security, localhost
- **[Chroot Tests](test-analysis/chroot.md)** — Sandbox isolation, languages, package managers, /proc, edge cases
- **[Protocol & Security Tests](test-analysis/protocol-security.md)** — HTTP/HTTPS, IPv6, API proxy, credentials, tokens, exit codes
- **[Container & Operations Tests](test-analysis/container-ops.md)** — Workdir, volumes, git, env vars, logging, Docker availability
- **[CI & Smoke Tests](test-analysis/ci-smoke.md)** — All 27 CI/smoke/build-test workflows analyzed
- **[Test Infrastructure](test-analysis/test-infra.md)** — Runner architecture, batch pattern, cleanup strategy, limitations
