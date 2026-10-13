/**
 * NVX Phase 4 promotion evaluator.
 *
 * Reads machine-readable benchmark results for NVX and Cloud Hypervisor,
 * applies docs/nvx-promotion-thresholds.json, and prints a go/no-go decision.
 * Usage: ts-node scripts/ci/nvx-promotion-evaluator.ts <results.json> [thresholds.json]
 */
import * as fs from 'fs';
import * as path from 'path';

export type Runtime = 'nvx' | 'cloud-hypervisor';
export type Mode = 'sequential' | 'concurrent';
export type Recommendation = 'promote' | 'retain-preview' | 'stop-promotion';

export interface RunResult {
  runtime: Runtime;
  workload: string;
  mode: Mode;
  success: boolean;
  startupMs: number;
  endToEndMs: number;
  cleanupMs: number;
  peakMemoryMiB: number;
  scratchMiB: number;
  peakPids: number;
  cpuSeconds: number;
  /** Failed zero-tolerance assertion names (see thresholds.zeroTolerance). */
  assertionFailures: string[];
  /** Leaked process/mount/netns/cgroup/run-dir/scratch/snapshot/record/ACL entries. */
  residue: string[];
}

export interface RecoveryResult {
  runtime: Runtime;
  kind: 'cancellation' | 'stale-recovery';
  durationMs: number;
  residue: string[];
}

export interface BenchmarkResults {
  runnerClass: string;
  versions: Record<string, string>;
  runs: RunResult[];
  recoveries: RecoveryResult[];
}

type Percentiles = { p50?: number; p95?: number };

export interface Thresholds {
  sample: {
    minSequentialRunsPerLaneRuntime: number;
    minConcurrentRunsPerLaneRuntime: number;
    minRecoverySamplesPerKindRuntime: number;
  };
  absolute: {
    minSuccessRate: number;
    startupMs: Percentiles;
    endToEndMs: Percentiles;
    peakMemoryMiB: Percentiles;
    scratchMiB: Percentiles;
    peakPids: Percentiles;
    cleanupMs: Percentiles;
    cancellationMs: Percentiles;
    staleRecoveryMs: Percentiles;
  };
  relativeToCloudHypervisor: {
    minimumAdvantage: number;
    advantageMetrics: string[];
    maxRegression: number;
    regressionMetrics: string[];
    maxSuccessRateDeficit: number;
  };
  zeroTolerance: string[];
}

export interface Evaluation {
  recommendation: Recommendation;
  /** Automatic no-go conditions (security/cleanup regressions). */
  blockers: string[];
  /** Unmet gates that each require a follow-up issue. */
  unmetGates: string[];
  summary: Record<string, Record<string, number>>;
}

/** Nearest-rank percentile; deterministic and conservative for small samples. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const METRICS = ['startupMs', 'endToEndMs', 'cleanupMs', 'peakMemoryMiB', 'scratchMiB', 'peakPids', 'cpuSeconds'] as const;

function lanes(runs: RunResult[]): string[] {
  return [...new Set(runs.map((r) => `${r.workload}/${r.mode}`))].sort();
}

function metricValue(summary: Record<string, number>, key: string): number | undefined {
  return summary[key];
}

function summarize(runs: RunResult[]): Record<string, number> {
  const out: Record<string, number> = { runs: runs.length };
  out.successRate = runs.length === 0 ? 0 : runs.filter((r) => r.success).length / runs.length;
  const ok = runs.filter((r) => r.success);
  for (const metric of METRICS) {
    const values = ok.map((r) => r[metric]);
    out[`${metric}.p50`] = percentile(values, 50);
    out[`${metric}.p95`] = percentile(values, 95);
  }
  return out;
}

export function evaluate(results: BenchmarkResults, thresholds: Thresholds): Evaluation {
  const blockers: string[] = [];
  const unmetGates: string[] = [];
  const summary: Record<string, Record<string, number>> = {};
  const runtimes: Runtime[] = ['nvx', 'cloud-hypervisor'];
  const abs = thresholds.absolute;
  const rel = thresholds.relativeToCloudHypervisor;

  // Zero-tolerance gates apply to every run, including failed runs.
  for (const run of results.runs) {
    for (const name of run.assertionFailures) {
      if (run.runtime === 'nvx' || thresholds.zeroTolerance.includes(name)) {
        blockers.push(`${run.runtime}/${run.workload}/${run.mode}: assertion failed: ${name}`);
      }
    }
    if (run.residue.length > 0) {
      blockers.push(`${run.runtime}/${run.workload}/${run.mode}: residue: ${run.residue.join(',')}`);
    }
  }
  for (const rec of results.recoveries) {
    if (rec.residue.length > 0) {
      blockers.push(`${rec.runtime}/${rec.kind}: residue: ${rec.residue.join(',')}`);
    }
  }

  const allLanes = lanes(results.runs);
  for (const lane of allLanes) {
    const [workload, mode] = lane.split('/');
    const minRuns = mode === 'concurrent'
      ? thresholds.sample.minConcurrentRunsPerLaneRuntime
      : thresholds.sample.minSequentialRunsPerLaneRuntime;
    for (const runtime of runtimes) {
      const laneRuns = results.runs.filter((r) => r.runtime === runtime && r.workload === workload && r.mode === mode);
      const s = summarize(laneRuns);
      summary[`${runtime}:${lane}`] = s;
      if (laneRuns.length < minRuns) {
        unmetGates.push(`${runtime}:${lane}: sample size ${laneRuns.length} < ${minRuns}`);
        continue;
      }
      if (runtime === 'nvx') {
        if (s.successRate < abs.minSuccessRate) {
          unmetGates.push(`nvx:${lane}: success rate ${s.successRate.toFixed(3)} < ${abs.minSuccessRate}`);
        }
        const limits: Array<[string, Percentiles]> = [
          ['startupMs', abs.startupMs],
          ['endToEndMs', abs.endToEndMs],
          ['peakMemoryMiB', abs.peakMemoryMiB],
          ['scratchMiB', abs.scratchMiB],
          ['peakPids', abs.peakPids],
          ['cleanupMs', abs.cleanupMs],
        ];
        for (const [metric, limit] of limits) {
          for (const p of ['p50', 'p95'] as const) {
            const max = limit[p];
            const value = metricValue(s, `${metric}.${p}`);
            if (max !== undefined && (value === undefined || !(value <= max))) {
              unmetGates.push(`nvx:${lane}: ${metric}.${p} ${value} > ${max}`);
            }
          }
        }
      }
    }
    checkRelative(lane, summary, rel, unmetGates);
  }
  if (allLanes.length === 0) unmetGates.push('no benchmark runs supplied');

  for (const runtime of runtimes) {
    for (const kind of ['cancellation', 'stale-recovery'] as const) {
      const samples = results.recoveries.filter((r) => r.runtime === runtime && r.kind === kind);
      if (samples.length < thresholds.sample.minRecoverySamplesPerKindRuntime) {
        unmetGates.push(`${runtime}:${kind}: sample size ${samples.length} < ${thresholds.sample.minRecoverySamplesPerKindRuntime}`);
        continue;
      }
      if (runtime !== 'nvx') continue;
      const limit = kind === 'cancellation' ? abs.cancellationMs : abs.staleRecoveryMs;
      const p95 = percentile(samples.map((s) => s.durationMs), 95);
      if (limit.p95 !== undefined && p95 > limit.p95) {
        unmetGates.push(`nvx:${kind}: p95 ${p95}ms > ${limit.p95}ms`);
      }
    }
  }

  const recommendation: Recommendation = blockers.length > 0
    ? 'stop-promotion'
    : unmetGates.length > 0 ? 'retain-preview' : 'promote';
  return { recommendation, blockers, unmetGates, summary };
}

function checkRelative(
  lane: string,
  summary: Record<string, Record<string, number>>,
  rel: Thresholds['relativeToCloudHypervisor'],
  unmetGates: string[],
): void {
  const nvx = summary[`nvx:${lane}`];
  const ch = summary[`cloud-hypervisor:${lane}`];
  if (!nvx || !ch || nvx.runs === 0 || ch.runs === 0) return;
  if (ch.successRate - nvx.successRate > rel.maxSuccessRateDeficit) {
    unmetGates.push(`${lane}: nvx success rate below cloud-hypervisor`);
  }
  for (const key of rel.regressionMetrics) {
    if (nvx[key] > ch[key] * (1 + rel.maxRegression)) {
      unmetGates.push(`${lane}: ${key} regresses vs cloud-hypervisor by more than ${rel.maxRegression * 100}%`);
    }
  }
  const advantaged = rel.advantageMetrics.some((key) => nvx[key] <= ch[key] * (1 - rel.minimumAdvantage));
  if (!advantaged) {
    unmetGates.push(`${lane}: no metric shows >=${rel.minimumAdvantage * 100}% advantage over cloud-hypervisor`);
  }
}

function main(): void {
  const [resultsPath, thresholdsPath] = process.argv.slice(2);
  if (!resultsPath) {
    console.error('usage: nvx-promotion-evaluator <results.json> [thresholds.json]');
    process.exit(2);
  }
  const defaultThresholds = path.join(__dirname, '..', '..', 'docs', 'nvx-promotion-thresholds.json');
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as BenchmarkResults;
  const thresholds = JSON.parse(fs.readFileSync(thresholdsPath ?? defaultThresholds, 'utf8')) as Thresholds;
  const evaluation = evaluate(results, thresholds);
  process.stdout.write(`${JSON.stringify({ runnerClass: results.runnerClass, versions: results.versions, ...evaluation, summary: evaluation.summary }, null, 2)}\n`);
  process.exit(evaluation.recommendation === 'promote' ? 0 : 1);
}

if (require.main === module) main();
