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

### CI image retrieval

The chroot, examples, deterministic Cloud Hypervisor guest build, and supply-chain
jobs configure the GitHub-hosted Linux runner's Docker daemon with Google's
[Docker Hub cache](https://cloud.google.com/artifact-registry/docs/pull-cached-dockerhub-images)
before starting containers. This covers ordinary and nested `docker build`
commands without rewriting production Dockerfiles or digest pins. A cache miss
still falls back to Docker Hub and can fail under upstream rate limits; retrieval
errors are not skipped.

The supply-chain job pulls its pinned scanners once before compilation. Syft
retains the compiler's exact Docker Hub reference (served through the daemon
cache); Grype and Grant use Anchore's GHCR distribution at the same reviewed
digests. Scan targets, vulnerability database updates, and the blocking
High/Critical PR-image gate are unchanged. The setup script validates the merged
daemon configuration before restart and refuses local or self-hosted runners.

For PR-image scans only, the runner opts into Docker's containerd image store
before pulling images, then uses Buildx's `docker` driver with `--load`. Each
image imports/exports a separate GitHub Actions v2 build cache (`mode=max`),
scoped by image and UTC date. Only the current day's scope is imported: the first
build each UTC day reruns package installation and security upgrades, rather than
indefinitely reusing stale apt/apk layers. Within that day, fresh hosted runners
can reuse the layers subject to normal Actions cache visibility/eviction.
Cache export failures remain build failures, not silently ignored warnings.

The shared build-tools image remains in the local daemon until enclave-agent
finishes; that dependent build does not pull a replacement base. Intermediate
builder cache is pruned after each export, and scanned image archives/images are
removed sequentially to bound disk use. Build-tools retains Ubuntu's default
archive/security mirrors instead of selecting Azure based on DNS alone. Apt
retries transient fetch failures, treats incomplete index updates as errors, and
still upgrades every installed package.

After Grype's DB warm-up, the job restores ownership and owner read/write/traverse
permissions to the runner user before `actions/cache/save` archives the DB.
Warm-up and permission-repair failures stop the job. The
`scripts/ci/docker-registry-ci.test.ts` and
`scripts/ci/apt-mirror-dockerfiles.test.ts` fixtures cover these cache, freshness,
mirror, scan-failure, base-image lifetime, and cleanup contracts; they do not
replace a Linux Docker/hosted-runner build.

All five chroot job definitions (including both browser runner variants) use
`.github/actions/build-chroot-images` to build the checkout's Squid and agent,
plus API proxy for browser tests, with the exact existing `:latest` local tags.
The composite action uses the same Docker-driver/containerd-store and daily
GitHub Actions v2 cache policy. Its scopes are separate by image, job, runner
variant, and architecture to avoid concurrent matrix writers colliding; no
previous-day scopes are imported. It verifies loaded images and prunes only
intermediate build cache after export, keeping the images needed by tests.
Build, cache export, inspection, and pruning errors fail preparation rather than
running tests against incomplete images. Existing suites, runner matrix, cleanup,
network isolation, and job/test timeout limits are unchanged.

The agent's token-compiler and runtime stages now retain their base image's apt
mirrors rather than selecting Azure via DNS; all Ubuntu stages reject partial
index updates, retain fetch retries, and preserve required packages and runtime
security upgrades. The oldest-runner browser payload and native t64 dependency
resolution are unchanged. `scripts/ci/chroot-image-cache.test.ts` exercises the
shared builder with Docker test doubles; actual Linux chroot execution remains
the responsibility of the integration jobs. Grype is not used by these jobs.

### NVX harness-observation limitation

NVX currently launches the configured command through one atomic
`NvxManager.execute()` lifecycle. It does not expose a persistent ready guest or
a selected-harness probe/pre-command release interface, so NVX harness
observations remain `runtime_probe_unsupported`. The existing manager tests and
live evidence runner validate NVX execution and result/cleanup behavior only;
they do not establish selected-harness evidence or guest compatibility for a
probe lifecycle.

**Current live acceptance status:** blocked, not live-accepted. A provider-free
NVX guest acceptance run requires signed OpenVMM/kernel/initramfs/manifest
artifacts, a distro layer, and host tooling including Bubblewrap and
`mkfs.erofs`, in addition to a supported Linux x86_64/KVM runner. The recorded
prerequisite attempt had no signed runtime bundle or distro layer and lacked
Bubblewrap and `mkfs.erofs`. Deterministic fixtures are not a substitute for
that guest evidence. No NVX harness-observation producer or live acceptance is
claimed.

### Provider-free Docker harness observations

`.github/workflows/test-docker-harness-observation.yml` automatically runs two
bounded jobs on GitHub-hosted Ubuntu 24.04 for relevant pull requests and pushes
to `main`: native Docker agent execution and split-filesystem Docker-in-Docker.
The latter uses separate Debian runner and Alpine Docker-daemon containers,
stages runner system binaries under daemon-only `/runner`, and shares temporary
files at runner `/tmp` versus daemon `/runner/tmp`. A live negative bind probe
must reject the untranslated runner path before the translated mount succeeds.
This tests the split-filesystem topology used by ARC/DinD; it is **not a
Kubernetes or ARC deployment test**. The older ARC volume/log fixture that shares
the same filesystem is not a substitute for this evidence.

Both jobs build the production agent image and TypeScript from the tested
checkout. `scripts/ci/live-docker-harness.cjs` uses the real agent-service builder,
image entrypoint, chroot, capability/identity/trust setup, container-local tmpfs,
Docker-exec observation transport, atomic report publisher and release gate.
It supplies narrowly scoped fixture mounts and uses `network_mode: none` in place
of Squid/provider services. This is a focused producer/lifecycle integration,
not an end-to-end CLI, Squid, iptables-init, provider inference or enclave test.
No provider request or real credential is needed.

Direct fixture executables named `copilot`, `claude` and `codex` exercise bounded
version output and ordinary command stdout/stderr/exit. Checks compare UID/GID,
cwd, PATH, home/user, controlled exported environment, BASH_ENV startup effects
and login-shell state between probe and command. The existing final command shell
is non-login in these fixtures; the test does not enable a new login-shell mode.
The exact expected PATH includes the entrypoint's npm-global prefix. The pinned
fixture reapplies its shell hash after PATH setup and makes the competing PATH
executable exit 99, so successful probing and command exit 23 prove the pin wins.
Cases cover publication before release, missing/malformed/overflow/failed/timeout
observations, unchanged unconstrained admission, test-only incompatible and
unverified evaluator requirements withholding release, shell-pinned resolution,
unverified shell functions, wrong-run transport, cancellation, early startup exit
and ownership-checked container removal. The blocking cases invoke the real
`runMainWorkflow`/`observeHarness` admission recheck with live Docker lifecycle
adapters, injecting a floor only at the test process's model-validator module
boundary (as in the existing deterministic tests). They verify neither release
nor command wait is reached. This does not install production constraints or add
a configuration bypass. Bundled harness constraints remain empty and configured
catalogue harness facts remain rejected.

A separate networkless container uses the real proxy report reader on a
read-only mount to check root ownership, writable-file/symlink rejection,
stale-run binding and immutable evidence across atomic replacement. A
no-binding reader must not infer primary evidence. Existing deterministic
service-builder checks additionally verify dedicated enclave proxies receive no
primary harness environment; no enclave producer is added or claimed.

For native reproduction on a disposable Linux Docker host with `libcap2-bin`:

```bash
npm ci
npm run build
docker build --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  -t awf-harness-agent:local containers/agent
sudo env "PATH=$PATH" "AWF_LIVE_COMMIT=$(git rev-parse HEAD)" \
  timeout --kill-after=20s 420s node scripts/ci/live-docker-harness.cjs
```

The split job additionally builds `Dockerfile.runner` and invokes
`scripts/ci/live-docker-harness-split.sh`; its privileged outer-daemon launcher
refuses non-GitHub-hosted environments. Cleanup removes only the generated
Compose project's resources and label-verified test-owned containers, never
prunes the shared daemon. An existing `awf-agent` causes a preflight failure
rather than being removed. Per-container memory/PID/CPU limits, subprocess and
job deadlines, and signal cleanup bound execution.

Uploaded `harness-live-native` and `harness-live-split-dind` JSON artifacts contain
the tested commit, actual agent image ID, Docker/Node/platform identification,
sanitized canonical reports, per-case outcomes and cleanup status. They exclude
raw version metadata, full environment, credentials, Compose dumps and container
logs. On failure, a bounded diagnostic records container state, numeric probe
exit status, context-file presence and allowlisted entrypoint error classes,
never raw stderr or environment values. `harness-deterministic` is a separately named Jest fixture artifact, **not
live proof**. Deterministic workflow/fixture regressions run with:

```bash
npx jest --runInBand --runTestsByPath scripts/ci/live-docker-harness-workflow.test.ts
```

Live acceptance is established only by successful jobs and their artifacts for
the exact tested commit; local deterministic results or an unavailable Docker
daemon must not be reported as live acceptance.

### Unified enclave coverage

Cloud Hypervisor enclave contract coverage runs in
`.github/workflows/test-cloud-hypervisor-enclaves.yml`. Its ordinary CI job uses
the authenticated broker/host boundary with a mock VM manager; its explicitly
opted-in GitHub-hosted Ubuntu x86_64 KVM job exercises real host storage,
nftables packets, and supervisor limit probes. A separate, false-by-default
`live-kvm` gate invokes both static executors through the public broker route
using package-matched release-attested artifacts and the production storage
provider. Supported releases authorize automatic `workflow_dispatch` of the
full conformance workflow, including `run_live_kvm: true`; no human dispatch is
required after a successful supported release. The live gate is not run on
pull-request events, avoiding exposure of the Copilot credential to untrusted
pull-request code. Ad hoc diagnosis or recovery dispatches require separate
maintainer authorization. It checks canonical bounded results, script guest
identity and limits, and synthetic-output redaction. The live gate has not
passed until it runs successfully on an eligible GitHub-hosted Ubuntu x86_64
KVM/cgroup-v2 runner. Live dispatch must check out an exact published release
tag containing the explicitly pinned reviewed acceptance commit, not `main`.
The tag-only release version bump intentionally
leaves `main` at `0.23.1`; substituting newer artifacts for that package is not
allowed. A future authorized release containing this harness is required.
Acceptance evidence must identify each exercised profile (primary agent,
script-only enclave, agent-only enclave, and combined enclaves), the shared
base-image lineage, and the final enclave rootfs digest for both enclave roles.
Host probes and deterministic mock-manager tests do not establish guest
acceptance. A branch-host/release-guest smoke failure, including the observed
HTTP 403, is not proof of a newly published unified guest artifact or of a
particular local-versus-upstream proxy rejection.
A separate false-by-default `run_environment_probe` dispatch runs only the
script-only public environment probe through the same release-attested public
MCP route, without an agent executor, API proxy, or Copilot secret; see
[the probe dispatch](cloud-hypervisor-foundation.md#public-enclave-environment-probe-dispatch).
The public gateway fixture preserves the MCP server's empty HTTP 202
acknowledgment for JSON-RPC notifications, including `notifications/initialized`
and cancellation. It still requires bounded JSON responses for requests with
an ID and rejects malformed, truncated, or oversized backend responses.
Deterministic fixture tests cover this distinction: release v0.28.70's probe
and live acceptance both passed `initialize` but failed the initialized
notification because the fixture tried to parse its empty acknowledgment as
JSON and returned HTTP 502. This fixture regression does not establish a guest
or provider failure, and its mocked fix does not prove live KVM acceptance.
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
An optional versioned `hostPreflight` snapshot contains the current shared,
fixed check plan, with `not-attempted` / `not-required` / `attempted` /
`passed` / `failed` results and only
allowlisted reasons. It records actual gate outcomes, including trusted tool
ownership/traversal/access, pinned versions, bounded mounts, KVM, capabilities,
cgroups, and Docker/Compose; it does not infer success for unexecuted checks.
Schema 2 also identifies the profile and lifecycle phase; schema 1 remains
readable for previously published evidence.
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

## Daily agent/runtime regression matrix

`daily-agent-runtime-regression.yml` runs daily at 06:37 UTC and supports manual
dispatch. It exercises Copilot, Codex, and Claude under Docker, Cloud Hypervisor,
and NVX in nine independent primary-agent jobs, plus all three agents **inside**
Docker and Cloud Hypervisor agent enclaves in six more jobs. Both matrices have
fail-fast disabled. Manual dispatch must use the `main` workflow ref.

The shared build checks out `main`, records its exact commit, and builds the AWF
CLI, Squid, agent, API proxy, and three enclave images once. Every regression job checks out that
same commit, verifies and restores the run-scoped CLI/image artifacts, and uses
commit-tagged local images with `--skip-pull`; no job substitutes a released AWF
binary or GHCR image. Cloud Hypervisor guest artifacts (including source-built
AWF build-tools and supervisor) and the NVX guest distro are also prepared once
per run. NVX retains its pinned upstream artifacts and requires a manifest
attested by this exact workflow, explicitly selected as the expected signer.
The production default signer remains the release workflow.

The six enclave jobs reuse `agent-runtime-awf-build` and
`agent-runtime-cloud-hypervisor`, including the same enclave source images used
to construct the shared guest rootfs. They do not rebuild or pull replacement
images. The source-built CLI has a build-time-only, full-main-SHA Cloud
Hypervisor compatibility profile, and this workflow attests both microVM
manifests and the shared enclave rootfs; unsigned enclave artifacts remain
forbidden.

Each enclave cell invokes the selected native coding agent through the existing
public enclave MCP route. A minimal Docker primary keeps that route alive; the
coding agent itself runs in the selected single-use enclave, not the primary.
The agent must use its shell tool to read the public repository seed, prove
read-only mounts, credential isolation, non-root/no-capability execution and
network confinement, then write the exact finite-schema result to `/awf/out`.
The host requires one successful audited invocation and the matching unique proof.

Enclave fixtures use `github/gh-aw-firewall` with **`public` sensitivity** and
`enclaveDebugPublic: true`. AWF still independently verifies unauthenticated
public visibility. On success or failure, the existing host-only collector
publishes bounded, secret-redacted enclave/session/proxy diagnostics with
one-day retention. Private working state, provider credentials, raw AWF host
logs and gateway capabilities are never uploaded.

Each cell checks allowed and denied HTTPS access, credential isolation, real
provider inference through the API proxy, and an agent tool writing a unique
proof file through the live workspace share. Missing credentials, nonzero exits,
missing proof files, and incorrect model responses fail the job rather than
merely producing a FAIL summary. Evidence artifacts identify the tested source
commit and retain logs for seven days. A failed VM artifact build does not
suppress Docker jobs or the other VM runtime's jobs.

Required credentials follow the existing smoke workflows: Copilot uses
`COPILOT_GITHUB_TOKEN` or the job token with `copilot-requests: write`; Codex uses
`CODEX_API_KEY` or `OPENAI_API_KEY`; Claude uses `ANTHROPIC_API_KEY`. Agent CLI
versions are pinned in the workflow, except enclave Copilot, which retains the
sealed `containers/enclave/package-lock.json` pin. The existing engine-specific smoke
workflows remain available for focused PR/label-triggered checks.

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

## NVX preview integration tests

The NVX backend has an opt-in live-KVM workflow
(`nvx-phase-3b-live-kvm.yml`) plus separate Copilot and build-test smoke
workflows. The live job validates the production `NvxManager` path with the
pinned, workflow-attested NVX artifacts on GitHub-hosted Ubuntu x86_64 KVM
runners.

Live assertions cover guest boot, exact OpenVMM capability/seccomp
confinement, immediate bidirectional workspace visibility, workload-owned host
files, selective workspace writes, an independent read-only tool-cache share,
directory creation/rename/deletion, chmod, symlinks, network denial, Copilot
API-proxy inference, timeout, cancellation, stale recovery, concurrent-run
isolation, and residue-free cleanup. Focused tests additionally reject
symlinked policy paths, nested mounts, overlapping or bind-aliased share roots,
and hard links crossing write or read-denial boundaries.

`smoke-nvx-build-test.md` exercises `npm ci`, TypeScript compilation, Jest, Go
builds, and Go tests while writing results through the live workspace share.
`smoke-nvx-copilot.md` runs a real Copilot agent and verifies that its workspace
write is immediately visible to the host.
