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

### Unified enclave coverage

Cloud Hypervisor enclave contract coverage runs in
`.github/workflows/test-cloud-hypervisor-enclaves.yml`. Its ordinary CI job uses
the authenticated broker/host boundary with a mock VM manager; its explicitly
opted-in GitHub-hosted Ubuntu x86_64 KVM job exercises real host storage,
nftables packets, and supervisor limit probes. A separate, false-by-default
`live-kvm` gate invokes both static executors through the public broker route
using package-matched release-attested artifacts and the production storage
provider. It is manually dispatched with `run_live_kvm: true` to avoid exposing
the Copilot credential to untrusted pull-request code. It checks canonical
bounded results, script guest identity and limits, and synthetic-output
redaction. The live gate has not passed until it runs on an eligible
GitHub-hosted Ubuntu x86_64 KVM/cgroup-v2 runner. Live dispatch must check out
an exact published release tag containing the explicitly pinned reviewed
acceptance commit, not `main`. The tag-only release version bump intentionally
leaves `main` at `0.23.1`; substituting newer artifacts for that package is not
allowed. A future authorized release containing this harness is required.
A separate false-by-default `run_environment_probe` dispatch runs only the
script-only public environment probe through the same release-attested public
MCP route, without an agent executor, API proxy, or Copilot secret; see
[the probe dispatch](cloud-hypervisor-foundation.md#public-enclave-environment-probe-dispatch).
The live job also runs scripts/ci-only startup-failure probes for both roles
after real VM creation and boot, using the production host executor service,
authenticated broker protocol v2 client, storage provider, and VM manager.
Host closures force the errors only after capturing allocated resource
identities; cleanup and rejection of replay must succeed. Those probes do not
invoke the public MCP route or execute a workload, unlike the other live
assertions. Their deterministic transport tests are not KVM evidence.
Before broker readiness, an AWF exit, signal, spawn failure, or readiness
timeout emits one `AWF_HOST_STARTUP_DIAGNOSTIC` JSON line to the job log before
fixture cleanup. Legacy schema version 1 contains only `phase` (`pre-broker`),
`stage` (`initial` or `recovery`), a fixed `reason` and `category`, bounded
`exitCode`, allowlisted `signal`, and `logInspection` (`structured`, `bounded`,
or `unavailable`). Categories cover exact known configuration, host-preflight,
artifact, container-runtime, host-service, broker, recovery-state, and
unsupported-host errors; unmatched errors are explicitly `unknown`, not an
inferred root cause. The harness first uses the existing host startup record,
then falls back to the first fatal stderr header for older/interrupted starts.
Legacy lines remain at most 256 bytes. Schema version 2 uses `host-startup`
and adds a validated `enclaveStartup` snapshot from AWF itself (not a harness
probe). Its perspective is always `awf-host`; startup stages distinguish host
bootstrap, configuration, runtime/host/storage/artifact preflight, seed staging,
recovery, host service, container bring-up, gateway attachment, optional GitHub
readiness, and the actual `initialize`, initialized notification, and `tools/list`
requests. `readiness` is explicitly `not-attempted`, `attempted`, or `ready`.
Missing/unvalidated observations remain unknown, never inferred as not attempted.
Only allowlisted transport/protocol codes, initialization attempt count
(saturated at 1200), and HTTP error status (100–599 or null) are exported.
Categories distinguish `dns`, `connectivity`, `gateway-auth`,
`gateway-protocol`, `gateway-readiness`, `other`, and `unknown`.
The schema-2 diagnostic line without subchecks is bounded to 640 bytes.
An optional schema-1 `hostPreflight` snapshot contains the current shared,
fixed check plan, with `not-attempted` / `not-required` / `attempted` /
`passed` / `failed` results and only
allowlisted reasons. It records actual gate outcomes, including trusted tool
ownership/traversal/access, pinned versions, bounded mounts, KVM, capabilities,
cgroups, and Docker/Compose; it does not infer success for unexecuted checks.
Lines including only an active subcheck plan are bounded to 8192 bytes.
The always-on `startupChecks` schema-1 cumulative checklist also retains
earlier scopes as `scope/check-id: [result, reason]` and distinguishes
complete hosting readiness from a gateway handshake alone. Lines including
the cumulative checklist remain within 16 KiB, as do compact persisted
records including the fatal message; the descriptor read limit is unchanged.
Failed gates select the
`host-preflight` category without interpreting their raw errors. Unknown
errors remain explicit `unknown` reasons. See the
[standard checklist and scope definitions](cloud-hypervisor-foundation.md#standard-enclave-startup-checklist).
The privileged host-probes job also runs the production read-only admission
method under sudo, emitting `AWF_HOST_PREFLIGHT_PROBE` with perspective
`preflight-harness`, never `awf-host` or guest success.
Spawn failures never
consult possibly stale logs. A request timeout includes DNS/TCP/response time
and does not prove a particular TCP failure. Retryable backend-unavailable
responses remain distinct from readiness-deadline exhaustion.
It never prints stdout, stderr, record messages, paths, timestamps, causes,
or subprocess error objects. Descriptor-based, no-follow, regular-file reads
are limited to 16 KiB for the record and 64 KiB for stderr; changed or unsafe
files cannot produce a classification. Each launch resets its private logs.
AWF reuses its existing startup-error record inside the fixture's root-private
0700 directories; there is no new network or agent-facing diagnostic channel.
Progress records have phase `enclave-startup-progress` and a fixed message;
fatal records retain phase `startup`. Oversized serialized fatal messages are
replaced with a fixed message so they cannot hide the bounded snapshot (1024
serialized message bytes when subchecks are present; 8192 otherwise).
Publication validates descriptor ownership, single-link regular-file metadata,
and no-follow opening before truncation. Existing log readers ignore progress
records rather than presenting them as failures.
After broker health, both initial and recovery launches additionally wait for
AWF's successful host handshake before making the harness's own MCP requests.
For checklist-aware releases every required startup/storage/connectivity
check must pass before primary-agent startup and before
`AWF_HOST_GATEWAY_READINESS` is emitted with the same safe snapshot.
Broker health and a successful harness request are not proof of AWF readiness.
AWF stdout/stderr and startup error records are removed even when cleanup
requires retaining private recovery state; no raw artifacts are uploaded.
Cleanup failures remain failures and do not replace the primary startup error.
Deterministic regressions cover the output shape and bounds, secrets and
repository sentinels, malformed/unknown input, unsafe/changing files, each
failure reason, and bounded cleanup. These diagnostics do not establish that
an agent or workload ran and do not fix an unidentified startup cause. The
immutable `v0.28.36` release cannot receive this change; release-pinned live
acceptance needs a future authorized release containing it.
Privileged enclave probes no longer run in the ordinary artifact-build job.
Production full-storage admission is enabled only after supported-host and
release-artifact preflight; invocation exports, artifact/rootfs copies, and
manager state share the trusted allocation domain and recovery contract. See
the [enclave conformance evidence and remaining live
gate](cloud-hypervisor-foundation.md#enclave-conformance-evidence-and-remaining-live-gate)
for exact blockers and the mandatory, still-unverified live acceptance
criteria.

Legacy bounded smoke and runtime-matrix assets were removed from the owned
workflow surface. Beyond the new static-executor live gate, coverage for
enclave MCP server and executor contracts remains local/unit-focused:

- `src/services/enclave-mcp-service.test.ts`
- `src/services/enclave-agent-service.test.ts`
- `src/enclave/script-runner-spec.test.ts`
- `src/enclave/agent-runner-spec.test.ts`
- `src/enclave/manager.test.ts`
- `src/enclave/mcp-server.test.ts`
- `src/enclave/agent-mcp-server.test.ts`

These cover the shared tool contract, gVisor routing assumptions, fail-closed `sbx` behavior, and the mcpg-only topology.

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

## Cloud Hypervisor preview integration tests

The Cloud Hypervisor backend has its own separate CI workflow
(`test-cloud-hypervisor.yml`), scoped to Cloud Hypervisor paths and
**GitHub-hosted Ubuntu x86_64 runners only**. Self-hosted runners are explicitly
rejected.

**Trigger:** `workflow_dispatch`, or pull request open/synchronize/reopen/label
scoped to `guest/cloud-hypervisor/**`, `src/cloud-hypervisor/**`,
`src/microvm/**`, and the related scripts/docs/workflow files. Only label
`cloud-hypervisor-kvm` enables the live job. It does **not** run on push or
schedule.

**Build job** (`ubuntu-24.04`): Builds deterministic guest artifacts — Cloud
Hypervisor v53.0 binary, the pinned Linux 6.1.141 kernel config, BusyBox 1.36.1
rootfs, and the shared AWF guest supervisor —
from pinned, SHA-256 verified sources. Attests provenance. Uploads as a
7-day workflow artifact (`cloud-hypervisor-test-x86_64`).

**Live job** (`ubuntu-24.04`): Downloads the build artifact, verifies all four
SHA-256 digests plus GitHub-hosted-only host eligibility (`GITHUB_ACTIONS`,
`RUNNER_ENVIRONMENT`, `ImageOS`) and Landlock LSM availability, then runs the
live smoke/security suite. The preflight requires usable KVM and fails closed
if `/dev/kvm` or another required host capability is unavailable.

Live assertions (see `scripts/ci/cloud-hypervisor-live-smoke.sh`) cover the
following behavior:

| Case | What it proves |
|------|---------------|
| `allowed-https` | Allowed domains reach the internet through Squid |
| `blocked-domain` | Non-allowlisted domains are blocked |
| `direct-egress` | Bypassing proxy env vars does not enable direct egress |
| `arbitrary-tcp` | Raw TCP to arbitrary IPs is blocked |
| `dns-denial` | Direct DNS (8.8.8.8:53) is blocked from the guest |
| `metadata-denial` | Instance metadata IP (`169.254.169.254`) is unreachable |
| `api-proxy-reflect` | API proxy `/reflect` reachable; secret sentinel not in output |
| `workspace-copyback` | Guest file writes, permission changes, and symlinks survive copy-back |
| `exit-code` | Agent exit code propagates faithfully (37 → 37) |
| `timeout-124` | Timed-out agent exits 124 |
| `device-assumptions` **(CH-only)** | `/dev/vda`/`/dev/vdb` and `eth0` guest device assumptions hold |
| `partial-start-cleanup` | Corrupt rootfs causes clean failure; no residue |
| `cancellation` | `SIGTERM` cleans up residue within a non-flaky time ceiling; exits 143 |
| `keep` | `--keep-containers` preserves namespace/run-directory; diagnostics ≤1 MiB |
| `security-assertions` **(CH-only)** | Live jailer-replacement boundary: non-root uid, empty `CapInh`/`CapPrm`/`CapEff`/`CapBnd`/`CapAmb`, `no_new_privs`, active seccomp filter, per-run cgroup membership/bounded memory, `landlock_enable` + exactly-minimal disk/net/vsock topology via `vm.info` |

After every case, the suite asserts no `awfvm-*` namespaces,
`vmh*`/`vmn*`/`vmt*` interfaces, `awf-cloud-hypervisor` cgroup entries, or
`cloud-hypervisor` processes remain. The suite also scans output for the secret
sentinel (`awf-cloud-hypervisor-real-secret-do-not-expose`). See
[Cloud Hypervisor integration (preview)](../docs/cloud-hypervisor-foundation.md#part-14--ci-workflow)
for the full CI workflow specification.
