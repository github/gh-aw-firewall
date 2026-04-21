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
  // context_tokens stats (total tokens processed, normalised across formats)
  ctx_mean:    number;
  ctx_median:  number;
  ctx_p25:     number;
  ctx_p75:     number;
  // cache hit rate
  cache_mean:  number;
  // cost
  cost_mean:   number | null;
  cost_total:  number | null;
  // reduction vs baseline (epoch 0)
  ctx_reduction_pct: number | null;
}

// ── Token field normalization ─────────────────────────────────────────────────
// The dataset contains two token-field conventions:
//
//  CLAUDE format (input = net non-cached, cacheRead is separate):
//    total_context = input + cacheRead + cacheWrite + output
//    cache_rate    = cacheRead / total_context
//    Indicator: cacheRead > input (common case: input=10, cacheRead=300K)
//
//  COPILOT format (input = total prompt inclusive of cache hits, cacheRead is subset):
//    total_context = input + cacheWrite + output
//    cache_rate    = cacheRead / input
//    Indicator: cacheRead <= input
//
// We detect the format per-record and normalise to a consistent `context_tokens`
// and `cache_rate` before any analysis.

interface NormRecord extends DatasetRecord {
  context_tokens: number;  // total tokens processed (comparable across formats)
  cache_rate:     number;  // 0-1, fraction served from cache
}

function normalise(r: DatasetRecord): NormRecord {
  const { input_tokens: inp, output_tokens: out,
          cache_read_tokens: cR, cache_write_tokens: cW } = r;

  let context: number;
  let rate: number;

  if (cR > inp) {
    // Claude format: input is net non-cached; cacheRead is separate
    context = inp + cR + cW + out;
    rate    = context > 0 ? cR / context : 0;
  } else {
    // Copilot format: input already includes cache reads
    context = inp + cW + out;
    rate    = inp > 0 ? cR / inp : 0;
  }

  return { ...r, context_tokens: context, cache_rate: rate };
}
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

  // Load and normalise records
  const rawRecords: DatasetRecord[] = fs
    .readFileSync(datasetPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as DatasetRecord)
    .filter(r => !workflow || r.workflow.toLowerCase().includes(workflow.toLowerCase()));

  if (rawRecords.length === 0) {
    console.error('No records found (check --input path or --workflow filter)');
    process.exit(1);
  }

  const records: NormRecord[] = rawRecords.map(normalise);

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
      avg_context: Math.round(mean(recs.map(r => r.context_tokens))),
      avg_cache_pct: Math.round(mean(recs.map(r => r.cache_rate)) * 100),
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
  epochGroups: Record<string | number, NormRecord[]>,
  _allRecs: NormRecord[],
): EpochStats[] {
  const baselineRecs = epochGroups[0] ?? [];
  const baselineCtxMedian = median(baselineRecs.map(r => r.context_tokens));

  return Object.entries(epochGroups)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([epochStr, recs]) => {
      const epoch   = Number(epochStr);
      const ctxVals = recs.map(r => r.context_tokens);
      const caches  = recs.map(r => r.cache_rate);
      const costs   = recs.filter(r => r.cost_usd !== null).map(r => r.cost_usd as number);
      const ctxMed  = median(ctxVals);

      return {
        epoch,
        label:       recs[0].label,
        description: recs[0].description,
        n: recs.length,
        ctx_mean:   Math.round(mean(ctxVals)),
        ctx_median: Math.round(ctxMed),
        ctx_p25:    Math.round(percentile(ctxVals, 25)),
        ctx_p75:    Math.round(percentile(ctxVals, 75)),
        cache_mean: Math.round(mean(caches) * 100) / 100,
        cost_mean:  costs.length > 0 ? Math.round(mean(costs) * 10000) / 10000 : null,
        cost_total: costs.length > 0 ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
        ctx_reduction_pct: epoch === 0 || baselineCtxMedian === 0 ? null
          : pct(ctxMed, baselineCtxMedian),
      };
    });
}

// ── Table printer ─────────────────────────────────────────────────────────────
function printTable(
  overall: EpochStats[],
  byWorkflow: Record<string, EpochStats[]>,
  monthly: Array<{ month: string; n: number; avg_context: number; avg_cache_pct: number; total_cost: number | null }>,
  modelCounts: Record<string, number>,
  allWorkflows: string[],
  records: NormRecord[],
) {
  const hr = (w = 100) => '─'.repeat(w);

  // Overall epoch summary
  console.log('\n' + hr());
  console.log('OVERALL EPOCH SUMMARY (all workflows combined, context_tokens = total tokens processed)');
  console.log(hr());
  console.log(
    'Ep  Label                n     Med.Context  p25        p75        Cache%  Δ vs baseline  Avg$Cost'
  );
  console.log(hr());
  for (const s of overall) {
    const row = [
      String(s.epoch).padStart(2),
      s.label.padEnd(20),
      String(s.n).padStart(5),
      fmt(s.ctx_median).padStart(12),
      fmt(s.ctx_p25).padStart(10),
      fmt(s.ctx_p75).padStart(10),
      `${Math.round(s.cache_mean * 100)}%`.padStart(7),
      fmtPct(s.ctx_reduction_pct).padStart(14),
      s.cost_mean !== null ? `$${s.cost_mean.toFixed(4)}`.padStart(10) : '—'.padStart(10),
    ].join('  ');
    console.log(row);
  }

  // Per-workflow breakdown
  for (const wf of allWorkflows) {
    const stats = byWorkflow[wf];
    if (!stats || stats.length < 2) continue;
    console.log('\n' + hr(90));
    console.log(`WORKFLOW: ${wf}`);
    console.log(hr(90));
    console.log('Ep  Label                n     Med.Context  Cache%  Δ vs baseline  Avg$Cost');
    console.log(hr(90));
    for (const s of stats) {
      const row = [
        String(s.epoch).padStart(2),
        s.label.padEnd(20),
        String(s.n).padStart(5),
        fmt(s.ctx_median).padStart(12),
        `${Math.round(s.cache_mean * 100)}%`.padStart(7),
        fmtPct(s.ctx_reduction_pct).padStart(14),
        s.cost_mean !== null ? `$${s.cost_mean.toFixed(4)}`.padStart(10) : '—'.padStart(10),
      ].join('  ');
      console.log(row);
    }
  }

  // Monthly trend
  console.log('\n' + hr(70));
  console.log('MONTHLY TREND');
  console.log(hr(70));
  console.log('Month       n     Avg.Context  Cache%  Total$Cost');
  console.log(hr(70));
  for (const m of monthly) {
    console.log(
      `${m.month}  ${String(m.n).padStart(5)}  ${fmt(m.avg_context).padStart(12)}  ` +
      `${String(m.avg_cache_pct)}%`.padStart(7) + '  ' +
      (m.total_cost ? `$${m.total_cost.toFixed(2)}` : '—')
    );
  }

  // Model distribution
  console.log('\n' + hr(55));
  console.log('MODEL DISTRIBUTION');
  console.log(hr(55));
  for (const [model, count] of Object.entries(modelCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${model.padEnd(45)} ${count}`);
  }

  // Summary
  const totalRuns = records.length;
  const hasCost   = records.filter(r => r.cost_usd !== null);
  const totalCost = hasCost.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const baseline  = overall.find(e => e.epoch === 0);
  const lastEpoch = overall[overall.length - 1];

  console.log('\n' + hr(80));
  console.log('SUMMARY');
  console.log(hr(80));
  console.log(`  Total runs analyzed:       ${totalRuns}`);
  if (baseline) {
    console.log(`  Baseline median context:   ${fmt(baseline.ctx_median)} tokens/run (epoch 0)`);
    console.log(`  Latest epoch median:       ${fmt(lastEpoch.ctx_median)} tokens/run (epoch ${lastEpoch.epoch})`);
    const reduction = baseline.ctx_median > 0 ? pct(lastEpoch.ctx_median, baseline.ctx_median) : 0;
    console.log(`  Overall reduction:         ${fmtPct(reduction)} vs baseline`);
  }
  if (hasCost.length > 0) {
    console.log(`  Total cost (sampled):      $${totalCost.toFixed(2)} across ${hasCost.length} runs`);
    console.log(`  Avg cost/run:              $${(totalCost / hasCost.length).toFixed(4)}`);
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
