# AWF Diagnosis Registry

This directory is the **canonical, versioned home of AWF diagnosis knowledge**.
Every diagnosis producer (agents, skills, maintenance workflows) reads from and
proposes changes to the records here through the same primitives.

Start here when you have an AWF error, a failing run URL, or a symptom.

## Contents

| File | Purpose |
|---|---|
| [`schema.json`](./schema.json) | Validated schema for a single finding record |
| [`findings/`](./findings) | Canonical machine-readable records, grouped by boundary |
| [`patterns.md`](./patterns.md) | The observe → classify → verify → propose → review → publish protocol |
| [`agent-playbook.md`](./agent-playbook.md) | Authored diagnosis procedure (never generated) |

Generated consumers (do not edit by hand — run `npm run diagnostics:render`):

- `.github/workflows/shared/diagnosis-findings.md` — gh-aw runtime-importable catalog
- `.github/agents/diagnose-awf.md` — portable agent artifact for use without a clone
- the index section of this README

## Routing by boundary

| Boundary | Use when | Specialist references |
|---|---|---|
| `runner` | ARC/DinD, self-hosted, GHES/GHEC runner and daemon problems | [`self-hosted-failure-modes.md`](../../.github/workflows/shared/self-hosted-failure-modes.md), [`docs/arc-dind.md`](../arc-dind.md) |
| `runtime` | Container runtime, chroot, gVisor/Kata, Cloud Hypervisor and enclave startup/storage/cleanup | [`docs/gvisor-integration.md`](../gvisor-integration.md), [`docs/cloud-hypervisor-foundation.md`](../cloud-hypervisor-foundation.md), [`docs/compatibility.md`](../compatibility.md) |
| `network` | Squid denials, DNS, egress and proxy behaviour | [`docs/egress-filtering.md`](../egress-filtering.md), [`debug-firewall` skill](../../.github/skills/debug-firewall/SKILL.md) |
| `auth` | Provider credentials, api-proxy, enterprise Copilot, OIDC | [`docs/auth-matrix.md`](../auth-matrix.md), [`docs/authentication-architecture.md`](../authentication-architecture.md) |
| `ci` | GitHub Actions, gh-aw compile/safe-output failures | [`debugging-workflows` skill](../../.github/skills/debugging-workflows/SKILL.md) |
| `security` | Suspected isolation or credential-boundary regression | [`docs/security.md`](../security.md) — route to security review, never to a bypass |

`docs/auth-matrix.md` stays authoritative for supported auth combinations and
`docs/compatibility.md` for supported platforms. Findings link to them and
describe failures and probes rather than copying those matrices. Code and tests
on the default branch remain authoritative for actual AWF behaviour.

Per-run logs, cache-memory, and incident reports are **evidence**, not competing
sources of truth.

## Enclave startup diagnosis

Enclave-enabled AWF runs publish the always-on, versioned
`enclaveStartup.startupChecks` checklist before primary-agent startup. Start
with the failed `scope/check-id` and its allowlisted reason; retain earlier
passed checks and later `not-attempted` checks as evidence, not inferred
success. The common checklist spans runtime/storage preparation, network
enforcement, infrastructure service startup, and real gateway connectivity and
protocol checks; Cloud Hypervisor adds its trusted host and bounded storage
prerequisites. Only explicitly optional, disabled features are `not-required`.
`startupChecks.ready` requires all applicable checks to pass.

The [standard checklist contract and extension
rules](../cloud-hypervisor-foundation.md#standard-enclave-startup-checklist)
describe the canonical check catalog, origin instrumentation, safe output,
and regression requirements. Extend that catalog and its tests when adding a
startup prerequisite; do not invent parallel diagnostic-only checks. An
unknown reason still needs evidence before becoming a finding in this registry.
Host-to-gateway readiness does not prove guest execution or guest connectivity;
the separate CI admission probe's `preflight-harness` perspective cannot prove
an `awf-host` check passed.

For Cloud Hypervisor, a failed `bounded-runtime/artifact-snapshot` is host
artifact preparation, not a guest network failure. Read the corresponding
`artifact-snapshot` copy/mode/identity/bind/remount/sealed-storage subcheck,
then the nested `storage-mount-capture` path/read/parse/match/filesystem/source
and journal-commit checks when capture fails. Retain `bounded-cleanup`
evidence separately. An rsync partial-transfer
or file-I/O reason does not prove storage exhaustion; logical release image
sizes do not measure sparse allocation. Unknown reasons remain unknown until
the failed operation supplies discriminating evidence. No new root-cause
finding is asserted for a generic v0.28.39/v0.28.40 snapshot error without its
discriminating operation evidence. Later mount evidence and source fixes are
captured by **RT-002**; explicit verification-copy ENOSPC is **RT-003**, not a
retroactive diagnosis of every earlier rsync failure.

If capture reports `storage-mount-multiple`, inspect the bounded
`enclaveStartup.mountTopology` before/after evidence and wrapper bind-call
bucket. Distinct mount IDs differ from repeated rows; local overlapping peers
differ from peers visible outside the allocation. An absent visible peer does
not prove absence in another namespace. The
[topology interpretation contract](../cloud-hypervisor-foundation.md#snapshot-bind-topology-evidence)
states which observations can eliminate each hypothesis without assuming a
root cause or changing propagation.

Newer production storage establishes an invocation-scoped private propagation
boundary before any child bind. Check `storage-propagation-set` and
`storage-propagation` in the active bounded scope; neither can be skipped.
`storage-mount-propagation` denotes an observed missing/ambiguous or non-private
mount, not permission to select a topmost duplicate. See the
[private allocation contract](../cloud-hypervisor-foundation.md#private-invocation-allocation-propagation).
The fix does not change host-wide propagation or relax recovery identity checks.

A post-startup Cloud Hypervisor enclave launch failure needs the protected
`diagnostics/cloud-hypervisor/host-executor/` invocation snapshot, not only the
MCP container's startup log classification. Read its first `failure` and
separate `cleanupFailure`, cumulative catalog checks, and sequence ordering.
The durable recovery-journal copy survives invocation teardown; host shutdown
exports it even if cleanup rejects. See the
[host-executor evidence contract](../cloud-hypervisor-foundation.md#host-executor-invocation-evidence).
An `unknown` category/code remains unknown; this instrumentation asserts no
new root-cause finding.

A later `storage-verification` failure is not evidence that snapshot binding was
attempted. Read its journal/read/observation and fixed mount-role checks, then
`enclaveStartup.storagePropagation`. The compact observations distinguish a
non-private mount from a missing or ambiguous exact match. The
[post-bind investigation contract](../cloud-hypervisor-foundation.md#post-bind-storage-propagation-evidence)
documents the tuple legend and five falsifiable hypotheses, including the
separate invocation destination outside the private allocation. No registry
finding should be selected from that aggregate reason alone. The later
[v0.28.44 observation and merged fix](https://github.com/github/gh-aw-firewall/pull/9536)
isolated `invocation-state`: a private source bound beneath a shared external
destination yielded one exact shared entry while the other roles stayed private.
**RT-002** records both this invocation-mount fix and the earlier
[allocation fix](https://github.com/github/gh-aw-firewall/pull/9530).
Current source privatizes the identity-captured invocation bind before remount;
it does not change host-wide propagation or weaken identity/cleanup checks.
Historical immutable assets remain unchanged, and source regression coverage
does not establish a fixed release tag or live guest acceptance.

For eligible, positively verified static public-only default Docker or attested
Cloud Hypervisor enclaves, start with the protected `diagnostics.json` invocation
envelope and its runtime, stage, failure, workload-stop proof, and stream
availability. Read bounded operation `stages`, the original `primaryFailure`,
and separate `cleanupFailure`; a succeeded observation is not necessarily
successful workload execution. `stdout.log`, `stderr.log`, and `enclave-session.log` are bounded,
credential-redacted host-only evidence, not canonical results or ordinary audit
artifacts. Setup failure can precede any workload exit code or session; explicit
missing/unavailable evidence must not be interpreted as success. Check retention
and cleanup failures separately. Top-level `enclaveDebugPublic: false` opts out;
private, mixed, dynamic, custom-image and unsupported-runtime scopes cannot opt
in. See [protected paths and controlled sharing](../cloud-hypervisor-foundation.md#public-fixture-enclave-debugging);
never upload the whole host-state, work, journal, or proxy-log tree.

When Docker cleanup cannot prove removal, the protected envelope may retain
host-only operation metadata with `workloadStopped: false`,
`stopProof: unavailable`, and all streams `unavailable`. This is not a workload-stop or
cleanup proof: source storage and recovery journals remain protected, and AWF
must still fail finalization. Read `primaryFailure` separately from
`cleanupFailure`; neither absent streams nor a created container's default exit
status identifies the workload outcome. Docker verification requires the exact
audited supervisor capability set; coding engines still run non-root without
capabilities.

For an eligible attested, static public-only Cloud Hypervisor enclave, additionally inspect
the protected run-cumulative `enclave-proxy-events.jsonl` and closed-vocabulary
`enclave-proxy-container.log`, separately from per-invocation `enclave-session.log`.
Proxy projections are retained under the run's protected journal identity even
when no invocation debug directory exists. Raw dedicated-proxy stdout/stderr is not
published because it can include credentials and prompts.
Distinguish an observed local rejection from an upstream non-2xx; missing
request accounting or token records does not prove the client made no request.
The primary agent's `api-proxy-logs` do not diagnose the dedicated enclave
proxy. Check collection status separately from the original invocation and
cleanup failures. Public visibility permits protected retention under the
explicit disclosure policy, not unrestricted publication; private, mixed, and
dynamic scopes must not expose these records. The 403 in smoke run
39192139592 has no established canonical diagnosis finding.

For agent-enclave upstream 401s, read the projected `copilot_auth_diagnostic`
fields before attributing failure to the credential. They distinguish selected
credential source/family, effective target and endpoint, actual Authorization
shape and injection match, integration attribution, and fixed upstream rejection
classes, without publishing credential or provider text. The
[five authentication hypotheses and elimination limits](../cloud-hypervisor-foundation.md#distinguishing-agent-enclave-authentication-failures)
describe the evidence contract. A generic 401 cannot establish expiry,
revocation, missing scope, or policy as the cause; unknown and incomplete evidence
must remain unknown. Run 39697934942 has no established registry finding.

For current public-fixture regressions, first separate ordinary-workflow
admission (**CI-003**), AWF-host gateway handshake (**CI-002**), rootfs copy
capacity (**RT-003**) and transcript-writer setup (**RT-004**). These are different
stages and evidence contracts. A preflight session-log failure is not an engine
exit, inference failure or bad provider key. The collector's `startup.json`
retains the startup checklist and early-failure classification independently of
invocation journals and `collection-status.txt`; it may omit topology/propagation
fields available in the owning host's bounded startup-error descriptor. Do not
upload raw host-state trees to fill that gap.

## Maintenance and reviewed evidence

The daily **Runtime and Enclave**, **Network**, and **CI and Integration Doctor
Updaters** complement the existing **Auth** and **Runner Doctor Updaters**.
All five import the same intake/verification contract, use complete merged-PR
enumeration plus supplemental issue searches, persist per-workflow review
receipts, and catch up older seven-day windows back to repository creation.
`diagnosis-intake` artifacts expose unclassified/deferred changes and cursors;
retrieval completion is not diagnosis review completion. See
[`patterns.md`](./patterns.md) for cache loss, backlog, publication and safety
rules. CI Doctor remains an incident investigator; security remains a restricted
human/security-review lane, with no automatic canonical security editor.

The read-only **Diagnosis Freshness** workflow checks real calendar dates and
generated parity on relevant PRs, and checks review deadlines weekly and on
manual invocation. Overdue records fail with a JSON artifact/step summary naming
their owner; dates are never automatically extended. `reviewBy` is inclusive in
UTC, and superseded records are excluded from deadline alerts.

### Review snapshot: 2026-11-09

Reviewed against default-branch source revision
`3fb6affe7ebf6a0a5508409d3fe58738ed1b02e0`; this is a targeted refresh, not a
claim that every legacy runner lesson or all 13 original records were reviewed.
New/changed records below are due for evidence review on 2026-12-09.
`fixed` denotes verified current-source corrections; fixed release versions
remain `unknown` unless independently established.

| Findings | Evidence reviewed and correction |
|---|---|
| RT-002 | Merged [#9530](https://github.com/github/gh-aw-firewall/pull/9530) / [#9536](https://github.com/github/gh-aw-firewall/pull/9536), `trusted-enclave-storage.ts` and its unit/Linux integration cases: allocation and separate invocation-destination propagation are distinct. |
| RT-003 | Merged [#11239](https://github.com/github/gh-aw-firewall/pull/11239), artifact preflight, host executor and storage-profile tests: 4 GiB host verification domain, per-role copy release, explicit `rootfs-copy` ENOSPC. |
| RT-004 | Merged [#11275](https://github.com/github/gh-aw-firewall/pull/11275), invocation staging, entrypoint and supervisor session-log tests: trusted transcript writer is distinct from non-root engine identity. |
| NET-003 | Merged [#10776](https://github.com/github/gh-aw-firewall/pull/10776), exact Squid upstream ACLs and target-port tests: explicit custom ports survive routing without broadening agent policy. |
| NET-004 | Agent iptables, entrypoint and core-environment code: raw TLS DNAT is not CONNECT; configure the client's explicit proxy rather than bypassing it. |
| AUTH-004 | Merged [#10495](https://github.com/github/gh-aw-firewall/pull/10495), API-proxy service configuration and Compose tests: healthy Squid precedes primary proxy OIDC initialization. |
| CI-002 | Merged [#9488](https://github.com/github/gh-aw-firewall/pull/9488), gateway and GitHub-gateway tests plus integration contract: bounded retryable backend unavailability is not arbitrary protocol/auth failure. |
| CI-003 | Merged [#11223](https://github.com/github/gh-aw-firewall/pull/11223), ordinary-workflow admission and runtime-validation regressions: regional OIDC endpoints and finite rejection reasons, without token probes. |
| A4, RT-001, NET-002 | Corrected misleading probes: an Alpine probe container does not identify daemon libc; daemon default does not establish explicit runtime selection; chroot DNS and transient Squid failures need distinct checks. Current `config-sections.ts` uses a 10-second DNS timeout, not the 5 seconds in historical [#8171](https://github.com/github/gh-aw-firewall/pull/8171). |

## Agent entry point

Agents should load [`.github/skills/diagnose-awf/SKILL.md`](../../.github/skills/diagnose-awf/SKILL.md).
Without a clone, use the portable artifact
[`.github/agents/diagnose-awf.md`](../../.github/agents/diagnose-awf.md) — prefer
a tag or commit matching your AWF version.

## Tooling

```bash
npm run diagnostics:validate                       # schema, IDs, provenance, safety
npx tsx scripts/diagnostics/cli.ts search "TCP_DENIED" --boundary network
npm run diagnostics:render                         # regenerate all consumers
npm run diagnostics:check                          # fail if generated output is stale
npm run diagnostics:freshness                      # overdue owner/record JSON; exit 1 if overdue
npm run diagnostics:freshness -- --as-of 2026-11-09 # reproducible UTC deadline check
```

## Index

<!-- BEGIN GENERATED: docs/diagnostics/findings -->

| Finding | Boundary | Title | Status | Record |
|---|---|---|---|---|
| A1 | runner | Bind-mounted files are missing inside containers on ARC / DinD split filesystems | workaround | [`findings/runner/A1.json`](./findings/runner/A1.json) |
| A28 | runner | ARC/DinD streaming logs target a read-only parent mount | workaround | [`findings/runner/A28.json`](./findings/runner/A28.json) |
| A29 | runner | ARC/DinD api-proxy token-usage log not found at /tmp/gh-aw | workaround | [`findings/runner/A29.json`](./findings/runner/A29.json) |
| A4 | runner | capsh, /bin/bash, or node missing inside the DinD chroot | workaround | [`findings/runner/A4.json`](./findings/runner/A4.json) |
| B36 | runner | setup-uv paths under RUNNER_TEMP are unwritable with --env-all | fixed | [`findings/runner/B36.json`](./findings/runner/B36.json) |
| RT-001 | runtime | Alternative container runtime rejects the AWF agent container configuration | needs-evidence | [`findings/runtime/RT-001.json`](./findings/runtime/RT-001.json) |
| RT-002 | runtime | Cloud Hypervisor enclave storage inherits shared mount propagation | fixed | [`findings/runtime/RT-002.json`](./findings/runtime/RT-002.json) |
| RT-003 | runtime | Shared enclave rootfs exceeds the host verification storage ceiling | fixed | [`findings/runtime/RT-003.json`](./findings/runtime/RT-003.json) |
| RT-004 | runtime | Cloud Hypervisor enclave transcript writer fails session-log preflight | fixed | [`findings/runtime/RT-004.json`](./findings/runtime/RT-004.json) |
| NET-001 | network | Squid denies a request because the domain is not in the allowlist | workaround | [`findings/network/NET-001.json`](./findings/network/NET-001.json) |
| NET-002 | network | DNS resolution fails because the resolver is not in the trusted DNS server list | workaround | [`findings/network/NET-002.json`](./findings/network/NET-002.json) |
| NET-003 | network | Custom provider upstream port is lost or rejected by Squid | fixed | [`findings/network/NET-003.json`](./findings/network/NET-003.json) |
| NET-004 | network | Proxy-unaware HTTPS client sends raw TLS to the forward proxy | workaround | [`findings/network/NET-004.json`](./findings/network/NET-004.json) |
| AUTH-001 | auth | Enterprise or Business Copilot target rejects the Authorization header prefix | fixed | [`findings/auth/AUTH-001.json`](./findings/auth/AUTH-001.json) |
| AUTH-002 | auth | API-proxy OIDC mode is configured but the Actions token request variables are missing | workaround | [`findings/auth/AUTH-002.json`](./findings/auth/AUTH-002.json) |
| AUTH-003 | auth | gh-aw-launched HTTP MCP GitHub server fails the OIDC boundary check | workaround | [`findings/auth/AUTH-003.json`](./findings/auth/AUTH-003.json) |
| AUTH-004 | auth | Primary API-proxy OIDC initialization races Squid readiness | fixed | [`findings/auth/AUTH-004.json`](./findings/auth/AUTH-004.json) |
| CI-001 | ci | gh-aw safe-output step fails because the emitted payload violates the declared contract | workaround | [`findings/ci/CI-001.json`](./findings/ci/CI-001.json) |
| CI-002 | ci | Compiler-owned enclave gateway is unavailable or violates the handoff contract | workaround | [`findings/ci/CI-002.json`](./findings/ci/CI-002.json) |
| CI-003 | ci | Cloud Hypervisor regression admission rejects a regional Actions OIDC endpoint | fixed | [`findings/ci/CI-003.json`](./findings/ci/CI-003.json) |
| SEC-001 | security | Suspected isolation or credential-boundary regression must go to security review, not a bypass | needs-evidence | [`findings/security/SEC-001.json`](./findings/security/SEC-001.json) |

### Symptom lookup

| Observable symptom | Finding | Boundary | Status |
|---|---|---|---|
| Bind-mounted workspace or config files are empty or missing inside the agent container | A1 | runner | workaround |
| docker compose starts but the mounted path resolves to an empty directory | A1 | runner | workaround |
| no such file or directory for a path that exists on the runner | A1 | runner | workaround |
| Streaming log write fails with read-only file system | A28 | runner | workaround |
| tee: /tmp/gh-aw/pi-streaming.jsonl: Read-only file system | A28 | runner | workaround |
| A successful engine run becomes a failure under arc-dind | A28 | runner | workaround |
| Safe outputs are missing after a streaming engine run | A28 | runner | workaround |
| token-usage.jsonl is missing for post-run consumers on arc-dind | A29 | runner | workaround |
| gh-aw.aic / gen_ai.usage.* telemetry is absent on arc-dind | A29 | runner | workaround |
| The run succeeds but token-usage telemetry is missing | A29 | runner | workaround |
| capsh: not found | A4 | runner | workaround |
| /bin/bash: no such file or directory during chroot startup | A4 | runner | workaround |
| node: not found when the harness binary starts | A4 | runner | workaround |
| uv Permission denied under UV_CACHE_DIR | B36 | runner | fixed |
| uv Permission denied under UV_PYTHON_INSTALL_DIR | B36 | runner | fixed |
| The agent repeatedly chooses its own uv cache directory | B36 | runner | fixed |
| OCI runtime create failed | RT-001 | runtime | needs-evidence |
| unknown capability reported by the container runtime at start | RT-001 | runtime | needs-evidence |
| unsupported mount reported by the container runtime at start | RT-001 | runtime | needs-evidence |
| The agent container never starts while Squid is healthy | RT-001 | runtime | needs-evidence |
| storage-mount-multiple during artifact-snapshot | RT-002 | runtime | fixed |
| storage-verification/invocation-state fails with storage-mount-propagation | RT-002 | runtime | fixed |
| bounded-artifacts/rootfs-copy fails with ENOSPC | RT-003 | runtime | fixed |
| Cloud Hypervisor enclave stops before rootfs-digest and rootfs-attestation | RT-003 | runtime | fixed |
| preflight-session-log permission-denied | RT-004 | runtime | fixed |
| session-log preflight fails before the enclave engine launches | RT-004 | runtime | fixed |
| TCP_DENIED | NET-001 | network | workaround |
| 403 Forbidden returned by the proxy for an outbound request | NET-001 | network | workaround |
| curl: (56) Received HTTP code 403 from proxy after CONNECT | NET-001 | network | workaround |
| Could not resolve host | NET-002 | network | workaround |
| Temporary failure in name resolution | NET-002 | network | workaround |
| getaddrinfo EAI_AGAIN inside the agent container | NET-002 | network | workaround |
| Configured Ollama port 11434 is routed to port 80 | NET-003 | network | fixed |
| Trusted API-proxy custom-port request is rejected as an unsafe port | NET-003 | network | fixed |
| TLS handshake fails when the client ignores HTTPS_PROXY | NET-004 | network | workaround |
| Raw ClientHello reaches Squid instead of an HTTP CONNECT request | NET-004 | network | workaround |
| 400 Bad Request: Authorization header is badly formatted | AUTH-001 | auth | fixed |
| Copilot requests fail immediately against api.enterprise.githubcopilot.com or api.business.githubcopilot.com | AUTH-001 | auth | fixed |
| api-proxy reports that no OIDC token could be minted | AUTH-002 | auth | workaround |
| Provider requests fail with 401 while AWF_AUTH_TYPE=github-oidc is set | AUTH-002 | auth | workaround |
| ACTIONS_ID_TOKEN_REQUEST_URL is not available to the sidecar | AUTH-002 | auth | workaround |
| mcpg / HTTP MCP GitHub server returns 401 for github-oidc authentication | AUTH-003 | auth | workaround |
| Gateway configuration contains no OIDC auth metadata | AUTH-003 | auth | workaround |
| MCP GitHub tool calls fail while provider inference still works | AUTH-003 | auth | workaround |
| Anthropic OIDC initialization fails until the API-proxy token retry | AUTH-004 | auth | fixed |
| Agent exhausts early 503 retries while the API proxy has no token | AUTH-004 | auth | fixed |
| safe output validation failed in the workflow run | CI-001 | ci | workaround |
| The agent job succeeds but the safe-output collection step exits non-zero | CI-001 | ci | workaround |
| create-pull-request rejected: file not in allowed-files | CI-001 | ci | workaround |
| Enclave initialize returns 503 backend_unavailable | CI-002 | ci | workaround |
| AWF host gateway readiness fails before primary-agent startup | CI-002 | ci | workaround |
| cloud-hypervisor-enclave-admission-token-acquisition | CI-003 | ci | fixed |
| Cloud Hypervisor regression profiles reject before broker startup | CI-003 | ci | fixed |
| The agent container can reach a domain that is not allowlisted | SEC-001 | security | needs-evidence |
| A provider credential is observable inside the agent environment while the api-proxy is enabled | SEC-001 | security | needs-evidence |
| Egress succeeds without a corresponding Squid access-log entry | SEC-001 | security | needs-evidence |

<!-- END GENERATED: docs/diagnostics/findings -->
