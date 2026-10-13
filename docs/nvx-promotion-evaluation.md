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

| Item                                 | Value                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| gh-aw                                | v0.91.9                                                                              |
| AWF                                  | v0.28.54                                                                             |
| NVX workflow upgrade                 | github/gh-aw-firewall#9886                                                           |
| Automatic musl guest asset selection | github/gh-aw#67915                                                                   |
| NVX artifact                         | microsoft/nvx@v0.1.0-dev.be859aa77ffa                                                |
| Cloud Hypervisor artifact            | Cloud Hypervisor v53.0                                                               |
| NVX build smoke                      | [run 38320706390](https://github.com/github/gh-aw-firewall/actions/runs/38320706390) |
| Official-release build confirmation  | [run 38272330203](https://github.com/github/gh-aw-firewall/actions/runs/38272330203) |
| NVX Copilot confirmation             | [run 38295300049](https://github.com/github/gh-aw-firewall/actions/runs/38295300049) |
| Four-sample matched-runtime canary   | [run 38418583514](https://github.com/github/gh-aw-firewall/actions/runs/38418583514) |

Every result record must also capture the compiler, AWF, runtime, upstream
artifact (NVX/OpenVMM or Cloud Hypervisor), guest image, runner image and
workload versions. Reviewed baseline keys remain in `versions`; exact
compiler/AWF/runtime artifact/guest/workload identities are repeated in the
structured `provenance` field. The aggregator rejects any mismatch and accepts
only runner classes listed in `approvedRunnerClasses`.

## Promotion thresholds

A gate is met only when **every** required matrix cell meets it for NVX and has
the corresponding Cloud Hypervisor samples. The fixed matrix has 24 lanes:
workload × mode × cache state × resource profile. Percentiles use nearest-rank
over successful runs.

| Gate                                                                                                                                           | Threshold                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Sequential sample size                                                                                                                         | ≥ 30 runs per lane per runtime                                                                    |
| Concurrent sample size                                                                                                                         | ≥ 10 runs per lane per runtime                                                                    |
| Cancellation / stale-recovery samples                                                                                                          | ≥ 10 per kind per runtime                                                                         |
| Successful-run rate                                                                                                                            | ≥ 95% (and not below Cloud Hypervisor)                                                            |
| VM startup to runtime-ready                                                                                                                    | p50 ≤ 10 s, p95 ≤ 20 s                                                                            |
| End-to-end workflow duration                                                                                                                   | p50 ≤ 300 s, p95 ≤ 600 s                                                                          |
| Peak memory                                                                                                                                    | p95 ≤ 6144 MiB                                                                                    |
| Scratch disk                                                                                                                                   | p95 ≤ 4096 MiB                                                                                    |
| PIDs                                                                                                                                           | p95 ≤ 512                                                                                         |
| Cleanup duration                                                                                                                               | p95 ≤ 30 s                                                                                        |
| Cancellation time                                                                                                                              | p95 ≤ 30 s                                                                                        |
| Stale-resource recovery time                                                                                                                   | p95 ≤ 60 s                                                                                        |
| Credential-isolation or egress-policy regressions                                                                                              | 0                                                                                                 |
| Leaked processes, mounts, network namespaces, cgroups, run directories, scratch images, artifact snapshots, cleanup records or KVM ACL entries | 0                                                                                                 |
| Measurable benefit over Cloud Hypervisor                                                                                                       | ≥ 10% better on at least one of startup p50/p95, end-to-end p50/p95, peak-memory p95, scratch p95 |
| Regression versus Cloud Hypervisor                                                                                                             | ≤ 10% worse on startup, end-to-end, peak memory, scratch, CPU time, PIDs and cleanup duration     |

Any security or cleanup assertion failure is an automatic **stop-promotion**
result regardless of performance. Unmet sample-size, performance or advantage
gates yield **retain-preview**. Only when all gates pass is the recommendation
**promote**.

## Benchmark matrix

Both runtimes run identical workloads, on the same GitHub-hosted Linux x86_64
KVM runner class, with identical security policy and workload versions.

| Dimension   | Cases                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Workload    | `build-test`; `copilot-inference`                                                                   |
| Cache       | `cold`; `warm`                                                                                      |
| Concurrency | `sequential` (≥ 30) and `concurrent` (≥ 10), each verifying per-run identity and resource isolation |
| Lifecycle   | bounded cancellation; forced manager `SIGKILL` followed by stale-resource recovery                  |
| Resources   | `minimum`; `default`; `elevated`                                                                    |

Each `RunResult` includes `workload`, `mode`, `cache`, and `resourceProfile`;
these four fields form the lane key. The evaluator enumerates the required
Cartesian product from the thresholds file instead of inferring lanes from the
submitted results, so any missing cell fails its sample-size gate.

Reruns: a run or recovery attempt that fails is recorded as a failure and
counted in its gate. One rerun is permitted only for a demonstrated runner or
network infrastructure fault unrelated to either runtime (for example the
runner being preempted); both the original failure and the rerun must be
retained. The original remains the scored sample. A failed security or cleanup
assertion, or any residue, is never rerun away.

## Evidence collected per run

Each run emits one `RunResult` record (see
`scripts/ci/nvx-promotion-evaluator.ts`): `artifactPreflightMs`, `startupMs`,
`firstWorkloadMs`, `endToEndMs`, `cleanupMs`, `cpuSeconds`, `peakMemoryMiB`,
`scratchMiB`, `hostDiskMiB`, `peakPids`, `apiProxyRequests`, `inputTokens`,
`outputTokens`, failed assertions and post-run residue. The collector validates
that every numeric evidence field is present and finite; startup and end-to-end
duration, peak memory, peak PIDs and CPU usage must also be positive.
Cancellation and stale-recovery samples carry explicit success and failure
categories, readiness and cleanup assertions, duration, and residue. Failed
boolean assertions are retained as failures for the evaluator, which stops
promotion before including that recovery duration in the percentile. Raw
records are retained as machine-readable JSON workflow artifacts alongside the
report.

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

| Topic                                 | Assessment                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact stability and cadence        | NVX is pinned to `microsoft/nvx` release `v0.1.0-dev.be859aa77ffa`, a development pre-release. No stable release cadence exists yet.                       |
| Supported runners                     | GitHub-hosted Ubuntu x86_64 runners with `/dev/kvm`; no ARM, self-hosted or nested-virtualization guarantees.                                              |
| Diagnostics and retention             | Guest output, manager evidence and cleanup records are collected as workflow artifacts; retention quality is to be reviewed with the first benchmark data. |
| Upgrade                               | Update the pinned release tag and SHA-256, rebuild the attested artifacts, and rerun the live-KVM and smoke workflows.                                     |
| Rollback                              | Revert the pin; no data migration is involved because runs are one-shot.                                                                                   |
| Maintenance ownership                 | The AWF maintainers own the integration; the upstream NVX/OpenVMM maintainers own the VMM. A named long-term owner must be recorded before promotion.      |
| Known limitations vs Cloud Hypervisor | Experimental, opt-in only; fewer production hours; single pinned upstream dev artifact; x86_64 and KVM only.                                               |

## Campaign workflow and evidence operation

The manually dispatched [NVX Phase 4 Promotion Benchmark workflow](../.github/workflows/nvx-phase-4-benchmark.yml)
defaults to `dry-run`. Supply an immutable campaign ID, for example
`nvx-p4-review-2026-10`, and retain the uploaded artifact named with that ID,
workflow run, and attempt. The dry run expands all 24 lanes for both runtimes,
creates one marked pipeline sample per lane and recovery kind, validates every
metric and zero-tolerance assertion, invokes the evaluator, and requires the
`retain-preview` recommendation. Its values are synthetic pipeline fixtures,
not runtime measurements, and must never be included in a promotion report.

The collector contract maps resource profiles identically for both runtimes:

| Profile  | CPU cores | Memory MiB | PID limit | Scratch MiB |
| -------- | --------: | ---------: | --------: | ----------: |
| minimum  |         1 |       2048 |       128 |        1024 |
| default  |         2 |       4096 |       256 |        2048 |
| elevated |         4 |       6144 |       512 |        4096 |

Cold samples must report `cold-cache-flushed`; warm samples must report
`warm-cache-primed`. Each run record carries the applied limits and preparation
label, and the collector rejects a mismatch.

The measured campaign has three strictly separated tiers. Every manifest and
aggregate records its tier, exact stable sample IDs, estimated runner minutes,
and `promotionEligible` value. Pilot evidence is immutable and measured, but
always sets `promotionEligible: false`; the planner and aggregator never merge
pilot sample IDs into a full campaign.

| Tier | Deterministic plan | Estimate | Promotion eligible | Prerequisite |
| --- | --- | ---: | --- | --- |
| `pilot-100` | 6 matched run samples plus 4 recovery samples | 100 runner-minutes | No | None |
| `pilot-1000` | 2 samples in each of 48 matched runtime/lane cells plus 4 recovery samples | 1,000 runner-minutes | No | Successful `pilot-100` run |
| `full` | 960 run samples plus 40 recovery samples | 10,000 runner-minutes | Yes | Successful `pilot-1000` run |

The 100-minute tier runs both workloads in the sequential/cold/default baseline
for both runtimes, adds a matched concurrent/cold/default build pair, and runs
one cancellation and one stale-recovery sample per runtime. Every run retains
the credential, egress, workspace-exposure, resource, cleanup, residue and KVM
ACL assertions.

The 1,000-minute tier runs two samples for both runtimes in every combination
of workload, sequential/concurrent mode, cold/warm cache and
minimum/default/elevated resource profile. It also runs one cancellation and
one stale-recovery sample per runtime. This covers the complete matrix shape
before the full tier increases the per-lane statistical sample size.

At the conservative 10-minute per-sample planning allowance, the full tier is
10,000 runner-minutes (166.7 runner-hours) before setup or infrastructure
overhead. The workflow is serialized across all tiers and does not start an
unbounded or PR-triggered campaign. Each measured tier requires exact
tier-specific confirmation text.

Measured execution uses the reviewed matched-runtime adapter. The 100-minute
tier has exactly 10 one-sample cells, the 1,000-minute tier has exactly 52
cells and 100 unique samples, and the full tier has exactly 76 cells and 1,000
unique samples. Each cell contains at most 20 stable sample IDs and runs them
serially; the workflow runs at most four cells in parallel. Before live work
starts, the planner verifies the exact tier, cell count, unique sample count,
promotion eligibility and runner-minute ceiling. Repository concurrency
permits only one Phase 4 campaign tier at a time.

A progression run is accepted only when its aggregate is a complete,
successful, measured pilot from the same source commit, runner class, runner
image, guest image and reviewed baseline. All original run and recovery records
must succeed with no assertion failures or residue. A 1,000-minute pilot must cite
the successful 100-minute workflow run ID; a full campaign must cite the
successful 1,000-minute workflow run ID.

### Initial 100-minute pilot dispatch

After this workflow change is merged to `main`, choose a new immutable campaign
ID and run:

```bash
gh workflow run nvx-phase-4-benchmark.yml \
  --ref PILOT_SOURCE_REF \
  -f mode=pilot-100 \
  -f campaign_id=nvx-p4-pilot-100-2026-10 \
  -f confirm_runner_minutes='I reviewed and approve the 100 runner-minute pilot' \
  -f progression_run_id='' \
  -f prior_run_id='' \
  -f allow_infrastructure_retry=false \
  -f infrastructure_retry_url=''
```

### Initial 1,000-minute pilot dispatch

Use the same reviewed source ref and cite the successful 100-minute workflow
run:

```bash
gh workflow run nvx-phase-4-benchmark.yml \
  --ref PILOT_SOURCE_REF \
  -f mode=pilot-1000 \
  -f campaign_id=nvx-p4-pilot-1000-2026-10 \
  -f confirm_runner_minutes='I reviewed and approve the 1,000 runner-minute pilot' \
  -f progression_run_id=PILOT_100_RUN_ID \
  -f prior_run_id='' \
  -f allow_infrastructure_retry=false \
  -f infrastructure_retry_url=''
```

Each cell uploads its manifest, canonical cell definition, pending list,
adapter inputs, raw measured records, lifecycle/assertion/residue evidence and
retry policy even when a sample fails. The raw result files use exclusive
creation and stable sample/attempt IDs. Aggregation copies them in sorted order
and rejects missing, unexpected, duplicate, cross-campaign, stale-baseline or
malformed evidence.

### Initial full-campaign dispatch

Do not dispatch from a pull request. After this workflow change is merged to
`main`, choose a new immutable campaign ID and run:

```bash
gh workflow run nvx-phase-4-benchmark.yml \
  --ref FULL_CAMPAIGN_SOURCE_REF \
  -f mode=full \
  -f campaign_id=nvx-p4-full-2026-10 \
  -f confirm_runner_minutes='I reviewed and approve the 10,000 runner-minute estimate' \
  -f progression_run_id=PILOT_1000_RUN_ID \
  -f prior_run_id='' \
  -f allow_infrastructure_retry=false \
  -f infrastructure_retry_url=''
```

`FULL_CAMPAIGN_SOURCE_REF` must resolve to the reviewed merge commit and must
remain fixed for every resume. Record the resulting workflow run ID. Never
dispatch the same campaign ID again without supplying that run ID as
`prior_run_id`.
Do not use the Actions **Re-run jobs** control: campaign jobs reject a second
`run_attempt` because it can mix partial artifacts. Always use a new dispatch
with `prior_run_id`.

### Resume from immutable prior artifacts

Resume a 100-minute pilot with:

```bash
gh workflow run nvx-phase-4-benchmark.yml \
  --ref PILOT_SOURCE_REF \
  -f mode=pilot-100 \
  -f campaign_id=nvx-p4-pilot-100-2026-10 \
  -f confirm_runner_minutes='I reviewed and approve the 100 runner-minute pilot' \
  -f progression_run_id='' \
  -f prior_run_id=PILOT_100_RUN_ID \
  -f allow_infrastructure_retry=false \
  -f infrastructure_retry_url=''
```

Resume a 1,000-minute pilot with:

```bash
gh workflow run nvx-phase-4-benchmark.yml \
  --ref PILOT_SOURCE_REF \
  -f mode=pilot-1000 \
  -f campaign_id=nvx-p4-pilot-1000-2026-10 \
  -f confirm_runner_minutes='I reviewed and approve the 1,000 runner-minute pilot' \
  -f progression_run_id=PILOT_100_RUN_ID \
  -f prior_run_id=PILOT_1000_RUN_ID \
  -f allow_infrastructure_retry=false \
  -f infrastructure_retry_url=''
```

To resume interrupted or incomplete cells without rerunning completed sample
IDs:

```bash
gh workflow run nvx-phase-4-benchmark.yml \
  --ref FULL_CAMPAIGN_SOURCE_REF \
  -f mode=full \
  -f campaign_id=nvx-p4-full-2026-10 \
  -f confirm_runner_minutes='I reviewed and approve the 10,000 runner-minute estimate' \
  -f progression_run_id=PILOT_1000_RUN_ID \
  -f prior_run_id=FULL_CAMPAIGN_RUN_ID \
  -f allow_infrastructure_retry=false \
  -f infrastructure_retry_url=''
```

The resume run downloads the prior immutable plan and per-cell artifacts,
requires the same campaign ID and source commit, validates each existing
record, and selects only missing stable sample IDs. A sample with a recorded
security assertion failure, cleanup failure, residue, workload failure or
successful original attempt is never selected again.

Concurrent samples run two inspected runtime instances, not two processes in
one guest. The primary CLI owns the shared Squid/API-proxy infrastructure;
the peer uses the same reviewed runtime backend without recreating those
sidecars. Before either workload starts, host evidence must show distinct
live VMM processes, accounts, run directories, cgroups and network namespaces,
with the selected resource bounds applied to both. Infrastructure stays alive
until both guest workloads have ended. Cleanup checks include durable records,
runtime scratch/run directories and trusted-artifact snapshot roots.

Guest security checks and scratch capacity are saved before inference. A
transient inference failure can therefore retain those completed checks and
use preserved logs for infrastructure classification without inventing
successful workload evidence.

One linked second attempt is allowed only when the original record has no
assertion failures or residue and is classified as `runner-preempted`,
`runner-unavailable`, or `network-infrastructure`. After documenting the
infrastructure incident and approving the retry, dispatch:

```bash
gh workflow run nvx-phase-4-benchmark.yml \
  --ref FULL_CAMPAIGN_SOURCE_REF \
  -f mode=full \
  -f campaign_id=nvx-p4-full-2026-10 \
  -f confirm_runner_minutes='I reviewed and approve the 10,000 runner-minute estimate' \
  -f progression_run_id=PILOT_1000_RUN_ID \
  -f prior_run_id=FULL_CAMPAIGN_RUN_ID \
  -f allow_infrastructure_retry=true \
  -f infrastructure_retry_url=https://github.com/github/gh-aw-firewall/issues/ISSUE_NUMBER
```

The retry is linked to the failed attempt and retained alongside it. The
original remains the scored sample; a third attempt is rejected.

The campaign utility can validate a locally retained evidence directory with:

```bash
npx tsx scripts/ci/nvx-benchmark-campaign.ts aggregate \
  campaign-manifest.json raw-samples benchmark-results.json report.md
```

It rejects missing, unexpected, duplicate, cross-campaign, stale-baseline, or
malformed samples. Stable IDs allow a resumed collection to retain prior
artifacts without counting an attempt twice. A retry is accepted only for a
documented runner/infrastructure category; the failed original remains the
scored sample and the retry remains in `attempts`. Security failures, cleanup
failures, and residue are never retryable.

### Bounded measured canary

The separate [NVX Phase 4 Matched Runtime Canary workflow](../.github/workflows/nvx-phase-4-canary.yml)
remains a distinct non-promotion workflow. Dispatch it manually
with an immutable `campaign_id` and set `confirm_live_canary` to `true`. It runs
exactly four serialized samples on `ubuntu-24.04`: one NVX and one Cloud
Hypervisor sample for each of `build-test` and `copilot-inference`. All four use
the `sequential/cold/default` lane, gh-aw v0.91.9, AWF v0.28.54, the same source
commit, workspace-only exposure, deny-by-default networking, API proxy and the
same one-guest-vCPU/two-host-CPU-quota, 4096-MiB, 256-PID and 2048-MiB scratch
profile. The Copilot lane pins Copilot CLI 1.0.95 and the prompt workload is
versioned independently from the source commit.

Plan for approximately **40 runner-minutes** plus artifact setup time. Each
matrix job uploads its immutable manifest, adapter input, lifecycle evidence,
assertion evidence, residue list, token-usage log (for Copilot), AWF log and one
`RunEvidence` JSON record. The aggregate job uploads the deterministic combined
results, evaluator output and report.

Canary manifests set `canary: true` and `promotionEligible: false`. Successful
run 38418583514 remains canary evidence only and is not imported by the full
campaign workflow. The
aggregator requires measured evidence but the evaluator must return
`retain-preview`; canary records are never credited toward the 960-run/40-
recovery promotion thresholds. The canary does not exercise concurrent,
warm-cache, minimum/elevated-resource, cancellation or stale-recovery lanes,
and it cannot enable `full` mode.

The runner-side adapter is
`scripts/ci/nvx-matched-runtime-adapter.ts`. The runtime harness must emit
ordered lifecycle timestamps, measured scratch/host-disk bytes, every reviewed
zero-tolerance assertion and a residue array. The adapter independently samples
the launched process tree for CPU time, RSS and PID peaks and parses the
API-proxy `token-usage.jsonl` for Copilot request and token counts. Missing,
zero where a positive observation is required, malformed or contradictory
evidence fails closed before an artifact is written.

The same adapter has a `recovery` command for future reviewed full-campaign
collection. It accepts only manifest-listed cancellation or stale-recovery
sample IDs and requires measured duration, readiness/terminal evidence, the
complete cleanup assertion set, residue, and (for stale recovery) proof that the
manager was killed after its durable cleanup record and that a real workload
ran after identity-checked recovery. The canary does not invoke this path.

## Report status

**Recommendation: retain preview.** The thresholds and tooling are published,
but benchmark runs have not yet been executed, so no gate has demonstrated a
pass. Dry-run pipeline fixtures are not benchmark runs. The mandatory preview
gate must stay in place until the benchmark matrix has been run and a report
from the evaluator is reviewed.

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
