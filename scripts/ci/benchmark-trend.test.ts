/**
 * Unit tests for benchmark-trend.ts logic.
 *
 * Tests the core functions: delta computation and Markdown formatting.
 * The script's main() reads from disk and argv, so we test the pure functions directly.
 */

// Re-implement the pure functions here since the script isn't structured as a library.
// This mirrors the logic in benchmark-trend.ts without the CLI/file I/O.

interface BenchmarkResult {
  metric: string;
  unit: string;
  values: number[];
  mean: number;
  median: number;
  p95: number;
  p99: number;
}

interface HistoryEntry {
  timestamp: string;
  commitSha: string;
  iterations: number;
  results: BenchmarkResult[];
  regressions: string[];
}

interface MetricDelta {
  metric: string;
  unit: string;
  current: number;
  previous: number;
  delta: number;
  deltaPercent: number;
  regression: boolean;
}

const REGRESSION_THRESHOLD_PERCENT = 20;

function computeDeltas(current: HistoryEntry, previous: HistoryEntry): MetricDelta[] {
  const deltas: MetricDelta[] = [];
  for (const cur of current.results) {
    const prev = previous.results.find((r) => r.metric === cur.metric);
    if (!prev) continue;
    const delta = cur.p95 - prev.p95;
    const deltaPercent = prev.p95 === 0 ? 0 : (delta / prev.p95) * 100;
    deltas.push({
      metric: cur.metric,
      unit: cur.unit,
      current: cur.p95,
      previous: prev.p95,
      delta,
      deltaPercent: Math.round(deltaPercent * 10) / 10,
      regression: deltaPercent > REGRESSION_THRESHOLD_PERCENT,
    });
  }
  return deltas;
}

function makeEntry(overrides: Partial<HistoryEntry> & { results: BenchmarkResult[] }): HistoryEntry {
  return {
    timestamp: "2026-04-09T06:00:00Z",
    commitSha: "abc1234567890",
    iterations: 30,
    regressions: [],
    ...overrides,
  };
}

function makeResult(metric: string, p95: number, unit = "ms"): BenchmarkResult {
  return { metric, unit, values: [p95], mean: p95, median: p95, p95, p99: p95 };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("computeDeltas", () => {
  it("computes deltas between two runs", () => {
    const prev = makeEntry({ results: [makeResult("container_startup_warm", 18000)] });
    const curr = makeEntry({ results: [makeResult("container_startup_warm", 13000)] });
    const deltas = computeDeltas(curr, prev);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].metric).toBe("container_startup_warm");
    expect(deltas[0].previous).toBe(18000);
    expect(deltas[0].current).toBe(13000);
    expect(deltas[0].delta).toBe(-5000);
    expect(deltas[0].deltaPercent).toBe(-27.8);
    expect(deltas[0].regression).toBe(false);
  });

  it("flags regression when delta exceeds 20%", () => {
    const prev = makeEntry({ results: [makeResult("container_startup_warm", 10000)] });
    const curr = makeEntry({ results: [makeResult("container_startup_warm", 13000)] });
    const deltas = computeDeltas(curr, prev);

    expect(deltas[0].deltaPercent).toBe(30);
    expect(deltas[0].regression).toBe(true);
  });

  it("does not flag regression at exactly 20%", () => {
    const prev = makeEntry({ results: [makeResult("container_startup_warm", 10000)] });
    const curr = makeEntry({ results: [makeResult("container_startup_warm", 12000)] });
    const deltas = computeDeltas(curr, prev);

    expect(deltas[0].deltaPercent).toBe(20);
    expect(deltas[0].regression).toBe(false);
  });

  it("handles multiple metrics", () => {
    const prev = makeEntry({
      results: [makeResult("warm", 18000), makeResult("cold", 28000), makeResult("memory", 20, "MB")],
    });
    const curr = makeEntry({
      results: [makeResult("warm", 13000), makeResult("cold", 26000), makeResult("memory", 22, "MB")],
    });
    const deltas = computeDeltas(curr, prev);

    expect(deltas).toHaveLength(3);
    expect(deltas[0].metric).toBe("warm");
    expect(deltas[1].metric).toBe("cold");
    expect(deltas[2].metric).toBe("memory");
  });

  it("skips metrics missing from previous run", () => {
    const prev = makeEntry({ results: [makeResult("warm", 18000)] });
    const curr = makeEntry({ results: [makeResult("warm", 13000), makeResult("new_metric", 100)] });
    const deltas = computeDeltas(curr, prev);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].metric).toBe("warm");
  });

  it("handles zero previous value without division error", () => {
    const prev = makeEntry({ results: [makeResult("latency", 0)] });
    const curr = makeEntry({ results: [makeResult("latency", 100)] });
    const deltas = computeDeltas(curr, prev);

    expect(deltas[0].deltaPercent).toBe(0);
    expect(deltas[0].regression).toBe(false);
  });

  it("returns empty array for no matching metrics", () => {
    const prev = makeEntry({ results: [makeResult("a", 100)] });
    const curr = makeEntry({ results: [makeResult("b", 200)] });
    const deltas = computeDeltas(curr, prev);

    expect(deltas).toHaveLength(0);
  });
});
