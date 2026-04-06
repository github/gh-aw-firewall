#!/usr/bin/env -S npx tsx
/**
 * Benchmark trend reporter for AWF (Agentic Workflow Firewall).
 *
 * Reads benchmarks/history.json and outputs:
 *  - A Markdown table of the last N runs
 *  - Deltas between the latest run and the previous run
 *
 * Usage:
 *   npx tsx scripts/ci/benchmark-trend.ts [--last N] [--format markdown|json]
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────

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

// ── Configuration ─────────────────────────────────────────────────

const REGRESSION_THRESHOLD_PERCENT = 20;
const DEFAULT_LAST = 10;
const HISTORY_PATH = path.resolve(__dirname, "../../benchmarks/history.json");

// ── Helpers ───────────────────────────────────────────────────────

function parseArgs(): { last: number; format: "markdown" | "json" } {
  const args = process.argv.slice(2);
  let last = DEFAULT_LAST;
  let format: "markdown" | "json" = "markdown";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--last" && args[i + 1]) {
      last = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--format" && args[i + 1]) {
      format = args[i + 1] as "markdown" | "json";
      i++;
    }
  }

  if (isNaN(last) || last < 1) {
    console.error(`Invalid --last value: must be a positive integer, got "${args[args.indexOf("--last") + 1]}"`);
    process.exit(1);
  }

  if (format !== "markdown" && format !== "json") {
    console.error(`Invalid --format value: must be "markdown" or "json", got "${format}"`);
    process.exit(1);
  }

  return { last, format };
}

function loadHistory(): HistoryEntry[] {
  if (!fs.existsSync(HISTORY_PATH)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(HISTORY_PATH, "utf-8");
    return JSON.parse(raw) as HistoryEntry[];
  } catch (err) {
    console.error(`Warning: failed to parse ${HISTORY_PATH}:`, err);
    return [];
  }
}

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

function formatDeltaSign(deltaPercent: number): string {
  if (deltaPercent > 0) return `+${deltaPercent}%`;
  if (deltaPercent < 0) return `${deltaPercent}%`;
  return "0%";
}

function formatRegressionIndicator(regression: boolean): string {
  return regression ? " :warning:" : "";
}

// ── Formatters ────────────────────────────────────────────────────

function formatMarkdown(history: HistoryEntry[], deltas: MetricDelta[]): string {
  const lines: string[] = [];

  // Header
  lines.push("## Benchmark Trend Report");
  lines.push("");

  if (history.length === 0) {
    lines.push("No benchmark history available yet.");
    return lines.join("\n");
  }

  // Delta summary (latest vs previous)
  if (deltas.length > 0) {
    lines.push("### Latest vs Previous Run");
    lines.push("");
    lines.push("| Metric | Previous (p95) | Current (p95) | Delta | Change |");
    lines.push("|--------|---------------|--------------|-------|--------|");

    for (const d of deltas) {
      lines.push(
        `| ${d.metric} | ${d.previous}${d.unit} | ${d.current}${d.unit} | ${d.delta > 0 ? "+" : ""}${d.delta}${d.unit} | ${formatDeltaSign(d.deltaPercent)}${formatRegressionIndicator(d.regression)} |`
      );
    }

    lines.push("");
  }

  // History table
  lines.push("### Historical Results (p95)");
  lines.push("");

  // Collect all unique metrics
  const metrics = new Set<string>();
  for (const entry of history) {
    for (const r of entry.results) {
      metrics.add(r.metric);
    }
  }
  const metricList = [...metrics];

  // Table header
  lines.push(`| Date | Commit | ${metricList.join(" | ")} |`);
  lines.push(`|------|--------|${metricList.map(() => "------").join("|")}|`);

  // Table rows (newest first)
  for (const entry of [...history].reverse()) {
    const date = entry.timestamp.split("T")[0];
    const sha = entry.commitSha.substring(0, 7);
    const values = metricList.map((m) => {
      const r = entry.results.find((res) => res.metric === m);
      return r ? `${r.p95}${r.unit}` : "N/A";
    });
    lines.push(`| ${date} | ${sha} | ${values.join(" | ")} |`);
  }

  lines.push("");
  return lines.join("\n");
}

function formatJson(history: HistoryEntry[], deltas: MetricDelta[]): string {
  return JSON.stringify({ history, deltas }, null, 2);
}

// ── Main ──────────────────────────────────────────────────────────

function main(): void {
  const { last, format } = parseArgs();
  const allHistory = loadHistory();
  const history = allHistory.slice(-last);

  let deltas: MetricDelta[] = [];
  if (history.length >= 2) {
    const current = history[history.length - 1];
    const previous = history[history.length - 2];
    deltas = computeDeltas(current, previous);
  }

  if (format === "json") {
    console.log(formatJson(history, deltas));
  } else {
    console.log(formatMarkdown(history, deltas));
  }

  // Exit with non-zero if any delta-based regressions detected
  const hasRegressions = deltas.some((d) => d.regression);
  if (hasRegressions) {
    console.error(
      `Delta-based regressions detected (>${REGRESSION_THRESHOLD_PERCENT}% increase in p95):`
    );
    for (const d of deltas.filter((d) => d.regression)) {
      console.error(`  - ${d.metric}: ${formatDeltaSign(d.deltaPercent)}`);
    }
    process.exit(1);
  }
}

main();
