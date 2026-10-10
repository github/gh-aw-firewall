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
| `runtime` | Container runtime, chroot, gVisor/Kata, sandbox startup | [`docs/gvisor-integration.md`](../gvisor-integration.md), [`docs/compatibility.md`](../compatibility.md) |
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
finding is asserted for the unresolved v0.28.39/v0.28.40 snapshot failure.

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

A later `storage-verification` failure is not evidence that snapshot binding was
attempted. Read its journal/read/observation and fixed mount-role checks, then
`enclaveStartup.storagePropagation`. The compact observations distinguish a
non-private mount from a missing or ambiguous exact match. The
[post-bind investigation contract](../cloud-hypervisor-foundation.md#post-bind-storage-propagation-evidence)
documents the tuple legend and five falsifiable hypotheses, including the
separate invocation destination outside the private allocation. No registry
finding matches the v0.28.43 failure yet; a release-pinned observation is needed
before claiming a root cause.

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
| NET-001 | network | Squid denies a request because the domain is not in the allowlist | workaround | [`findings/network/NET-001.json`](./findings/network/NET-001.json) |
| NET-002 | network | DNS resolution fails because the resolver is not in the trusted DNS server list | workaround | [`findings/network/NET-002.json`](./findings/network/NET-002.json) |
| AUTH-001 | auth | Enterprise or Business Copilot target rejects the Authorization header prefix | fixed | [`findings/auth/AUTH-001.json`](./findings/auth/AUTH-001.json) |
| AUTH-002 | auth | API-proxy OIDC mode is configured but the Actions token request variables are missing | workaround | [`findings/auth/AUTH-002.json`](./findings/auth/AUTH-002.json) |
| AUTH-003 | auth | gh-aw-launched HTTP MCP GitHub server fails the OIDC boundary check | workaround | [`findings/auth/AUTH-003.json`](./findings/auth/AUTH-003.json) |
| CI-001 | ci | gh-aw safe-output step fails because the emitted payload violates the declared contract | workaround | [`findings/ci/CI-001.json`](./findings/ci/CI-001.json) |
| SEC-001 | security | Suspected isolation or credential-boundary regression must go to security review, not a bypass | needs-evidence | [`findings/security/SEC-001.json`](./findings/security/SEC-001.json) |

### Symptom lookup

| Observable symptom | Finding | Boundary | Status |
|---|---|---|---|
| Bind-mounted workspace or config files are empty or missing inside the agent container | A1 | runner | workaround |
| docker compose starts but the mounted path resolves to an empty directory | A1 | runner | workaround |
| no such file or directory for a path that exists on the runner | A1 | runner | workaround |
| Streaming log write fails with read-only file system | A28 | runner | workaround |
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
| TCP_DENIED | NET-001 | network | workaround |
| 403 Forbidden returned by the proxy for an outbound request | NET-001 | network | workaround |
| curl: (56) Received HTTP code 403 from proxy after CONNECT | NET-001 | network | workaround |
| Could not resolve host | NET-002 | network | workaround |
| Temporary failure in name resolution | NET-002 | network | workaround |
| getaddrinfo EAI_AGAIN inside the agent container | NET-002 | network | workaround |
| 400 Bad Request: Authorization header is badly formatted | AUTH-001 | auth | fixed |
| Copilot requests fail immediately against api.enterprise.githubcopilot.com or api.business.githubcopilot.com | AUTH-001 | auth | fixed |
| api-proxy reports that no OIDC token could be minted | AUTH-002 | auth | workaround |
| Provider requests fail with 401 while AWF_AUTH_TYPE=github-oidc is set | AUTH-002 | auth | workaround |
| ACTIONS_ID_TOKEN_REQUEST_URL is not available to the sidecar | AUTH-002 | auth | workaround |
| mcpg / HTTP MCP GitHub server returns 401 for github-oidc authentication | AUTH-003 | auth | workaround |
| Gateway configuration contains no OIDC auth metadata | AUTH-003 | auth | workaround |
| MCP GitHub tool calls fail while provider inference still works | AUTH-003 | auth | workaround |
| safe output validation failed in the workflow run | CI-001 | ci | workaround |
| The agent job succeeds but the safe-output collection step exits non-zero | CI-001 | ci | workaround |
| create-pull-request rejected: file not in allowed-files | CI-001 | ci | workaround |
| The agent container can reach a domain that is not allowlisted | SEC-001 | security | needs-evidence |
| A provider credential is observable inside the agent environment while the api-proxy is enabled | SEC-001 | security | needs-evidence |
| Egress succeeds without a corresponding Squid access-log entry | SEC-001 | security | needs-evidence |

<!-- END GENERATED: docs/diagnostics/findings -->
