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
    workload: 'build',
    mode: 'sequential',
    success: true,
    startupMs: nvx ? 4000 : 6000,
    endToEndMs: nvx ? 90000 : 100000,
    cleanupMs: 2000,
    peakMemoryMiB: 2000,
    scratchMiB: 500,
    peakPids: 100,
    cpuSeconds: 60,
    assertionFailures: [],
    residue: [],
    ...overrides,
  };
}

function results(nvxOverrides: Partial<RunResult> = {}, count = 30): BenchmarkResults {
  const recoveries = (['nvx', 'cloud-hypervisor'] as const).flatMap((runtime) =>
    (['cancellation', 'stale-recovery'] as const).flatMap((kind) =>
      Array.from({ length: 10 }, () => ({ runtime, kind, durationMs: 5000, residue: [] as string[] })),
    ),
  );
  return {
    runnerClass: 'ubuntu-24.04',
    versions: {},
    runs: [
      ...Array.from({ length: count }, () => run('nvx', nvxOverrides)),
      ...Array.from({ length: 30 }, () => run('cloud-hypervisor')),
    ],
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

  it('stops promotion on cleanup residue', () => {
    const e = evaluate(results({ residue: ['kvm-acl'] }), thresholds);
    expect(e.recommendation).toBe('stop-promotion');
  });

  it('retains preview when there is no data', () => {
    const e = evaluate({ runnerClass: '', versions: {}, runs: [], recoveries: [] }, thresholds);
    expect(e.recommendation).toBe('retain-preview');
  });
});
