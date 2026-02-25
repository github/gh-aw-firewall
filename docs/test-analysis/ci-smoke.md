# CI Workflows and Smoke Tests Analysis

This document catalogs all CI workflows and smoke/build-test agentic workflows in gh-aw-firewall, describing what each tests, when it runs, what real-world scenario it validates, coverage gaps, and how it relates to the Node.js integration test suite.

---

## Table of Contents

1. [CI Workflow Overview](#ci-workflow-overview)
2. [Core CI Workflows](#core-ci-workflows)
3. [Smoke Test Workflows (Agentic)](#smoke-test-workflows-agentic)
4. [Build-Test Workflows (Agentic)](#build-test-workflows-agentic)
5. [Security & Compliance Workflows](#security--compliance-workflows)
6. [Infrastructure Workflows](#infrastructure-workflows)
7. [Relationship Map: CI vs Integration Tests](#relationship-map-ci-vs-integration-tests)
8. [Coverage Gap Analysis](#coverage-gap-analysis)

---

## CI Workflow Overview

The repo has three tiers of testing:

| Tier | Type | Count | Purpose |
|------|------|-------|---------|
| **Unit** | Jest (src/*.test.ts) | 19 files | Fast feedback on individual modules |
| **Integration** | Jest (tests/integration/*.test.ts) | 26 files | End-to-end AWF container execution |
| **Smoke/Build-Test** | gh-aw compiled workflows (.lock.yml) | 28 workflows | Real AI agent execution inside AWF sandbox |
| **CI** | Hand-written GitHub Actions (.yml) | 15 workflows | Build, lint, type-check, security, coverage |

---

## Core CI Workflows

### 1. `test-integration.yml` — TypeScript Type Check

**File**: `.github/workflows/test-integration.yml`

| Attribute | Value |
|-----------|-------|
| **What it tests** | TypeScript type-checking via `npm run type-check`. Despite the filename, this does NOT run integration tests. |
| **Triggers** | Push to main, PR to main, manual dispatch |
| **Timeout** | 5 minutes |
| **Real-world mapping** | Validates that TypeScript code compiles without type errors before merge |
| **Gaps** | Only checks types, not runtime behavior. Name is misleading (suggests integration tests). |
| **Integration test relationship** | Complementary — type checking catches compile-time errors; integration tests catch runtime issues. |

### 2. `test-chroot.yml` — Chroot Integration Tests

**File**: `.github/workflows/test-chroot.yml`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Runs the chroot integration test suite across 4 parallel jobs: Language Support, Package Managers, /proc Filesystem, Edge Cases |
| **Triggers** | Push to main, PR to main, manual dispatch |
| **Timeout** | 30-45 minutes per job |
| **Real-world mapping** | Validates that the chroot-based filesystem isolation works correctly with multiple languages (Node, Python, Go, Java, .NET, Ruby, Rust) and package managers |
| **Gaps** | Sequential dependency: package-managers waits for languages job. No macOS testing. |
| **Integration test relationship** | **Direct 1:1 mapping** — this workflow runs `tests/integration/chroot-languages.test.ts`, `chroot-package-managers.test.ts`, `chroot-procfs.test.ts`, and `chroot-edge-cases.test.ts` |

**Jobs breakdown:**
- **test-chroot-languages** — Sets up Node.js, Python 3.12, Go 1.22, Java 21, .NET 8.0. Builds containers locally. Runs `chroot-languages` integration tests.
- **test-chroot-package-managers** (needs: languages) — Adds Ruby 3.2, Rust stable. Runs `chroot-package-managers` integration tests. 45-minute timeout.
- **test-chroot-procfs** (parallel) — Tests /proc filesystem access within chroot. Python, Java only.
- **test-chroot-edge-cases** (parallel) — Tests edge cases. Node.js only.

Key detail: Containers are built locally (`docker build`), so source changes to `entrypoint.sh` and `docker-manager.ts` ARE reflected in tests.

### 3. `test-coverage.yml` — Test Coverage

**File**: `.github/workflows/test-coverage.yml`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Runs unit tests with coverage collection. On PRs: compares coverage against base branch and fails on regression. On push: generates coverage summary. |
| **Triggers** | Push to main, PR to main (ignoring .md files) |
| **Timeout** | 15 minutes |
| **Real-world mapping** | Ensures PRs don't reduce test coverage — guards against "add feature, skip tests" PRs |
| **Gaps** | Only covers unit tests (src/*.test.ts), not integration tests. Node.js 20 only (build.yml tests 20+22). |
| **Integration test relationship** | Only measures coverage of unit tests. Integration test coverage is not tracked. |

**Notable features:**
- Checks out base branch to compute coverage diff
- Posts coverage comparison as PR comment
- Uploads coverage artifacts (30-day retention)
- Fails PR if coverage regresses

### 4. `test-action.yml` — Setup Action Tests

**File**: `.github/workflows/test-action.yml`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Tests the `action.yml` composite action that installs AWF from GitHub releases |
| **Triggers** | Push to main, PR to main (ignoring .md files), manual dispatch |
| **Timeout** | 5-10 minutes per job |
| **Real-world mapping** | Validates that users can install AWF via `uses: github/gh-aw-firewall@v1` in their workflows |
| **Gaps** | Only tests installation, not actual firewall functionality. Tests version v0.7.0 specifically (may go stale). |
| **Integration test relationship** | No overlap — tests the GitHub Action packaging, not the firewall itself |

**Jobs:**
- **test-action-latest** — Install latest version, verify `awf --version` and `awf --help` work
- **test-action-specific-version** — Install v0.7.0, verify exact version/image-tag outputs match
- **test-action-with-images** — Install v0.7.0 with `pull-images: true`, verify Docker images are pulled
- **test-action-invalid-version** — Install `invalid-version`, verify action fails gracefully

### 5. `test-examples.yml` — Examples Test

**File**: `.github/workflows/test-examples.yml`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Runs example shell scripts from `examples/` directory as smoke tests |
| **Triggers** | Push to main, PR to main (ignoring .md files), manual dispatch |
| **Timeout** | 15 minutes |
| **Real-world mapping** | Validates that documentation examples actually work — prevents stale README instructions |
| **Gaps** | Skips `github-copilot.sh` (requires GITHUB_TOKEN). Only 4 of 5 examples tested. |
| **Integration test relationship** | Complementary — examples test real AWF invocations from shell scripts, while integration tests use the Jest/TypeScript test runner |

**Examples tested:**
1. `basic-curl.sh` — Basic domain allow/block with curl
2. `using-domains-file.sh` — Domain list from file
3. `debugging.sh` — Debug mode with `--keep-containers`
4. `blocked-domains.sh` — Verify blocked domains return errors

### 6. `build.yml` — Build Verification

**File**: `.github/workflows/build.yml`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Builds TypeScript project and runs linter across Node.js 20 and 22 matrix |
| **Triggers** | Push to main, PR to main, manual dispatch |
| **Timeout** | 10 minutes |
| **Real-world mapping** | Ensures the project builds successfully on supported Node.js versions |
| **Gaps** | No Node.js 18 testing (though `pkg` in release uses node18 targets). No test execution. |
| **Integration test relationship** | Prerequisite — if build fails, nothing else runs. No direct test overlap. |

### 7. `lint.yml` — ESLint

**File**: `.github/workflows/lint.yml`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Runs ESLint on TypeScript source |
| **Triggers** | Push to main, PR to main (ignoring .md files) |
| **Timeout** | 5 minutes |
| **Real-world mapping** | Code quality enforcement |
| **Gaps** | Duplicated with `build.yml` which also runs `npm run lint`. |
| **Integration test relationship** | None — code quality only |

---

## Smoke Test Workflows (Agentic)

These are gh-aw agentic workflows compiled from `.md` source files into `.lock.yml` GitHub Actions workflows. They run **actual AI agents** (Claude, Copilot, Codex, Gemini) inside the AWF sandbox.

**Post-processing**: All `.lock.yml` files are post-processed by `scripts/ci/postprocess-smoke-workflows.ts` which replaces GHCR image references with local builds (`--build-local`), removes sparse-checkout, and installs AWF from source.

### 8. `smoke-claude.lock.yml` — Smoke Claude

**Source**: `smoke-claude.md`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Claude Code engine running inside AWF sandbox with MCP servers, Playwright, file I/O, and bash tools |
| **Engine** | `claude` (max 15 turns) |
| **Triggers** | Every 12h (schedule), PR (opened/synchronize/reopened), manual dispatch |
| **Timeout** | 10 minutes |
| **Network allowed** | defaults, github, playwright |
| **Tools** | cache-memory, github (repos, pull_requests), playwright, edit, bash |
| **Safe outputs** | add-comment (hide older), add-labels (smoke-claude) |
| **MCP** | ghcr.io/github/gh-aw-mcpg container |
| **Real-world mapping** | Validates that Claude Code can operate within AWF's network sandbox: GitHub API access via MCP, browser automation via Playwright, local file operations — the core use case for agentic workflows |
| **Gaps** | Non-deterministic (AI agent may behave differently). No HTTPS blocking verification. |
| **Integration test relationship** | High-level end-to-end complement. Integration tests verify AWF mechanics (iptables, proxy); this verifies an actual AI agent works through the firewall. |

**Test requirements:**
1. GitHub MCP: Review last 2 merged PRs
2. Playwright: Navigate to github.com, verify page title
3. File writing: Create test file, verify with cat
4. Bash: Execute commands to verify file creation
5. Post-step: Validate safe outputs were invoked (add_comment for PR triggers)

### 9. `smoke-copilot.lock.yml` — Smoke Copilot

**Source**: `smoke-copilot.md`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Copilot engine running inside AWF sandbox with MCP, Playwright, web-fetch, and agentic-workflows tools |
| **Engine** | `copilot` |
| **Triggers** | Every 12h, PR, manual dispatch |
| **Timeout** | 5 minutes |
| **Network allowed** | defaults, node, github, playwright |
| **Tools** | agentic-workflows, cache-memory, edit, bash, github, playwright, web-fetch |
| **Real-world mapping** | Validates Copilot CLI agent works through AWF with broader network access (node registries) and additional tools |
| **Gaps** | Shorter timeout (5min) may cause flaky failures. No blocked-domain verification. |
| **Integration test relationship** | Similar to smoke-claude but for Copilot engine. Tests a different engine implementation path. |

### 10. `smoke-codex.lock.yml` — Smoke Codex

**Source**: `smoke-codex.md`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Codex engine with extended tool suite: GH CLI safe inputs, Tavily web search, discussion interactions, and AWF project build |
| **Engine** | `codex` |
| **Triggers** | Every 12h, PR, manual dispatch |
| **Timeout** | 15 minutes |
| **Network allowed** | defaults, github, playwright |
| **Tools** | cache-memory, github, playwright, edit, bash |
| **Safe outputs** | add-comment, create-issue, add-labels, hide-comment |
| **Imports** | shared/gh.md, shared/mcp/tavily.md, shared/reporting.md, shared/github-queries-safe-input.md |
| **Real-world mapping** | Most comprehensive smoke test — validates safe-inputs (gh CLI), Tavily MCP, discussion API, and build capability |
| **Gaps** | Complex prompt may cause non-deterministic failures. Build step (`npm ci && npm run build`) adds latency. |
| **Integration test relationship** | Tests discussion interactions and create-issue safe outputs that integration tests don't cover |

**Additional test requirements beyond Claude/Copilot:**
- Safe Inputs GH CLI: Query PRs via `safeinputs-gh`
- Tavily web search: Search for "GitHub Agentic Workflows Firewall"
- Discussion interaction: Comment on latest discussion
- Build AWF: Run `npm ci && npm run build` inside sandbox

### 11. `smoke-gemini.lock.yml` — Smoke Gemini

**Source**: `smoke-gemini.md`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Gemini engine with same extended tool suite as Codex smoke test |
| **Engine** | `gemini` |
| **Triggers** | Every 12h, PR, manual dispatch |
| **Timeout** | 15 minutes |
| **Real-world mapping** | Validates Gemini (Google) engine works through AWF — important for multi-engine support |
| **Gaps** | Same as Codex. Identical test requirements — could share test definition via imports. |
| **Integration test relationship** | Same as Codex — tests a different engine path through the same infrastructure |

### 12. `smoke-chroot.lock.yml` — Smoke Chroot

**Source**: `smoke-chroot.md`

| Attribute | Value |
|-----------|-------|
| **What it tests** | Chroot filesystem isolation by comparing host vs chroot runtime versions (Python, Node.js, Go) |
| **Engine** | `copilot` |
| **Triggers** | PR (with path filter: src/**, containers/**, package.json, smoke-chroot.md), manual dispatch |
| **Timeout** | 20 minutes |
| **Network allowed** | defaults, github |
| **Tools** | github (repos, pull_requests), bash |
| **Real-world mapping** | Validates the core chroot feature: host binaries must be accessible inside the container with matching versions |
| **Gaps** | Only tests 3 runtimes (Python, Node, Go). No Java/.NET/Ruby/Rust version comparison. Path-filtered — won't run on non-code PRs. |
| **Integration test relationship** | **Overlaps with** `chroot-languages.test.ts` but approaches differently: smoke test runs `awf` → agent compares versions; integration test runs `awf` → Jest assertions compare versions |

**Unique architecture:**
- Pre-steps capture host versions, run `awf --skip-pull` for each runtime, compare
- Agent only reads result files and creates PR comment with comparison table
- Uses `--skip-pull` (locally-built containers from pre-steps)

---

## Build-Test Workflows (Agentic)

These are agentic workflows that clone external test repositories and run real build/test commands through the AWF sandbox. They validate that AWF's network filtering allows language-specific package managers to function correctly.

All build-test workflows share a common pattern:
- **Engine**: `copilot`
- **Triggers**: PR (opened/synchronize/reopened), manual dispatch
- **Tools**: bash, github (with GH_AW_GITHUB_MCP_SERVER_TOKEN)
- **MCP**: ghcr.io/github/gh-aw-mcpg container
- **Safe outputs**: add-comment, add-labels
- **Error handling**: `safeoutputs-missing_tool` on clone failure, table-based reporting
- **Test repos**: `Mossaka/gh-aw-firewall-test-{language}`

### 13. `build-test-bun.lock.yml` — Build Test Bun

| Attribute | Value |
|-----------|-------|
| **What it tests** | Install Bun from bun.sh, clone test-bun repo, run `bun install && bun test` on elysia and hono projects |
| **Network** | defaults, github, node, bun.sh |
| **Timeout** | 15 minutes |
| **Real-world mapping** | Validates AWF allows Bun runtime installation and package fetching |
| **Gaps** | Bun installed via curl (no version pinning). Only 2 projects tested. |
| **Integration test relationship** | Extends beyond integration tests — no integration test covers Bun specifically |

### 14. `build-test-cpp.lock.yml` — Build Test C++

| Attribute | Value |
|-----------|-------|
| **What it tests** | Clone test-cpp repo, run CMake + Make on fmt and json (nlohmann) libraries |
| **Network** | defaults, github |
| **Timeout** | 30 minutes |
| **Real-world mapping** | Validates C++ projects with no external network dependencies build inside AWF |
| **Gaps** | No package manager (vcpkg/conan) testing. Build-only, no test execution. |
| **Integration test relationship** | No integration test equivalent |

### 15. `build-test-deno.lock.yml` — Build Test Deno

| Attribute | Value |
|-----------|-------|
| **What it tests** | Install Deno from deno.land, clone test-deno repo, run `deno test` on oak and std |
| **Network** | defaults, github, node, deno.land, jsr.io, dl.deno.land |
| **Timeout** | 15 minutes |
| **Real-world mapping** | Validates AWF allows Deno installation and JSR/deno.land package fetching |
| **Gaps** | No version pinning for Deno install. Only 2 projects. |
| **Integration test relationship** | No integration test equivalent |

### 16. `build-test-dotnet.lock.yml` — Build Test .NET

| Attribute | Value |
|-----------|-------|
| **What it tests** | Clone test-dotnet repo, `dotnet restore && dotnet build && dotnet run` on hello-world and json-parse |
| **Runtime** | dotnet 8.0 |
| **Network** | defaults, github, dotnet |
| **Timeout** | 15 minutes |
| **Real-world mapping** | Validates NuGet package restoration and .NET build through AWF proxy |
| **Gaps** | Very simple projects. No `dotnet test` execution. |
| **Integration test relationship** | Complements `chroot-package-managers.test.ts` which tests `dotnet --version` but not actual NuGet restore |

### 17. `build-test-go.lock.yml` — Build Test Go

| Attribute | Value |
|-----------|-------|
| **What it tests** | Clone test-go repo, `go mod download && go test ./...` on color, env, uuid projects |
| **Runtime** | go 1.22 |
| **Network** | defaults, github, go |
| **Timeout** | 15 minutes |
| **Real-world mapping** | Validates Go module proxy access and test execution through AWF |
| **Gaps** | Small projects with few dependencies. No CGO testing. |
| **Integration test relationship** | Complements `chroot-package-managers.test.ts` which tests `go mod download` but on a minimal project |

### 18. `build-test-java.lock.yml` — Build Test Java

| Attribute | Value |
|-----------|-------|
| **What it tests** | Clone test-java repo, configure Maven proxy via `~/.m2/settings.xml`, `mvn compile && mvn test` on gson and caffeine |
| **Runtime** | java 21 |
| **Network** | defaults, github, java |
| **Timeout** | 15 minutes |
| **Real-world mapping** | Validates Maven proxy configuration workaround (Maven ignores JAVA_TOOL_OPTIONS proxy settings) |
| **Gaps** | Only Maven tested. No Gradle testing. Maven proxy config requires manual `settings.xml` — error-prone for users. |
| **Integration test relationship** | Extends `chroot-package-managers.test.ts` which doesn't test Maven dependency download |

### 19. `build-test-node.lock.yml` — Build Test Node.js

| Attribute | Value |
|-----------|-------|
| **What it tests** | Clone test-node repo, `npm install && npm test` on clsx, execa, p-limit |
| **Runtime** | node 20 |
| **Network** | defaults, github, node |
| **Timeout** | 15 minutes |
| **Real-world mapping** | Validates npm registry access through AWF proxy |
| **Gaps** | Only npm tested, no yarn/pnpm. Small packages only. |
| **Integration test relationship** | Complements `chroot-package-managers.test.ts` which tests `npm install` on a minimal package |

### 20. `build-test-rust.lock.yml` — Build Test Rust

| Attribute | Value |
|-----------|-------|
| **What it tests** | Clone test-rust repo, `cargo build && cargo test` on fd and zoxide |
| **Runtime** | rust stable |
| **Network** | defaults, github, rust, crates.io |
| **Timeout** | 30 minutes |
| **Real-world mapping** | Validates crates.io access and Cargo build/test through AWF proxy. Longer timeout for compilation. |
| **Gaps** | Only 2 projects. No nightly Rust testing. |
| **Integration test relationship** | Complements `chroot-package-managers.test.ts` which tests `cargo build` on a minimal project |

---

## Security & Compliance Workflows

### 21. `container-scan.yml` — Container Security Scan

| Attribute | Value |
|-----------|-------|
| **What it tests** | Trivy vulnerability scanning of Agent and Squid container images |
| **Triggers** | Push/PR to main (containers/** paths), weekly Sunday schedule, manual dispatch |
| **Timeout** | 15 minutes per job |
| **Real-world mapping** | Ensures container images don't ship with CRITICAL/HIGH CVEs |
| **Gaps** | Only scans Agent and Squid, not api-proxy or agent-act. |
| **Integration test relationship** | None — security scanning, not functional testing |

### 22. `dependency-audit.yml` — Dependency Vulnerability Audit

| Attribute | Value |
|-----------|-------|
| **What it tests** | `npm audit` on main package and docs-site package. Uploads SARIF to GitHub Security tab. |
| **Triggers** | Push/PR to main (ignoring .md), weekly Monday schedule, manual dispatch |
| **Timeout** | 5 minutes per job |
| **Real-world mapping** | Catches vulnerable npm dependencies before they ship |
| **Gaps** | Only npm, not container base image packages. |
| **Integration test relationship** | None |

### 23. `codeql.yml` — CodeQL Analysis

| Attribute | Value |
|-----------|-------|
| **What it tests** | CodeQL static analysis for JavaScript/TypeScript and GitHub Actions code |
| **Triggers** | Push/PR to main, weekly Monday schedule, manual dispatch |
| **Timeout** | 360 minutes (6 hours) |
| **Real-world mapping** | Catches security vulnerabilities (XSS, injection) and code quality issues |
| **Gaps** | No Shell/Bash analysis (container scripts, iptables rules not analyzed) |
| **Integration test relationship** | None — static analysis |

### 24. `pr-title.yml` — PR Title Check

| Attribute | Value |
|-----------|-------|
| **What it tests** | Semantic PR title format (e.g., `feat:`, `fix:`, `docs:`) using `amannn/action-semantic-pull-request` |
| **Triggers** | PR to main (opened, edited, synchronize, reopened) |
| **Real-world mapping** | Enforces conventional commit format for automated changelog generation |
| **Gaps** | N/A |
| **Integration test relationship** | None |

---

## Infrastructure Workflows

### 25. `release.yml` — Release Pipeline

| Attribute | Value |
|-----------|-------|
| **What it tests** | End-to-end release: version bump, build 4 container images (squid, agent, api-proxy, agent-act), create binaries (linux-x64/arm64, darwin-x64/arm64), generate changelog, create GitHub release |
| **Triggers** | Manual dispatch only (patch/minor/major choice) |
| **Real-world mapping** | Production release pipeline |
| **Gaps** | Binary smoke test only for linux-x64 (arm64 and macOS verified as valid ELF/Mach-O but not executed) |
| **Integration test relationship** | None — infrastructure |

**Container images built:**
- `squid:VERSION` (linux/amd64 + arm64) — with cosign signing and SBOM
- `agent:VERSION` (linux/amd64 + arm64) — with cosign signing and SBOM, no-cache
- `api-proxy:VERSION` (linux/amd64 + arm64) — with cosign signing and SBOM
- `agent-act:VERSION` (linux/amd64 only) — with cosign signing and SBOM (retry logic)

### 26. `deploy-docs.yml` — Deploy Documentation

| Attribute | Value |
|-----------|-------|
| **What it tests** | Builds and deploys docs-site to GitHub Pages |
| **Triggers** | Push to main (docs-site/** paths), manual dispatch |
| **Real-world mapping** | Documentation deployment |
| **Integration test relationship** | None |

### 27. `copilot-setup-steps.yml` — Copilot Setup Steps

| Attribute | Value |
|-----------|-------|
| **What it tests** | Installs gh-aw extension for GitHub Copilot Agent |
| **Triggers** | Manual dispatch, push to workflow file |
| **Real-world mapping** | Configures Copilot Agent environment with gh-aw |
| **Integration test relationship** | None |

---

## Relationship Map: CI vs Integration Tests

| CI Workflow | Related Integration Tests | Overlap Level |
|-------------|--------------------------|---------------|
| `test-chroot.yml` | `chroot-languages.test.ts`, `chroot-package-managers.test.ts`, `chroot-procfs.test.ts`, `chroot-edge-cases.test.ts` | **Direct** — CI runs these exact test files |
| `test-examples.yml` | `blocked-domains.test.ts`, `wildcard-patterns.test.ts` | **Indirect** — examples test similar scenarios (domain allow/block) |
| `test-coverage.yml` | All `src/*.test.ts` unit tests | **Direct** — runs unit test suite with coverage |
| `smoke-chroot.lock.yml` | `chroot-languages.test.ts` | **Overlapping** — both test runtime version matching, different approaches |
| `build-test-*.lock.yml` | `chroot-package-managers.test.ts` | **Complementary** — build-tests use real projects; integration uses minimal packages |
| `smoke-{claude,copilot,codex,gemini}.lock.yml` | None | **Unique** — only place that tests actual AI agents through AWF |
| `test-action.yml` | None | **Unique** — only place that tests the setup action |
| `build.yml` | None | **Prerequisite** — validates build on Node 20+22 |

---

## Coverage Gap Analysis

### What's Well Covered

1. **Chroot functionality** — Tested at 3 levels: unit tests, integration tests, CI workflow, and smoke test
2. **Domain filtering** — Unit tests (domain-patterns), integration tests (blocked-domains, wildcard-patterns), examples
3. **Multi-engine support** — Smoke tests cover Claude, Copilot, Codex, Gemini
4. **Multi-language support** — Build-tests cover 8 languages (Bun, C++, Deno, .NET, Go, Java, Node, Rust)
5. **Container security** — Trivy scans, cosign signing, SBOM attestation

### Gaps Identified

1. **No integration tests run in CI** — The `test-integration.yml` is actually just a type-check. The non-chroot integration tests (blocked-domains, dns-servers, environment-variables, exit-code-propagation, etc.) have no dedicated CI workflow.

2. **No macOS CI testing** — All CI runs on `ubuntu-latest`. AWF produces darwin binaries but never tests them in CI.

3. **No arm64 CI testing** — Containers are built for arm64 in release but never tested on arm64 runners.

4. **Duplicate lint execution** — Both `build.yml` and `lint.yml` run `npm run lint` on PRs.

5. **Missing Python build-test** — Python pip/conda package installation through AWF proxy has no build-test workflow (despite Python being tested in chroot-languages).

6. **Missing Ruby build-test** — Ruby gem installation through AWF proxy has no build-test workflow.

7. **Maven proxy workaround not tested in integration** — The `~/.m2/settings.xml` workaround is only documented in build-test-java.md, not validated by integration tests.

8. **No load/performance testing** — No tests for concurrent connections, large file transfers, or many-domain allowlists.

9. **Smoke test non-determinism** — AI agent behavior varies between runs. A passing smoke test doesn't guarantee the next run passes.

10. **No negative security testing in CI** — Integration tests cover `network-security.test.ts` (iptables bypass attempts), but this isn't run by any CI workflow.

11. **Stale version in test-action.yml** — Tests hardcode `v0.7.0` which may diverge from current release.

12. **No integration test coverage tracking** — `test-coverage.yml` only tracks unit test coverage.

13. **api-proxy container not scanned** — `container-scan.yml` only scans agent and squid images, not the api-proxy image added later.
