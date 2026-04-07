/**
 * Benchmark history management: append results, trim to max entries,
 * and compute rolling statistics for regression detection.
 */

export interface BenchmarkResult {
  metric: string;
  unit: string;
  values: number[];
  mean: number;
  median: number;
  p95: number;
  p99: number;
}

export interface BenchmarkReport {
  timestamp: string;
  commitSha: string;
  iterations: number;
  results: BenchmarkResult[];
  thresholds: Record<string, { target: number; critical: number }>;
  regressions: string[];
}

export interface HistoryEntry {
  timestamp: string;
  commitSha: string;
  metrics: Record<string, { mean: number; median: number; p95: number; p99: number; unit: string }>;
}

export interface BenchmarkHistory {
  version: 1;
  entries: HistoryEntry[];
}

export interface RollingComparison {
  metric: string;
  currentP95: number;
  rollingMeanP95: number;
  ratio: number;
  unit: string;
  regressed: boolean;
}

const MAX_HISTORY_ENTRIES = 20;
const REGRESSION_THRESHOLD = 1.25; // 25% slower than rolling mean

/**
 * Convert a BenchmarkReport to a HistoryEntry.
 */
export function reportToHistoryEntry(report: BenchmarkReport): HistoryEntry {
  const metrics: HistoryEntry["metrics"] = {};
  for (const r of report.results) {
    metrics[r.metric] = {
      mean: r.mean,
      median: r.median,
      p95: r.p95,
      p99: r.p99,
      unit: r.unit,
    };
  }
  return {
    timestamp: report.timestamp,
    commitSha: report.commitSha,
    metrics,
  };
}

/**
 * Append current results to history and trim to the last MAX_HISTORY_ENTRIES.
 */
export function appendToHistory(
  history: BenchmarkHistory | null,
  report: BenchmarkReport,
): BenchmarkHistory {
  const existing: BenchmarkHistory = history ?? { version: 1, entries: [] };
  const entry = reportToHistoryEntry(report);
  const entries = [...existing.entries, entry].slice(-MAX_HISTORY_ENTRIES);
  return { version: 1, entries };
}

/**
 * Compute rolling mean of p95 values for each metric from history entries.
 */
export function computeRollingMeans(
  entries: HistoryEntry[],
): Record<string, { meanP95: number; count: number; unit: string }> {
  const accum: Record<string, { sum: number; count: number; unit: string }> = {};

  for (const entry of entries) {
    for (const [metric, data] of Object.entries(entry.metrics)) {
      if (!accum[metric]) {
        accum[metric] = { sum: 0, count: 0, unit: data.unit };
      }
      accum[metric].sum += data.p95;
      accum[metric].count += 1;
    }
  }

  const result: Record<string, { meanP95: number; count: number; unit: string }> = {};
  for (const [metric, data] of Object.entries(accum)) {
    result[metric] = {
      meanP95: Math.round(data.sum / data.count),
      count: data.count,
      unit: data.unit,
    };
  }
  return result;
}

/**
 * Compare current report against historical rolling means.
 * Returns per-metric comparison with regression flag.
 */
export function compareAgainstBaseline(
  report: BenchmarkReport,
  history: BenchmarkHistory,
): RollingComparison[] {
  if (history.entries.length === 0) {
    return [];
  }

  const rolling = computeRollingMeans(history.entries);
  const comparisons: RollingComparison[] = [];

  for (const result of report.results) {
    const baseline = rolling[result.metric];
    if (!baseline || baseline.count === 0) {
      continue;
    }

    const ratio = result.p95 / baseline.meanP95;
    comparisons.push({
      metric: result.metric,
      currentP95: result.p95,
      rollingMeanP95: baseline.meanP95,
      ratio: Math.round(ratio * 100) / 100,
      unit: result.unit,
      regressed: ratio > REGRESSION_THRESHOLD,
    });
  }

  return comparisons;
}

/**
 * Format a trend arrow for a ratio value.
 */
export function trendArrow(ratio: number): string {
  if (ratio > REGRESSION_THRESHOLD) return "\u2191\u2191"; // double up arrow (regression)
  if (ratio > 1.1) return "\u2191";   // up arrow (slightly slower)
  if (ratio < 0.75) return "\u2193\u2193"; // double down arrow (much faster)
  if (ratio < 0.9) return "\u2193";   // down arrow (faster)
  return "\u2194";                      // left-right arrow (stable)
}
