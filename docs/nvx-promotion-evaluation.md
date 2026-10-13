# NVX Phase 4 promotion evaluation

This document defines the Phase 4 gate for promoting NVX beyond its explicit
experimental preview. The thresholds below are **fixed before any benchmark
data is collected**. They live in machine-readable form in
[`nvx-promotion-thresholds.json`](nvx-promotion-thresholds.json) and are
enforced by `scripts/ci/nvx-promotion-evaluator.ts`. Changing a threshold after
results exist requires a separate reviewed change that explains why.

NVX stays an opt-in preview, and Cloud Hypervisor stays the reference runtime,
until a report produced from this process is reviewed and accepted. This work
does not remove the mandatory preview gate or change the default runtime.

## Validated baseline

| Item | Value |
| ---- | ----- |
| gh-aw | v0.91.9 |
| AWF | v0.28.54 |
| NVX workflow upgrade | github/gh-aw-firewall#9886 |
| Automatic musl guest asset selection | github/gh-aw#67915 |
| NVX build smoke | [run 38320706390](https://github.com/github/gh-aw-firewall/actions/runs/38320706390) |
| Official-release build confirmation | [run 38272330203](https://github.com/github/gh-aw-firewall/actions/runs/38272330203) |
| NVX Copilot confirmation | [run 38295300049](https://github.com/github/gh-aw-firewall/actions/runs/38295300049) |

Every result record must also capture the compiler, AWF, runtime, upstream
artifact (NVX/OpenVMM or Cloud Hypervisor), guest image, runner image and
workload versions in `versions`, and the runner class in `runnerClass`.

## Promotion thresholds

A gate is met only when **every** lane (workload × sequential/concurrent) meets
it for NVX. Percentiles use nearest-rank over successful runs.

| Gate | Threshold |
| ---- | --------- |
| Sequential sample size | ≥ 30 runs per lane per runtime |
| Concurrent sample size | ≥ 10 runs per lane per runtime |
| Cancellation / stale-recovery samples | ≥ 10 per kind per runtime |
| Successful-run rate | ≥ 95% (and not below Cloud Hypervisor) |
| VM startup to runtime-ready | p50 ≤ 10 s, p95 ≤ 20 s |
| End-to-end workflow duration | p50 ≤ 300 s, p95 ≤ 600 s |
| Peak memory | p95 ≤ 6144 MiB |
| Scratch disk | p95 ≤ 4096 MiB |
| PIDs | p95 ≤ 512 |
| Cleanup duration | p95 ≤ 30 s |
| Cancellation time | p95 ≤ 30 s |
| Stale-resource recovery time | p95 ≤ 60 s |
| Credential-isolation or egress-policy regressions | 0 |
| Leaked processes, mounts, network namespaces, cgroups, run directories, scratch images, artifact snapshots, cleanup records or KVM ACL entries | 0 |
| Measurable benefit over Cloud Hypervisor | ≥ 10% better on at least one of startup p50/p95, end-to-end p50/p95, peak-memory p95, scratch p95 |
| Regression versus Cloud Hypervisor | ≤ 10% worse on startup, end-to-end, peak memory, scratch, CPU time, PIDs and cleanup duration |

Any security or cleanup assertion failure is an automatic **stop-promotion**
result regardless of performance. Unmet sample-size, performance or advantage
gates yield **retain-preview**. Only when all gates pass is the recommendation
**promote**.

## Benchmark matrix

Both runtimes run identical workloads, on the same GitHub-hosted Linux x86_64
KVM runner class, with identical security policy and workload versions.

| Dimension | Cases |
| --------- | ----- |
| Workload | deterministic build/test; Copilot/API-proxy inference |
| Cache | cold and warm |
| Concurrency | sequential repeats (≥ 30) and concurrent runs verifying per-run identity and resource isolation |
| Lifecycle | bounded cancellation; forced manager `SIGKILL` followed by stale-resource recovery |
| Resources | minimum/default and elevated configurations |

Reruns: a run that fails is recorded as a failure and counted in the success
rate. A rerun is permitted only for a demonstrated runner or network
infrastructure fault unrelated to either runtime (for example the runner being
preempted); both the original failure and the rerun must be retained. A failed
security or cleanup assertion is never rerun away.

## Evidence collected per run

Each run emits one `RunResult` record (see
`scripts/ci/nvx-promotion-evaluator.ts`): artifact/preflight, startup,
first-inference/workload, end-to-end and cleanup durations; CPU seconds, peak
memory, scratch and host-disk use; peak PIDs; API-proxy request counts and
token usage for inference workloads; the failed assertions; and residue found
by the post-run checks. Cancellation and stale-recovery samples are emitted as
`RecoveryResult` records. Raw records are retained as machine-readable JSON
workflow artifacts alongside the report.

Evaluate a result set with:

```bash
npx ts-node scripts/ci/nvx-promotion-evaluator.ts results.json
```

The command prints the p50/p95 summaries, blockers, unmet gates and the
recommendation as JSON, and exits non-zero unless the recommendation is
`promote`.

## Fail-closed assertions retained in every lane

- signed and pinned artifact provenance, with no runtime fallback;
- deny-by-default guest networking;
- API credentials only in the API-proxy sidecar and no real provider or GitHub
  credentials in the guest;
- workspace-only host exposure;
- immutable trusted artifacts and root-owned staged runtime assets;
- bounded writable scratch and writable guest home;
- scoped `/dev/kvm` access with exact restoration;
- cancellation, timeout, stale recovery and concurrent-run isolation with
  residue-free cleanup.

None of these may be weakened to improve success rates.

## Upstream and operational readiness

| Topic | Assessment |
| ----- | ---------- |
| Artifact stability and cadence | NVX is pinned to `microsoft/nvx` release `v0.1.0-dev.be859aa77ffa`, a development pre-release. No stable release cadence exists yet. |
| Supported runners | GitHub-hosted Ubuntu x86_64 runners with `/dev/kvm`; no ARM, self-hosted or nested-virtualization guarantees. |
| Diagnostics and retention | Guest output, manager evidence and cleanup records are collected as workflow artifacts; retention quality is to be reviewed with the first benchmark data. |
| Upgrade | Update the pinned release tag and SHA-256, rebuild the attested artifacts, and rerun the live-KVM and smoke workflows. |
| Rollback | Revert the pin; no data migration is involved because runs are one-shot. |
| Maintenance ownership | The AWF maintainers own the integration; the upstream NVX/OpenVMM maintainers own the VMM. A named long-term owner must be recorded before promotion. |
| Known limitations vs Cloud Hypervisor | Experimental, opt-in only; fewer production hours; single pinned upstream dev artifact; x86_64 and KVM only. |

## Report status

**Recommendation: retain preview.** The thresholds and tooling are published,
but benchmark runs have not yet been executed, so no gate has demonstrated a
pass. The mandatory preview gate must stay in place until the benchmark matrix
has been run and a report from the evaluator is reviewed.

Follow-up issues, one per unmet gate, are opened from the evaluator's
`unmetGates` output when results are published:

- run the benchmark matrix on matched NVX and Cloud Hypervisor lanes;
- demonstrate the measurable advantage over Cloud Hypervisor;
- record a long-term maintenance owner and upstream release-cadence plan;
- review the final recommendation before any preview-gate or default-runtime
  change.

The final report must contain the raw results, p50/p95 and success-rate tables,
the NVX versus Cloud Hypervisor comparison, the assertion and cleanup outcomes,
observed failures with rerun decisions, limitations and residual risks, and the
recommendation.
