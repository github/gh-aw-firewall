# PRD: Implement All Spec-Kit Specs for gh-aw-firewall

## Goal
Work through all valid specs in `.specify/specs/`, implementing each one, testing it, creating a PR, and iterating until the PR is mergeable. Each task corresponds to one spec.

## Workflow Per Task
1. Read the spec file in `.specify/specs/NNN-title/spec.md`
2. Create a new branch from `main`: `fix/NNN-short-title` or `feat/NNN-short-title`
3. Implement the changes described in the spec
4. Run `npm run build && npm test && npm run lint` to verify
5. Commit changes with conventional commit message (e.g., `fix: description` or `feat: description`)
6. Create a PR referencing the GitHub issue mentioned in the spec
7. Check CI status with `gh pr checks`. If CI fails, fix and push
8. Check for review comments with `gh pr view --comments`. Address any feedback
9. Iterate until PR is green and approved
10. Mark the task as done below

## Important Notes
- Always branch from `main`, not from the current branch
- Run `npm run build && npm test` before creating PRs
- Reference the GitHub issue number in the PR body (e.g., "Fixes #NUMBER")
- Do NOT push to `main` directly - always use PRs
- After compiling any workflow `.md` files, run: `npx tsx scripts/ci/postprocess-smoke-workflows.ts`
- Keep changes minimal and focused on what the spec describes

## Tasks (Ordered by Priority)

### Quick Wins - Security (Low complexity, High impact)
- [x] **002**: Fix minimatch ReDoS vulnerability - `npm audit fix` (Spec: `.specify/specs/002-minimatch-redos-vuln/spec.md`, Issue: #1147)
- [ ] **097**: Disable IPv6 when ip6tables unavailable (Spec: `.specify/specs/097-ipv6-disable-fallback/spec.md`, Issue: #245)
- [ ] **095**: Run Squid container as non-root user (Spec: `.specify/specs/095-squid-non-root/spec.md`, Issue: #250)
- [ ] **096**: SSL Bump key secure wiping via tmpfs (Spec: `.specify/specs/096-ssl-bump-key-security/spec.md`, Issue: #247)
- [ ] **054**: Stop logging partial token values (Spec: `.specify/specs/054-token-logging-leak/spec.md`, Issue: #758)
- [ ] **037**: Fix TOCTOU race conditions in ssl-bump.ts (Spec: `.specify/specs/037-toctou-ssl-bump/spec.md`, Issue: #838)
- [ ] **104**: Fix direct IP+TLS bypass of domain filtering (Spec: `.specify/specs/104-ip-tls-bypass/spec.md`, Issue: #137)

### Quick Wins - Testing (Low complexity)
- [ ] **038**: Add TOCTOU test coverage (Spec: `.specify/specs/038-toctou-test-coverage/spec.md`, Issue: #837)
- [ ] **042**: Add chroot escape test coverage (Spec: `.specify/specs/042-chroot-escape-test-gaps/spec.md`, Issue: #762)
- [ ] **052**: Expand credential hiding tests to all 14 paths (Spec: `.specify/specs/052-credential-hiding-tests/spec.md`, Issue: #761)
- [ ] **053**: Add workDir tmpfs hiding test (Spec: `.specify/specs/053-workdir-tmpfs-test/spec.md`, Issue: #759)
- [ ] **069**: Add --proxy-logs-dir tests (Spec: `.specify/specs/069-proxy-logs-dir-tests/spec.md`, Issue: #499)
- [ ] **070**: Add --allow-host-ports validation tests (Spec: `.specify/specs/070-allow-host-ports-tests/spec.md`, Issue: #498)
- [ ] **071**: Add --skip-pull integration test (Spec: `.specify/specs/071-skip-pull-integration-test/spec.md`, Issue: #497)
- [ ] **100**: Add logger/aggregator tests (Spec: `.specify/specs/100-logger-tests/spec.md`, Issue: #100)

### Quick Wins - Documentation & DX
- [ ] **039**: Sync version references and missing CLI flags in docs (Spec: `.specify/specs/039-docs-sync-versions/spec.md`, Issue: #836)
- [ ] **066**: Clarify --image-tag behavior with presets (Spec: `.specify/specs/066-image-tag-preset-docs/spec.md`, Issue: #502)
- [ ] **067**: Add short flags (-d, -b, -k) (Spec: `.specify/specs/067-short-flags/spec.md`, Issue: #501)
- [ ] **072**: Document flag validation constraints (Spec: `.specify/specs/072-doc-flag-validation/spec.md`, Issue: #496)

### Medium Complexity - Bugs
- [ ] **012**: Fix Copilot CLI v0.0.411 404 download (Spec: `.specify/specs/012-copilot-cli-404/spec.md`, Issue: #1119)
- [ ] **013**: Fix integration test failures (4 categories) (Spec: `.specify/specs/013-integration-test-failures/spec.md`, Issue: #1102)
- [ ] **023**: Fix LD_PRELOAD breaking Deno scoped permissions (Spec: `.specify/specs/023-ld-preload-deno-conflict/spec.md`, Issue: #1001)
- [ ] **024**: Fix Yarn SSL/network errors through Squid proxy (Spec: `.specify/specs/024-yarn-ssl-squid-proxy/spec.md`, Issue: #949)
- [ ] **034**: Verify capsh execution chain after PR #715 (Spec: `.specify/specs/034-capsh-bash-wrapping/spec.md`, Issue: #842)
- [ ] **035**: Collect agent output on execution failure (Spec: `.specify/specs/035-collect-agent-output-failure/spec.md`, Issue: #840)

### Medium Complexity - Features
- [ ] **025**: Configurable agent timeout (Spec: `.specify/specs/025-agent-timeout-large-projects/spec.md`, Issue: #948)
- [ ] **068**: Improve help text organization (Spec: `.specify/specs/068-help-text-organization/spec.md`, Issue: #500)
- [ ] **092**: Configurable memory limit with --memory-limit flag (Spec: `.specify/specs/092-memory-limit-config/spec.md`, Issue: #310)
- [ ] **103**: Predownload images command (Spec: `.specify/specs/103-predownload-images/spec.md`, Issue: #193)
- [ ] **116**: Add --no-dind flag to disallow DinD (Spec: `.specify/specs/116-disallow-dind-mode/spec.md`, Issue: #116)

### Medium Complexity - Security
- [ ] **055**: Fix secure_getenv() bypass for one-shot token (Spec: `.specify/specs/055-secure-getenv-bypass/spec.md`, Issue: #756)
- [ ] **011**: Simplify security model - reject non-localhost IP (Spec: `.specify/specs/011-simplify-security-model/spec.md`, Issue: #11)

### Medium Complexity - CI/Infrastructure
- [ ] **036**: Cherry-pick API proxy fixes to sidecar branch (Spec: `.specify/specs/036-api-proxy-sidecar-cherry-pick/spec.md`, Issue: #839)
- [ ] **082**: CI quality gates - markdown linting, link checking, CODEOWNERS (Spec: `.specify/specs/082-ci-quality-gates/spec.md`, Issues: #348,#352,#353,#350)
- [ ] **083**: Performance monitoring workflow (Spec: `.specify/specs/083-performance-monitoring/spec.md`, Issue: #337)
- [ ] **085**: Agentic maturity Level 4 (Spec: `.specify/specs/085-agentic-maturity-level4/spec.md`, Issues: #332,#313)
- [ ] **102**: Documentation preview environment for PRs (Spec: `.specify/specs/102-docs-preview/spec.md`, Issue: #235)

### High Complexity
- [ ] **062**: Restrict /proc/self/environ and docker-compose.yml secret exposure (Spec: `.specify/specs/062-proc-environ-secret-exposure/spec.md`, Issue: #620)
- [ ] **064**: Fix chroot binary interception (Java, Rust, Bun) (Spec: `.specify/specs/064-chroot-binary-interception/spec.md`, Issue: #518)
- [ ] **073**: Propagate host.docker.internal DNS to spawned containers (Spec: `.specify/specs/073-host-docker-internal-dns/spec.md`, Issue: #422)
- [ ] **074**: Mount host filesystem as read-only (Spec: `.specify/specs/074-readonly-host-mount/spec.md`, Issue: #420)
- [ ] **075**: Init container for iptables separation (Spec: `.specify/specs/075-init-container-iptables/spec.md`, Issue: #375)
- [ ] **084**: Seccomp deny-by-default hardening (Spec: `.specify/specs/084-seccomp-hardening/spec.md`, Issue: #311)
- [ ] **093**: Content inspection DLP (Spec: `.specify/specs/093-content-inspection-dlp/spec.md`, Issue: #308)
- [ ] **094**: DNS-over-HTTPS support (Spec: `.specify/specs/094-dns-over-https/spec.md`, Issue: #307)
- [ ] **098**: Performance benchmarking suite (Spec: `.specify/specs/098-performance-benchmarking/spec.md`, Issue: #240)
- [ ] **105**: YAML rule configuration (Spec: `.specify/specs/105-yaml-rules/spec.md`, Issue: #136)
- [ ] **106**: Child container NAT rule inheritance (Spec: `.specify/specs/106-child-container-nat/spec.md`, Issue: #130)

## Excluded Specs (Do NOT work on these)
- **022**: Duplicate of 002 (minimatch ReDoS)
- **032**: Misfiled - belongs in gh-aw repo, not gh-aw-firewall
- **033**: Already resolved in main (Java proxy config)
- **063**: Already resolved in main (Smoke chroot permissions)

## Success Criteria
1. All tasks above are checked off
2. Each task has a PR created
3. All PRs pass CI
4. No regressions in existing tests
