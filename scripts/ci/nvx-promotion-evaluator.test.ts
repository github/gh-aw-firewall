import * as fs from 'fs';
import * as path from 'path';
import {
  BenchmarkResults,
  RunResult,
  Thresholds,
  evaluate,
  percentile,
} from './nvx-promotion-evaluator';

const thresholds = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'nvx-promotion-thresholds.json'), 'utf8'),
) as Thresholds;

function run(runtime: RunResult['runtime'], overrides: Partial<RunResult> = {}): RunResult {
  const nvx = runtime === 'nvx';
  return {
    runtime,
    workload: 'build-test',
    mode: 'sequential',
    cache: 'cold',
    resourceProfile: 'minimum',
    success: true,
    artifactPreflightMs: 1000,
    startupMs: nvx ? 4000 : 6000,
    firstWorkloadMs: nvx ? 20000 : 25000,
    endToEndMs: nvx ? 90000 : 100000,
    cleanupMs: 2000,
    peakMemoryMiB: 2000,
    scratchMiB: 500,
    hostDiskMiB: 1000,
    peakPids: 100,
    cpuSeconds: 60,
    apiProxyRequests: 10,
    inputTokens: 1000,
    outputTokens: 500,
    assertionFailures: [],
    residue: [],
    ...overrides,
  };
}

function results(nvxOverrides: Partial<RunResult> = {}, count = 30): BenchmarkResults {
  const recoveries = (['nvx', 'cloud-hypervisor'] as const).flatMap((runtime) =>
    (['cancellation', 'stale-recovery'] as const).flatMap((kind) =>
      Array.from({ length: 10 }, () => ({
        runtime,
        kind,
        success: true,
        durationMs: 5000,
        assertionFailures: [] as string[],
        residue: [] as string[],
      })),
    ),
  );
  return {
    runnerClass: 'ubuntu-24.04',
    runnerImage: 'ubuntu24',
    versions: { ...thresholds.baseline },
    runs: (['nvx', 'cloud-hypervisor'] as const).flatMap((runtime) =>
      thresholds.matrix.workloads.flatMap((workload) =>
        thresholds.matrix.modes.flatMap((mode) =>
          thresholds.matrix.caches.flatMap((cache) =>
            thresholds.matrix.resourceProfiles.flatMap((resourceProfile) =>
              Array.from({ length: mode === 'sequential' ? count : 10 }, () =>
                run(runtime, {
                  workload,
                  mode,
                  cache,
                  resourceProfile,
                  ...(runtime === 'nvx' ? nvxOverrides : {}),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
    recoveries,
  };
}

describe('nvx promotion evaluator', () => {
  it('computes nearest-rank percentiles', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile([], 50)).toBeNaN();
  });

  it('promotes only when every gate passes', () => {
    const e = evaluate(results(), thresholds);
    expect(e.unmetGates).toEqual([]);
    expect(e.recommendation).toBe('promote');
  });

  it('retains preview when sample size is insufficient', () => {
    const e = evaluate(results({}, 5), thresholds);
    expect(e.recommendation).toBe('retain-preview');
    expect(e.unmetGates.join('\n')).toContain('sample size 5');
  });

  it('requires every fixed workload, cache, mode, and resource-profile lane', () => {
    const incomplete = results();
    incomplete.runs = incomplete.runs.filter((r) =>
      !(r.workload === 'copilot-inference' && r.mode === 'concurrent' && r.cache === 'warm' && r.resourceProfile === 'elevated'),
    );
    const e = evaluate(incomplete, thresholds);
    expect(e.recommendation).toBe('retain-preview');
    expect(e.unmetGates.join('\n')).toContain('copilot-inference/concurrent/warm/elevated: sample size 0');
  });

  it('retains preview when there is no measurable advantage over Cloud Hypervisor', () => {
    const e = evaluate(results({ startupMs: 6000, endToEndMs: 100000 }), thresholds);
    expect(e.recommendation).toBe('retain-preview');
    expect(e.unmetGates.join('\n')).toContain('no metric shows');
  });

  it('retains preview when a latency threshold is exceeded', () => {
    const e = evaluate(results({ startupMs: 30000 }), thresholds);
    expect(e.recommendation).toBe('retain-preview');
  });

  it('stops promotion on any security assertion failure regardless of performance', () => {
    const e = evaluate(results({ assertionFailures: ['credentialIsolation'] }), thresholds);
    expect(e.recommendation).toBe('stop-promotion');
  });

  it('stops promotion when either runtime fails to prove resource limits', () => {
    const input = results();
    input.runs.find((run) => run.runtime === 'cloud-hypervisor')!.assertionFailures = [
      'resourceLimitsEnforced',
    ];
    expect(evaluate(input, thresholds).recommendation).toBe('stop-promotion');
  });

  it('stops promotion on cleanup residue', () => {
    const e = evaluate(results({ residue: ['kvm-acl'] }), thresholds);
    expect(e.recommendation).toBe('stop-promotion');
  });

  it('retains preview when there is no data', () => {
    const e = evaluate({ runnerClass: '', runnerImage: '', versions: {}, runs: [], recoveries: [] }, thresholds);
    expect(e.recommendation).toBe('retain-preview');
  });

  it('retains preview when runner class is unapproved or baseline versions differ', () => {
    const input = results();
    input.runnerClass = 'unapproved-runner';
    input.versions.awf = 'stale';
    const e = evaluate(input, thresholds);
    expect(e.recommendation).toBe('retain-preview');
    expect(e.unmetGates.join('\n')).toContain('runner class');
    expect(e.unmetGates.join('\n')).toContain('baseline awf');
  });

  it('retains preview when runner image family is missing, malformed, or unapproved', () => {
    const missingImage = results();
    delete (missingImage as Partial<BenchmarkResults>).runnerImage;
    const missingImageEvaluation = evaluate(missingImage, thresholds);
    expect(missingImageEvaluation.recommendation).toBe('retain-preview');
    expect(missingImageEvaluation.unmetGates.join('\n')).toContain('runner image');

    for (const runnerImage of ['', 'ubuntu24/patch/extra', 'ubuntu22/20261005.85']) {
      const input = results();
      input.runnerImage = runnerImage;
      const e = evaluate(input, thresholds);
      expect(e.recommendation).toBe('retain-preview');
      expect(e.unmetGates.join('\n')).toContain('runner image');
    }
  });

  it('stops promotion when any recovery fails or a lifecycle assertion fails', () => {
    const failedRecovery = results();
    failedRecovery.recoveries[0].success = false;
    expect(evaluate(failedRecovery, thresholds).recommendation).toBe('stop-promotion');

    const assertionFailure = results();
    assertionFailure.recoveries[0].assertionFailures = ['cleanup'];
    expect(evaluate(assertionFailure, thresholds).recommendation).toBe('stop-promotion');
  });

  it('retains preview when documented per-run evidence is missing or invalid', () => {
    const missingEvidence = results();
    missingEvidence.runs[0].hostDiskMiB = Number.NaN;
    const e = evaluate(missingEvidence, thresholds);
    expect(e.recommendation).toBe('retain-preview');
    expect(e.unmetGates.join('\n')).toContain('invalid or missing hostDiskMiB');
  });
});
