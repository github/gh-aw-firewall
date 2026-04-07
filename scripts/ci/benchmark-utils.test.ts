import { stats, parseMb, checkRegressions, BenchmarkResult } from "./benchmark-utils";

// ── stats() ──────────────────────────────────────────────────────

describe("stats()", () => {
  it("throws on empty array", () => {
    expect(() => stats([])).toThrow("stats() requires at least one value");
  });

  it("handles single element", () => {
    const result = stats([42]);
    expect(result).toEqual({ mean: 42, median: 42, p95: 42, p99: 42 });
  });

  it("handles two elements", () => {
    const result = stats([10, 20]);
    expect(result.mean).toBe(15);
    expect(result.median).toBe(20); // floor(2/2) = index 1
    expect(result.p95).toBe(20);
    expect(result.p99).toBe(20);
  });

  it("handles odd count", () => {
    const result = stats([3, 1, 2]);
    // sorted: [1, 2, 3]
    expect(result.mean).toBe(2);
    expect(result.median).toBe(2); // floor(3/2) = index 1
    expect(result.p95).toBe(3);    // floor(3*0.95)=2, index 2
    expect(result.p99).toBe(3);    // floor(3*0.99)=2, index 2
  });

  it("handles even count", () => {
    const result = stats([4, 2, 1, 3]);
    // sorted: [1, 2, 3, 4]
    expect(result.mean).toBe(3); // Math.round(10/4) = 3 (2.5 rounds to 3)
    expect(result.median).toBe(3); // floor(4/2) = index 2
    expect(result.p95).toBe(4);    // floor(4*0.95)=3
    expect(result.p99).toBe(4);    // floor(4*0.99)=3
  });

  it("handles all same values", () => {
    const result = stats([7, 7, 7, 7, 7]);
    expect(result).toEqual({ mean: 7, median: 7, p95: 7, p99: 7 });
  });

  it("rounds mean correctly", () => {
    // 1 + 2 + 3 = 6 / 3 = 2, no rounding needed
    expect(stats([1, 2, 3]).mean).toBe(2);
    // 1 + 2 = 3 / 2 = 1.5, rounds to 2
    expect(stats([1, 2]).mean).toBe(2);
    // 1 + 2 + 4 = 7 / 3 = 2.333... rounds to 2
    expect(stats([1, 2, 4]).mean).toBe(2);
  });

  it("does not mutate input array", () => {
    const input = [5, 3, 1, 4, 2];
    const copy = [...input];
    stats(input);
    expect(input).toEqual(copy);
  });

  it("handles large array with correct percentiles", () => {
    // 100 values: 1..100
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const result = stats(values);
    expect(result.mean).toBe(51); // Math.round(5050/100)
    expect(result.median).toBe(51); // floor(100/2)=50, value at index 50 = 51
    expect(result.p95).toBe(96);    // floor(100*0.95)=95, value at index 95 = 96
    expect(result.p99).toBe(100);   // floor(100*0.99)=99, value at index 99 = 100
  });

  it("handles negative values", () => {
    const result = stats([-10, -5, 0, 5, 10]);
    expect(result.mean).toBe(0);
    expect(result.median).toBe(0);
  });
});

// ── parseMb() ────────────────────────────────────────────────────

describe("parseMb()", () => {
  it("parses MiB values", () => {
    expect(parseMb("123.4MiB / 7.773GiB")).toBe(123.4);
  });

  it("parses GiB values", () => {
    expect(parseMb("2GiB / 8GiB")).toBe(2048);
  });

  it("parses KiB values", () => {
    expect(parseMb("512KiB / 8GiB")).toBe(0.5);
  });

  it("returns 0 for unrecognized format", () => {
    expect(parseMb("0MiB")).toBe(0);
    expect(parseMb("unknown")).toBe(0);
    expect(parseMb("")).toBe(0);
  });

  it("is case insensitive", () => {
    expect(parseMb("100mib")).toBe(100);
    expect(parseMb("1gib")).toBe(1024);
    expect(parseMb("1024kib")).toBe(1);
  });

  it("handles decimal values", () => {
    expect(parseMb("1.5GiB / 8GiB")).toBe(1536);
    expect(parseMb("0.5MiB / 8GiB")).toBe(0.5);
  });
});

// ── checkRegressions() ──────────────────────────────────────────

describe("checkRegressions()", () => {
  const thresholds: Record<string, { target: number; critical: number }> = {
    container_startup_cold: { target: 15000, critical: 20000 },
    squid_https_latency: { target: 100, critical: 200 },
    memory_footprint_mb: { target: 500, critical: 1024 },
  };

  function makeResult(metric: string, p95: number, unit = "ms"): BenchmarkResult {
    return { metric, unit, values: [p95], mean: p95, median: p95, p95, p99: p95 };
  }

  it("returns empty array when all within thresholds", () => {
    const results = [
      makeResult("container_startup_cold", 19000),
      makeResult("squid_https_latency", 150),
      makeResult("memory_footprint_mb", 800, "MB"),
    ];
    expect(checkRegressions(results, thresholds)).toEqual([]);
  });

  it("detects single regression", () => {
    const results = [
      makeResult("container_startup_cold", 25000),
    ];
    const regressions = checkRegressions(results, thresholds);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toContain("container_startup_cold");
    expect(regressions[0]).toContain("p95=25000");
    expect(regressions[0]).toContain("critical threshold of 20000");
  });

  it("detects multiple regressions", () => {
    const results = [
      makeResult("container_startup_cold", 25000),
      makeResult("squid_https_latency", 300),
    ];
    const regressions = checkRegressions(results, thresholds);
    expect(regressions).toHaveLength(2);
  });

  it("ignores metrics without thresholds", () => {
    const results = [
      makeResult("unknown_metric", 999999),
    ];
    expect(checkRegressions(results, thresholds)).toEqual([]);
  });

  it("p95 exactly at critical is not a regression", () => {
    const results = [
      makeResult("container_startup_cold", 20000),
    ];
    expect(checkRegressions(results, thresholds)).toEqual([]);
  });

  it("p95 one unit above critical is a regression", () => {
    const results = [
      makeResult("container_startup_cold", 20001),
    ];
    expect(checkRegressions(results, thresholds)).toHaveLength(1);
  });

  it("returns empty array for empty results", () => {
    expect(checkRegressions([], thresholds)).toEqual([]);
  });

  it("returns empty array for empty thresholds", () => {
    const results = [makeResult("container_startup_cold", 99999)];
    expect(checkRegressions(results, {})).toEqual([]);
  });

  it("includes unit in regression message", () => {
    const results = [makeResult("memory_footprint_mb", 2000, "MB")];
    const regressions = checkRegressions(results, thresholds);
    expect(regressions[0]).toContain("MB");
  });
});
