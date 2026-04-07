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

import { execSync, ExecSyncOptions, spawn, ChildProcess } from "child_process";
import { stats, parseMb, checkRegressions, BenchmarkResult, BenchmarkReport } from "./benchmark-utils";
import * as fs from "fs";
import { BenchmarkHistory, compareAgainstBaseline, trendArrow } from "../../src/benchmark/history";

// ── Configuration ──────────────────────────────────────────────────

const ITERATIONS = 5;
const AWF_CMD = "sudo awf";
const ALLOWED_DOMAIN = "api.github.com";
const CLEANUP_CMD = "sudo docker compose down -v 2>/dev/null; sudo docker rm -f awf-squid awf-agent 2>/dev/null; sudo docker network prune -f 2>/dev/null";

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
  return (execSync(cmd, { encoding: "utf-8", timeout: 120_000, ...opts }) ?? "").trim();
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return Math.round(performance.now() - start);
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

/**
 * Wait for Docker containers to be running, polling at 500ms intervals.
 * Uses exact name matching (anchored regex) to avoid false positives from
 * containers with similar names (e.g., "awf-squid-old").
 * Throws if containers are not running within timeoutMs.
 */
function waitForContainers(containerNames: string[], timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Containers not running after ${timeoutMs}ms`));
        return;
      }
      try {
        const allRunning = containerNames.every((name) => {
          const result = execSync(
            `sudo docker ps --filter name=^${name}$ --filter status=running --format '{{.Names}}' 2>/dev/null`,
            { encoding: "utf-8", timeout: 5_000 }
          )
            .trim()
            .split("\n")
            .map((n) => n.trim())
            .filter(Boolean);
          return result.some((n) => n === name);
        });
        if (allRunning) {
          resolve();
          return;
        }
      } catch {
        // container not ready yet
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

/**
 * Kill a spawned background process and its entire process group, best-effort.
 * Sends SIGTERM then SIGKILL to the process group so descendant processes
 * (e.g., sudo, awf, docker) don't survive.
 */
function killBackground(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;

  try {
    // SIGTERM the process group to allow graceful shutdown
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process group may have already exited
  }

  try {
    // SIGKILL the entire process group to ensure nothing survives
    process.kill(-pid, "SIGKILL");
  } catch {
    // Process group may have already exited
  }
}

async function benchmarkMemory(): Promise<BenchmarkResult> {
  console.error("  Benchmarking memory footprint...");
  const values: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    cleanup();
    let child: ChildProcess | null = null;
    try {
      // Start awf with a long-running command in the background so containers stay alive.
      // Derive spawn args from AWF_CMD to stay consistent with the rest of the script.
      const awfParts = AWF_CMD.split(/\s+/);
      child = spawn(
        awfParts[0],
        [...awfParts.slice(1), "--allow-domains", ALLOWED_DOMAIN, "--log-level", "error", "--", "sleep", "30"],
        {
          detached: true,
          stdio: "ignore",
        }
      );
      // Unref so the parent process won't be kept alive if cleanup fails
      child.unref();

      // Wait for both containers to be running (up to 30s)
      await waitForContainers(["awf-squid", "awf-agent"], 30_000);

      // Give containers a moment to stabilize memory usage
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get memory stats while containers are alive
      const squidMem = exec(
        "sudo docker stats awf-squid --no-stream --format '{{.MemUsage}}' 2>/dev/null || echo '0MiB'"
      );
      const agentMem = exec(
        "sudo docker stats awf-agent --no-stream --format '{{.MemUsage}}' 2>/dev/null || echo '0MiB'"
      );

      const totalMb = Math.round(parseMb(squidMem) + parseMb(agentMem));
      values.push(totalMb);
      console.error(`    Iteration ${i + 1}/${ITERATIONS}: ${totalMb}MB (squid: ${squidMem}, agent: ${agentMem})`);
    } catch (err) {
      console.error(`    Iteration ${i + 1}/${ITERATIONS}: failed (skipped) - ${err}`);
    } finally {
      // Always clean up the background process and containers
      if (child) {
        killBackground(child);
      }
      cleanup();
    }
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

function parseBaselineArg(): string | null {
  const idx = process.argv.indexOf("--baseline");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return null;
}

async function main(): Promise<void> {
  const commitSha = exec("git rev-parse HEAD");
  const baselinePath = parseBaselineArg();

  console.error(`AWF Performance Benchmark`);
  console.error(`  Commit: ${commitSha}`);
  console.error(`  Iterations: ${ITERATIONS}`);
  if (baselinePath) {
    console.error(`  Baseline: ${baselinePath}`);
  }
  console.error("");

  const results: BenchmarkResult[] = [];

  results.push(benchmarkNetworkCreation());
  results.push(benchmarkWarmStart());
  results.push(benchmarkColdStart());
  results.push(benchmarkHttpsLatency());
  results.push(await benchmarkMemory());

  // Final cleanup
  cleanup();

  // Check for regressions against critical thresholds
  const regressions = checkRegressions(results, THRESHOLDS);

  // Check for relative regressions against historical baseline
  let history: BenchmarkHistory | null = null;
  if (baselinePath && fs.existsSync(baselinePath)) {
    try {
      history = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    } catch (err) {
      console.error(`Warning: could not parse baseline file: ${err}`);
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

  if (history && history.entries.length > 0) {
    const comparisons = compareAgainstBaseline(report, history);
    console.error("Historical comparison (current p95 vs rolling mean p95):");
    for (const c of comparisons) {
      const arrow = trendArrow(c.ratio);
      console.error(
        `  ${arrow} ${c.metric}: ${c.currentP95}${c.unit} vs ${c.rollingMeanP95}${c.unit} avg (${c.ratio}x)`
      );
      if (c.regressed) {
        regressions.push(
          `${c.metric}: p95=${c.currentP95}${c.unit} is ${c.ratio}x the historical average of ${c.rollingMeanP95}${c.unit} (>1.25x threshold)`
        );
      }
    }
    // Update regressions in report after relative check
    report.regressions = regressions;
  } else if (baselinePath) {
    console.error("No historical baseline data available, skipping relative comparison.");
  }

  // Output JSON to stdout
  console.log(JSON.stringify(report, null, 2));

  if (regressions.length > 0) {
    console.error("");
    console.error("Performance regressions detected:");
    for (const r of regressions) {
      console.error(`  - ${r}`);
    }
    process.exit(1);
  } else {
    console.error("");
    console.error("All metrics within acceptable thresholds.");
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
