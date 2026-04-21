#!/usr/bin/env npx tsx
/**
 * Token Efficiency Analysis for the AWF Paper
 *
 * Reads the JSONL dataset produced by collect-token-data.ts and computes:
 *   - Per-epoch statistics by workflow (median, mean, p25/p75)
 *   - Token reduction percentages relative to epoch 0 (baseline)
 *   - Cache hit rate trends
 *   - Cost savings estimates
 *   - Model distribution over time
 *
 * Usage:
 *   npx tsx scripts/paper/analyze-token-data.ts [--input ./paper-data] [--format table|json|csv]
 */

import * as fs from 'fs';
import * as path from 'path';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}
const inputDir  = getArg('--input', './paper-data');
const format    = getArg('--format', 'table') as 'table' | 'json' | 'csv';
const workflow  = getArg('--workflow', ''); // filter to one workflow if set

// ── Types ─────────────────────────────────────────────────────────────────────
interface DatasetRecord {
  run_id: number;
  workflow: string;
  created_at: string;
  date: string;
  branch: string;
  artifact: string;
  epoch: number;
  label: string;
  description: string;
  models: string[];
  providers: string[];
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  effective_tokens: number;
  cache_hit_rate: number;
  total_tokens: number;
  cost_usd: number | null;
}

interface EpochStats {
  epoch: number;
  label: string;
  description: string;
  n: number;
  // total_tokens stats
  total_mean:  number;
  total_median: number;
  total_p25:   number;
  total_p75:   number;
  // effective_tokens stats
  eff_mean:    number;
  eff_median:  number;
  // cache hit rate
  cache_mean:  number;
  // cost
  cost_mean:   number | null;
  cost_total:  number | null;
  // reduction vs baseline (epoch 0)
  total_reduction_pct: number | null;
  eff_reduction_pct:   number | null;
}

// ── Stats helpers ─────────────────────────────────────────────────────────────
function mean(vals: number[]): number {
  return vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
}

function median(vals: number[]): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(vals: number[], p: number): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function pct(value: number, baseline: number): number {
  return baseline === 0 ? 0 : Math.round(((baseline - value) / baseline) * 1000) / 10;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtPct(n: number | null): string {
  if (n === null) return '—';
  const sign = n > 0 ? '-' : n < 0 ? '+' : '';
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const datasetPath = path.join(inputDir, 'token-dataset.jsonl');
  if (!fs.existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    console.error('Run collect-token-data.ts first.');
    process.exit(1);
  }

  // Load records
  const records: DatasetRecord[] = fs
    .readFileSync(datasetPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as DatasetRecord)
    .filter(r => !workflow || r.workflow.toLowerCase().includes(workflow.toLowerCase()));

  if (records.length === 0) {
    console.error('No records found (check --input path or --workflow filter)');
    process.exit(1);
  }

  const allWorkflows = [...new Set(records.map(r => r.workflow))].sort();
  console.error(`Loaded ${records.length} records across ${allWorkflows.length} workflows`);

  // ── A. Overall epoch summary (all workflows combined) ──────────────────────
  const epochGroups = groupBy(records, r => r.epoch);
  const overallStats = computeEpochStats(epochGroups, records);

  // ── B. Per-workflow epoch stats ────────────────────────────────────────────
  const byWorkflow: Record<string, EpochStats[]> = {};
  for (const wf of allWorkflows) {
    const wfRecords = records.filter(r => r.workflow === wf);
    const wfEpochGroups = groupBy(wfRecords, r => r.epoch);
    byWorkflow[wf] = computeEpochStats(wfEpochGroups, wfRecords);
  }

  // ── C. Model/provider breakdown ────────────────────────────────────────────
  const modelCounts: Record<string, number> = {};
  for (const r of records) {
    for (const m of r.models) {
      modelCounts[m] = (modelCounts[m] ?? 0) + 1;
    }
  }

  // ── D. Monthly trend ───────────────────────────────────────────────────────
  const monthlyGroups = groupBy(records, r => r.date.slice(0, 7));
  const monthlyStats = Object.entries(monthlyGroups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, recs]) => ({
      month,
      n: recs.length,
      avg_total: Math.round(mean(recs.map(r => r.total_tokens))),
      avg_effective: Math.round(mean(recs.map(r => r.effective_tokens))),
      avg_cache_rate: Math.round(mean(recs.map(r => r.cache_hit_rate)) * 100),
      total_cost: recs.filter(r => r.cost_usd !== null).reduce((s, r) => s + (r.cost_usd ?? 0), 0) || null,
    }));

  // ── Output ─────────────────────────────────────────────────────────────────
  if (format === 'json') {
    console.log(JSON.stringify({ overall: overallStats, byWorkflow, monthly: monthlyStats, modelCounts }, null, 2));
    return;
  }

  if (format === 'csv') {
    outputCsv(records);
    return;
  }

  // Table output
  printTable(overallStats, byWorkflow, monthlyStats, modelCounts, allWorkflows, records);
}

// ── Computation ───────────────────────────────────────────────────────────────
function groupBy<T>(arr: T[], key: (item: T) => string | number): Record<string | number, T[]> {
  const out: Record<string | number, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

function computeEpochStats(
  epochGroups: Record<string | number, DatasetRecord[]>,
  allRecs: DatasetRecord[],
): EpochStats[] {
  // Find baseline (epoch 0)
  const baselineRecs = epochGroups[0] ?? [];
  const baselineTotalMedian = median(baselineRecs.map(r => r.total_tokens));
  const baselineEffMedian   = median(baselineRecs.map(r => r.effective_tokens));

  return Object.entries(epochGroups)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([epochStr, recs]) => {
      const epoch = Number(epochStr);
      const totals = recs.map(r => r.total_tokens);
      const effs   = recs.map(r => r.effective_tokens);
      const caches = recs.map(r => r.cache_hit_rate);
      const costs  = recs.filter(r => r.cost_usd !== null).map(r => r.cost_usd as number);

      const totalMed = median(totals);
      const effMed   = median(effs);

      return {
        epoch,
        label:       recs[0].label,
        description: recs[0].description,
        n: recs.length,
        total_mean:   Math.round(mean(totals)),
        total_median: Math.round(totalMed),
        total_p25:    Math.round(percentile(totals, 25)),
        total_p75:    Math.round(percentile(totals, 75)),
        eff_mean:     Math.round(mean(effs)),
        eff_median:   Math.round(effMed),
        cache_mean:   Math.round(mean(caches) * 100) / 100,
        cost_mean:    costs.length > 0 ? Math.round(mean(costs) * 10000) / 10000 : null,
        cost_total:   costs.length > 0 ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
        total_reduction_pct: epoch === 0 || baselineTotalMedian === 0 ? null
          : pct(totalMed, baselineTotalMedian),
        eff_reduction_pct: epoch === 0 || baselineEffMedian === 0 ? null
          : pct(effMed, baselineEffMedian),
      };
    });
}

// ── Table printer ─────────────────────────────────────────────────────────────
function printTable(
  overall: EpochStats[],
  byWorkflow: Record<string, EpochStats[]>,
  monthly: ReturnType<typeof main extends void ? never : any>[],
  modelCounts: Record<string, number>,
  allWorkflows: string[],
  records: DatasetRecord[],
) {
  const hr = (w = 100) => '─'.repeat(w);

  // Overall epoch summary
  console.log('\n' + hr());
  console.log('OVERALL EPOCH SUMMARY (all workflows combined)');
  console.log(hr());
  console.log(
    'Ep  Label                n     Med.Total  Med.Eff    Cache%  ΔTotal    ΔEff      Avg$Cost'
  );
  console.log(hr());
  for (const s of overall) {
    const row = [
      String(s.epoch).padStart(2),
      s.label.padEnd(20),
      String(s.n).padStart(5),
      fmt(s.total_median).padStart(10),
      fmt(s.eff_median).padStart(10),
      `${Math.round(s.cache_mean * 100)}%`.padStart(7),
      fmtPct(s.total_reduction_pct).padStart(9),
      fmtPct(s.eff_reduction_pct).padStart(9),
      s.cost_mean !== null ? `$${s.cost_mean.toFixed(4)}`.padStart(10) : '—'.padStart(10),
    ].join('  ');
    console.log(row);
  }

  // Per-workflow breakdown
  for (const wf of allWorkflows) {
    const stats = byWorkflow[wf];
    if (!stats || stats.length < 2) continue;
    console.log('\n' + hr(80));
    console.log(`WORKFLOW: ${wf}`);
    console.log(hr(80));
    console.log('Ep  Label                n     Med.Total  Med.Eff    Cache%  ΔTotal    ΔEff');
    console.log(hr(80));
    for (const s of stats) {
      const row = [
        String(s.epoch).padStart(2),
        s.label.padEnd(20),
        String(s.n).padStart(5),
        fmt(s.total_median).padStart(10),
        fmt(s.eff_median).padStart(10),
        `${Math.round(s.cache_mean * 100)}%`.padStart(7),
        fmtPct(s.total_reduction_pct).padStart(9),
        fmtPct(s.eff_reduction_pct).padStart(9),
      ].join('  ');
      console.log(row);
    }
  }

  // Monthly trend
  console.log('\n' + hr(80));
  console.log('MONTHLY TREND');
  console.log(hr(80));
  console.log('Month       n     Avg.Total  Avg.Eff    Cache%');
  console.log(hr(80));
  for (const m of (monthly as any[])) {
    console.log(
      `${m.month}  ${String(m.n).padStart(5)}  ${fmt(m.avg_total).padStart(10)}  ` +
      `${fmt(m.avg_effective).padStart(10)}  ${String(m.avg_cache_rate)}%`
    );
  }

  // Model distribution
  console.log('\n' + hr(50));
  console.log('MODEL DISTRIBUTION');
  console.log(hr(50));
  for (const [model, count] of Object.entries(modelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${model.padEnd(40)} ${count}`);
  }

  // Summary
  const totalRuns  = records.length;
  const hasCost    = records.filter(r => r.cost_usd !== null);
  const totalCost  = hasCost.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const lastEpoch  = overall[overall.length - 1];
  const baseline   = overall.find(e => e.epoch === 0);

  console.log('\n' + hr(80));
  console.log('SUMMARY');
  console.log(hr(80));
  console.log(`  Total runs analyzed:     ${totalRuns}`);
  if (baseline) {
    console.log(`  Baseline median total:   ${fmt(baseline.total_median)} tokens/run`);
    console.log(`  Latest epoch median:     ${fmt(lastEpoch.total_median)} tokens/run`);
    const overall_reduction = baseline.total_median > 0
      ? pct(lastEpoch.total_median, baseline.total_median) : 0;
    console.log(`  Overall reduction:       ${fmtPct(overall_reduction)} vs baseline`);
  }
  if (hasCost.length > 0) {
    console.log(`  Total cost (sampled):    $${totalCost.toFixed(2)}`);
    console.log(`  Avg cost/run:            $${(totalCost / hasCost.length).toFixed(4)}`);
  }
  console.log(hr(80));
}

// ── CSV output ────────────────────────────────────────────────────────────────
function outputCsv(records: DatasetRecord[]) {
  const cols: (keyof DatasetRecord)[] = [
    'run_id', 'workflow', 'date', 'epoch', 'label',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
    'effective_tokens', 'total_tokens', 'cache_hit_rate', 'cost_usd', 'api_calls',
  ];
  console.log(cols.join(','));
  for (const r of records) {
    console.log(cols.map(c => {
      const v = r[c];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
      if (Array.isArray(v)) return `"${v.join(';')}"`;
      return String(v);
    }).join(','));
  }
}

main();
