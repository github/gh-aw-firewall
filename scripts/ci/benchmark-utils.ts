/**
 * Pure utility functions extracted from benchmark-performance.ts
 * for testability. No Docker/exec dependencies.
 */

// ── Types ─────────────────────────────────────────────────────────

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

// ── Statistics ────────────────────────────────────────────────────

/**
 * Compute mean, median, p95, and p99 for an array of numeric values.
 *
 * - Empty arrays throw an Error (caller must guard).
 * - Values are sorted ascending before computing percentiles.
 * - Percentile indices use Math.floor, clamped to the last element.
 */
export function stats(values: number[]): Pick<BenchmarkResult, "mean" | "median" | "p95" | "p99"> {
  if (values.length === 0) {
    throw new Error("stats() requires at least one value");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / n),
    median: sorted[Math.floor(n / 2)],
    p95: sorted[Math.min(Math.floor(n * 0.95), n - 1)],
    p99: sorted[Math.min(Math.floor(n * 0.99), n - 1)],
  };
}

// ── Memory parsing ───────────────────────────────────────────────

/**
 * Parse a Docker memory usage string like "123.4MiB / 7.773GiB"
 * and return the used amount in MiB (first number only).
 * Note: GiB values are converted to MiB (GiB * 1024), KiB to MiB (KiB / 1024).
 */
export function parseMb(s: string): number {
  const match = s.match(/([\d.]+)\s*(MiB|GiB|KiB)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "gib") return val * 1024;
  if (unit === "kib") return val / 1024;
  return val;
}

// ── Threshold checking ───────────────────────────────────────────

/**
 * Compare benchmark results against critical thresholds.
 * Returns an array of human-readable regression descriptions.
 */
export function checkRegressions(
  results: BenchmarkResult[],
  thresholds: Record<string, { target: number; critical: number }>,
): string[] {
  const regressions: string[] = [];
  for (const r of results) {
    const threshold = thresholds[r.metric];
    if (threshold && r.p95 > threshold.critical) {
      regressions.push(
        `${r.metric}: p95=${r.p95}${r.unit} exceeds critical threshold of ${threshold.critical}${r.unit}`,
      );
    }
  }
  return regressions;
}
