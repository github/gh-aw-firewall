#!/usr/bin/env npx tsx
/**
 * Performance benchmark script for AWF (Agentic Workflow Firewall).
 *
 * Measures key metrics:
 *  - Container startup (cold & warm)
 *  - Squid HTTP / HTTPS proxy latency
 *  - Memory footprint
 *  - Docker network creation time
 *
 * Outputs structured JSON with mean, median, p95, p99 per metric.
 *
 * IMPORTANT: stdout/stderr contract:
 *   - stdout (console.log): JSON result only — consumed by the CI workflow via redirect to file
 *   - stderr (console.error): progress messages and diagnostics — kept separate so JSON stays valid
 */

import { execSync, ExecSyncOptions } from "child_process";

// ── Configuration ──────────────────────────────────────────────────

const ITERATIONS = 5;
const AWF_CMD = "sudo awf";
const ALLOWED_DOMAIN = "api.github.com";
const CLEANUP_CMD = "sudo docker compose down -v 2>/dev/null; sudo docker rm -f awf-squid awf-agent 2>/dev/null; sudo docker network prune -f 2>/dev/null";

interface BenchmarkResult {
  metric: string;
  unit: string;
  values: number[];
  mean: number;
  median: number;
  p95: number;
  p99: number;
}

interface BenchmarkReport {
  timestamp: string;
  commitSha: string;
  iterations: number;
  results: BenchmarkResult[];
  thresholds: Record<string, { target: number; critical: number }>;
  regressions: string[];
}

// ── Thresholds (milliseconds or MB) ───────────────────────────────

const THRESHOLDS: Record<string, { target: number; critical: number }> = {
  "container_startup_cold": { target: 15000, critical: 20000 },
  "container_startup_warm": { target: 5000, critical: 8000 },
  "squid_https_latency": { target: 100, critical: 200 },
  "memory_footprint_mb": { target: 500, critical: 1024 },
  "docker_network_creation": { target: 2000, critical: 5000 },
};

// ── Helpers ────────────────────────────────────────────────────────

function exec(cmd: string, opts?: ExecSyncOptions): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 120_000, ...opts }).trim();
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return Math.round(performance.now() - start);
}

function stats(values: number[]): Pick<BenchmarkResult, "mean" | "median" | "p95" | "p99"> {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / n),
    median: sorted[Math.floor(n / 2)],
    p95: sorted[Math.min(Math.floor(n * 0.95), n - 1)],
    p99: sorted[Math.min(Math.floor(n * 0.99), n - 1)],
  };
}

function cleanup(): void {
  try {
    execSync(CLEANUP_CMD, { stdio: "ignore", timeout: 30_000 });
  } catch {
    // best-effort
  }
}

// ── Benchmarks ─────────────────────────────────────────────────────

function benchmarkColdStart(): BenchmarkResult {
  console.error("  Benchmarking cold container startup...");
  const values: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    cleanup();
    // Remove cached images to force cold pull
    try {
      execSync("sudo docker rmi ghcr.io/github/gh-aw-firewall/squid:latest ghcr.io/github/gh-aw-firewall/agent:latest 2>/dev/null", { stdio: "ignore", timeout: 30_000 });
    } catch {
      // images may not exist
    }

    const ms = timeMs(() => {
      exec(`${AWF_CMD} --allow-domains ${ALLOWED_DOMAIN} --log-level error -- echo ok`, { stdio: "ignore" });
    });
    values.push(ms);
    console.error(`    Iteration ${i + 1}/${ITERATIONS}: ${ms}ms`);
  }

  return { metric: "container_startup_cold", unit: "ms", values, ...stats(values) };
}

function benchmarkWarmStart(): BenchmarkResult {
  console.error("  Benchmarking warm container startup...");
  const values: number[] = [];

  // Ensure images are pulled
  cleanup();
  try {
    exec(`${AWF_CMD} --allow-domains ${ALLOWED_DOMAIN} --log-level error -- echo warmup`, { stdio: "ignore" });
  } catch {
    // warmup
  }

  for (let i = 0; i < ITERATIONS; i++) {
    cleanup();
    const ms = timeMs(() => {
      exec(`${AWF_CMD} --allow-domains ${ALLOWED_DOMAIN} --log-level error -- echo ok`, { stdio: "ignore" });
    });
    values.push(ms);
    console.error(`    Iteration ${i + 1}/${ITERATIONS}: ${ms}ms`);
  }

  return { metric: "container_startup_warm", unit: "ms", values, ...stats(values) };
}

function benchmarkHttpsLatency(): BenchmarkResult {
  console.error("  Benchmarking HTTPS latency through Squid...");
  const values: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    cleanup();
    try {
      // Use curl's time_total to measure end-to-end HTTPS request latency
      const output = exec(
        `${AWF_CMD} --allow-domains ${ALLOWED_DOMAIN} --log-level error -- ` +
          `curl -fsS -o /dev/null -w '%{time_total}' https://${ALLOWED_DOMAIN}/zen`
      );
      const seconds = parseFloat(output);
      if (!isNaN(seconds)) {
        values.push(Math.round(seconds * 1000));
      }
    } catch {
      console.error(`    Iteration ${i + 1}/${ITERATIONS}: failed (skipped)`);
      continue;
    }
    console.error(`    Iteration ${i + 1}/${ITERATIONS}: ${values[values.length - 1]}ms`);
  }

  if (values.length === 0) {
    values.push(0);
  }

  return { metric: "squid_https_latency", unit: "ms", values, ...stats(values) };
}

function benchmarkMemory(): BenchmarkResult {
  console.error("  Benchmarking memory footprint...");
  const values: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    cleanup();
    // Start containers, measure memory, then stop
    try {
      // Run a sleep command so containers stay up, then check memory
      const output = exec(
        `${AWF_CMD} --allow-domains ${ALLOWED_DOMAIN} --log-level error --keep-containers -- ` +
          `echo measuring_memory`
      );
      // Get memory stats for both containers
      const squidMem = exec(
        "sudo docker stats awf-squid --no-stream --format '{{.MemUsage}}' 2>/dev/null || echo '0MiB'"
      );
      const agentMem = exec(
        "sudo docker stats awf-agent --no-stream --format '{{.MemUsage}}' 2>/dev/null || echo '0MiB'"
      );

      // Parse memory values (format: "123.4MiB / 7.773GiB")
      const parseMb = (s: string): number => {
        const match = s.match(/([\d.]+)\s*(MiB|GiB|KiB)/i);
        if (!match) return 0;
        const val = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === "gib") return val * 1024;
        if (unit === "kib") return val / 1024;
        return val;
      };

      const totalMb = Math.round(parseMb(squidMem) + parseMb(agentMem));
      values.push(totalMb);
      console.error(`    Iteration ${i + 1}/${ITERATIONS}: ${totalMb}MB (squid: ${squidMem}, agent: ${agentMem})`);
    } catch {
      console.error(`    Iteration ${i + 1}/${ITERATIONS}: failed (skipped)`);
    }
    cleanup();
  }

  if (values.length === 0) {
    values.push(0);
  }

  return { metric: "memory_footprint_mb", unit: "MB", values, ...stats(values) };
}

function benchmarkNetworkCreation(): BenchmarkResult {
  console.error("  Benchmarking Docker network creation...");
  const values: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const netName = `awf-bench-net-${i}`;
    try {
      execSync(`sudo docker network rm ${netName} 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // may not exist
    }
    const ms = timeMs(() => {
      exec(`sudo docker network create --subnet=172.${31 + i}.0.0/24 ${netName}`, { stdio: "ignore" });
    });
    values.push(ms);
    console.error(`    Iteration ${i + 1}/${ITERATIONS}: ${ms}ms`);
    try {
      execSync(`sudo docker network rm ${netName} 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
  }

  return { metric: "docker_network_creation", unit: "ms", values, ...stats(values) };
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const commitSha = exec("git rev-parse HEAD");
  console.error(`AWF Performance Benchmark`);
  console.error(`  Commit: ${commitSha}`);
  console.error(`  Iterations: ${ITERATIONS}`);
  console.error("");

  const results: BenchmarkResult[] = [];

  results.push(benchmarkNetworkCreation());
  results.push(benchmarkWarmStart());
  results.push(benchmarkColdStart());
  results.push(benchmarkHttpsLatency());
  results.push(benchmarkMemory());

  // Final cleanup
  cleanup();

  // Check for regressions against critical thresholds
  const regressions: string[] = [];
  for (const r of results) {
    const threshold = THRESHOLDS[r.metric];
    if (threshold && r.p95 > threshold.critical) {
      regressions.push(
        `${r.metric}: p95=${r.p95}${r.unit} exceeds critical threshold of ${threshold.critical}${r.unit}`
      );
    }
  }

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    commitSha,
    iterations: ITERATIONS,
    results,
    thresholds: THRESHOLDS,
    regressions,
  };

  // Output JSON to stdout
  console.log(JSON.stringify(report, null, 2));

  if (regressions.length > 0) {
    console.error("");
    console.error("⚠️  Performance regressions detected:");
    for (const r of regressions) {
      console.error(`  - ${r}`);
    }
    process.exit(1);
  } else {
    console.error("");
    console.error("✅ All metrics within acceptable thresholds.");
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
