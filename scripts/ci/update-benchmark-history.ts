#!/usr/bin/env npx tsx
/**
 * Update benchmark history file with current results.
 *
 * Usage:
 *   npx tsx scripts/ci/update-benchmark-history.ts <benchmark-results.json> <benchmark-history.json>
 *
 * - Reads the current benchmark report from <benchmark-results.json>
 * - Reads (or creates) history from <benchmark-history.json>
 * - Appends current results to history, trims to last 20 entries
 * - Writes the updated history back to <benchmark-history.json>
 */

import * as fs from "fs";
import { appendToHistory, BenchmarkHistory, BenchmarkReport } from "../../src/benchmark/history";

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: update-benchmark-history.ts <benchmark-results.json> <benchmark-history.json>");
    process.exit(1);
  }

  const [resultsPath, historyPath] = args;

  // Read current benchmark results
  if (!fs.existsSync(resultsPath)) {
    console.error(`Error: benchmark results file not found: ${resultsPath}`);
    process.exit(1);
  }
  const report: BenchmarkReport = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));

  // Read existing history (or start fresh)
  let history: BenchmarkHistory | null = null;
  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
      console.error(`Loaded history with ${history!.entries.length} entries`);
    } catch (err) {
      console.error(`Warning: could not parse history file, starting fresh: ${err}`);
      history = null;
    }
  } else {
    console.error("No existing history file, creating new one");
  }

  // Append and trim
  const updated = appendToHistory(history, report);
  console.error(`Updated history: ${updated.entries.length} entries`);

  // Write updated history
  fs.writeFileSync(historyPath, JSON.stringify(updated, null, 2) + "\n");
  console.error(`Wrote history to ${historyPath}`);
}

main();
