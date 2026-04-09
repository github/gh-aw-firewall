#!/usr/bin/env -S npx tsx
/**
 * Benchmark trend reporter for AWF (Agentic Workflow Firewall).
 *
 * Reads benchmarks/history.json and outputs:
 *  - Deltas between the latest run and the previous run
 *  - A Markdown table of the last N runs
 *
 * Usage:
 *   npx tsx scripts/ci/benchmark-trend.ts [--last N] [--format markdown|json]
 *
 * Outputs to stdout (append to $GITHUB_STEP_SUMMARY in CI).
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

  return { last, format };
}

function loadHistory(): HistoryEntry[] {
  if (!fs.existsSync(HISTORY_PATH)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")) as HistoryEntry[];
  } catch {
    console.error(`Warning: failed to parse ${HISTORY_PATH}`);
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

function formatDeltaSign(pct: number): string {
  if (pct > 0) return `+${pct}%`;
  if (pct < 0) return `${pct}%`;
  return "0%";
}

// ── Formatters ────────────────────────────────────────────────────

function formatMarkdown(history: HistoryEntry[], deltas: MetricDelta[]): string {
  const lines: string[] = [];
  lines.push("## Benchmark Trend Report");
  lines.push("");

  if (history.length === 0) {
    lines.push("No benchmark history available yet.");
    return lines.join("\n");
  }

  // Delta summary
  if (deltas.length > 0) {
    lines.push("### Latest vs Previous Run");
    lines.push("");
    lines.push("| Metric | Previous (p95) | Current (p95) | Delta | Change |");
    lines.push("|--------|---------------|--------------|-------|--------|");
    for (const d of deltas) {
      const sign = d.delta > 0 ? "+" : "";
      const warn = d.regression ? " :warning:" : "";
      lines.push(
        `| ${d.metric} | ${d.previous}${d.unit} | ${d.current}${d.unit} | ${sign}${d.delta}${d.unit} | ${formatDeltaSign(d.deltaPercent)}${warn} |`
      );
    }
    lines.push("");
  }

  // Historical table
  lines.push("### Historical Results (p95)");
  lines.push("");
  const metrics = [...new Set(history.flatMap((e) => e.results.map((r) => r.metric)))];
  lines.push(`| Date | Commit | ${metrics.join(" | ")} |`);
  lines.push(`|------|--------|${metrics.map(() => "------").join("|")}|`);
  for (const entry of [...history].reverse()) {
    const date = entry.timestamp.split("T")[0];
    const sha = entry.commitSha.substring(0, 7);
    const values = metrics.map((m) => {
      const r = entry.results.find((res) => res.metric === m);
      return r ? `${r.p95}${r.unit}` : "N/A";
    });
    lines.push(`| ${date} | ${sha} | ${values.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────

function main(): void {
  const { last, format } = parseArgs();
  const history = loadHistory().slice(-last);

  let deltas: MetricDelta[] = [];
  if (history.length >= 2) {
    deltas = computeDeltas(history[history.length - 1], history[history.length - 2]);
  }

  if (format === "json") {
    console.log(JSON.stringify({ history, deltas }, null, 2));
  } else {
    console.log(formatMarkdown(history, deltas));
  }
}

main();
