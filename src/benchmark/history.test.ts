import {
  appendToHistory,
  BenchmarkHistory,
  BenchmarkReport,
  compareAgainstBaseline,
  computeRollingMeans,
  HistoryEntry,
  reportToHistoryEntry,
  trendArrow,
} from "./history";

function makeReport(overrides?: Partial<BenchmarkReport>): BenchmarkReport {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    commitSha: "abc123",
    iterations: 5,
    results: [
      { metric: "container_startup_warm", unit: "ms", values: [5000], mean: 5000, median: 5000, p95: 5500, p99: 5800 },
      { metric: "squid_https_latency", unit: "ms", values: [80], mean: 80, median: 80, p95: 90, p99: 95 },
    ],
    thresholds: {
      container_startup_warm: { target: 5000, critical: 8000 },
      squid_https_latency: { target: 100, critical: 200 },
    },
    regressions: [],
    ...overrides,
  };
}

function makeEntry(p95Warm: number, p95Https: number, sha = "aaa"): HistoryEntry {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    commitSha: sha,
    metrics: {
      container_startup_warm: { mean: 5000, median: 5000, p95: p95Warm, p99: 5800, unit: "ms" },
      squid_https_latency: { mean: 80, median: 80, p95: p95Https, p99: 95, unit: "ms" },
    },
  };
}

describe("reportToHistoryEntry", () => {
  it("converts a report to a history entry", () => {
    const report = makeReport();
    const entry = reportToHistoryEntry(report);

    expect(entry.timestamp).toBe("2026-01-01T00:00:00Z");
    expect(entry.commitSha).toBe("abc123");
    expect(entry.metrics["container_startup_warm"].p95).toBe(5500);
    expect(entry.metrics["squid_https_latency"].p95).toBe(90);
  });
});

describe("appendToHistory", () => {
  it("creates new history when null is passed", () => {
    const report = makeReport();
    const result = appendToHistory(null, report);

    expect(result.version).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].commitSha).toBe("abc123");
  });

  it("appends to existing history", () => {
    const existing: BenchmarkHistory = {
      version: 1,
      entries: [makeEntry(5000, 80)],
    };
    const report = makeReport();
    const result = appendToHistory(existing, report);

    expect(result.entries).toHaveLength(2);
  });

  it("trims history to 20 entries", () => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 25; i++) {
      entries.push(makeEntry(5000 + i, 80, `sha-${i}`));
    }
    const existing: BenchmarkHistory = { version: 1, entries };
    const report = makeReport({ commitSha: "latest" });
    const result = appendToHistory(existing, report);

    expect(result.entries).toHaveLength(20);
    // The latest entry should be the one we just appended
    expect(result.entries[result.entries.length - 1].commitSha).toBe("latest");
    // The oldest entries should have been trimmed
    expect(result.entries[0].commitSha).toBe("sha-6");
  });
});

describe("computeRollingMeans", () => {
  it("computes mean p95 across entries", () => {
    const entries = [
      makeEntry(5000, 80),
      makeEntry(6000, 100),
      makeEntry(7000, 120),
    ];
    const means = computeRollingMeans(entries);

    expect(means["container_startup_warm"].meanP95).toBe(6000);
    expect(means["container_startup_warm"].count).toBe(3);
    expect(means["squid_https_latency"].meanP95).toBe(100);
  });

  it("returns empty for no entries", () => {
    const means = computeRollingMeans([]);
    expect(Object.keys(means)).toHaveLength(0);
  });
});

describe("compareAgainstBaseline", () => {
  it("detects regression when p95 > 1.25x rolling mean", () => {
    const history: BenchmarkHistory = {
      version: 1,
      entries: [
        makeEntry(4000, 80),
        makeEntry(4000, 80),
        makeEntry(4000, 80),
      ],
    };
    // Rolling mean p95 for warm = 4000. Current = 5500 (1.375x) -> regression
    const report = makeReport();
    const comparisons = compareAgainstBaseline(report, history);

    const warm = comparisons.find(c => c.metric === "container_startup_warm");
    expect(warm).toBeDefined();
    expect(warm!.regressed).toBe(true);
    expect(warm!.ratio).toBe(1.38);
  });

  it("does not flag regression when within threshold", () => {
    const history: BenchmarkHistory = {
      version: 1,
      entries: [
        makeEntry(5000, 85),
        makeEntry(5200, 90),
        makeEntry(5400, 88),
      ],
    };
    const report = makeReport();
    const comparisons = compareAgainstBaseline(report, history);

    const warm = comparisons.find(c => c.metric === "container_startup_warm");
    expect(warm).toBeDefined();
    expect(warm!.regressed).toBe(false);
  });

  it("returns empty when history has no entries", () => {
    const history: BenchmarkHistory = { version: 1, entries: [] };
    const report = makeReport();
    const comparisons = compareAgainstBaseline(report, history);

    expect(comparisons).toHaveLength(0);
  });

  it("skips metrics with zero rolling mean p95 to avoid division by zero", () => {
    const history: BenchmarkHistory = {
      version: 1,
      entries: [makeEntry(0, 0)],
    };
    const report = makeReport();
    const comparisons = compareAgainstBaseline(report, history);

    // Both metrics have 0 baseline p95, so they should be skipped
    expect(comparisons).toHaveLength(0);
  });

  it("skips metrics with zero current p95", () => {
    const history: BenchmarkHistory = {
      version: 1,
      entries: [makeEntry(5000, 80)],
    };
    const report = makeReport({
      results: [
        { metric: "container_startup_warm", unit: "ms", values: [0], mean: 0, median: 0, p95: 0, p99: 0 },
      ],
    });
    const comparisons = compareAgainstBaseline(report, history);

    expect(comparisons).toHaveLength(0);
  });

  it("skips metrics not in history", () => {
    const history: BenchmarkHistory = {
      version: 1,
      entries: [{
        timestamp: "2026-01-01T00:00:00Z",
        commitSha: "old",
        metrics: {
          some_other_metric: { mean: 100, median: 100, p95: 100, p99: 100, unit: "ms" },
        },
      }],
    };
    const report = makeReport();
    const comparisons = compareAgainstBaseline(report, history);

    expect(comparisons).toHaveLength(0);
  });
});

describe("trendArrow", () => {
  it("returns double up arrow for major regression", () => {
    expect(trendArrow(1.5)).toBe("\u2191\u2191");
  });

  it("returns single up arrow for minor regression", () => {
    expect(trendArrow(1.15)).toBe("\u2191");
  });

  it("returns stable for near-equal", () => {
    expect(trendArrow(1.0)).toBe("\u2194");
  });

  it("returns down arrow for improvement", () => {
    expect(trendArrow(0.85)).toBe("\u2193");
  });

  it("returns double down arrow for major improvement", () => {
    expect(trendArrow(0.7)).toBe("\u2193\u2193");
  });
});
