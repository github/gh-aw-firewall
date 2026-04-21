#!/usr/bin/env npx tsx
/**
 * Token Usage Data Collector for Token Efficiency Paper
 *
 * Downloads token-usage data from GitHub Actions artifacts across target
 * workflows, correlates with the optimization commit timeline, and writes
 * a consolidated JSONL dataset for analysis.
 *
 * Usage:
 *   npx tsx scripts/paper/collect-token-data.ts [--output ./paper-data] [--since 2026-04-01]
 */

import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO = 'github/gh-aw-firewall';

// ── Optimization milestones ─────────────────────────────────────────────────
// Each milestone defines a named epoch. Runs are assigned the epoch of the
// most recent milestone that occurred BEFORE the run's created_at date.
const MILESTONES = [
  { date: '2026-04-01', epoch: 0, label: 'baseline',           pr: null,   description: 'Before any token optimization' },
  { date: '2026-04-03', epoch: 1, label: 'sg-opt-1',           pr: 1648,   description: 'security-guard first optimization' },
  { date: '2026-04-12', epoch: 2, label: 'sg-opt-2',           pr: 1940,   description: 'security-guard turn cap + relevance gate (~32%)' },
  { date: '2026-04-14', epoch: 3, label: 'haiku-switch',        pr: 1974,   description: 'secret-digger-claude + smoke-claude → Haiku' },
  { date: '2026-04-17', epoch: 4, label: 'smoke-claude-haiku',  pr: 2065,   description: 'smoke-claude Haiku + turn cap + narrow toolset' },
  { date: '2026-04-18', epoch: 5, label: 'sg-cache-align',      pr: 2085,   description: 'security-guard prompt cache alignment' },
  { date: '2026-04-20', epoch: 6, label: 'sg-relevance-gate',   pr: 2113,   description: 'security-guard pre-run relevance gating' },
];

// ── Target workflows ─────────────────────────────────────────────────────────
const TARGET_WORKFLOWS = [
  'Security Guard',
  'Smoke Claude',
  'Smoke Copilot',
  'Daily Claude Token Optimization Advisor',
  'Daily Copilot Token Optimization Advisor',
  'Secret Digger (Claude)',
];

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) ? args[i + 1] : def;
}
const outputDir = getArg('--output', './paper-data');
const since = getArg('--since', '2026-04-01');
const dryRun = args.includes('--dry-run');
const maxRuns = parseInt(getArg('--max-runs', '999'), 10);

// ── Helpers ───────────────────────────────────────────────────────────────────
const MAX_BUF = 64 * 1024 * 1024; // 64 MB

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: MAX_BUF, stdio: ['pipe', 'pipe', 'pipe'] });
}

function ghApi(path: string): unknown {
  return JSON.parse(gh(['api', path]));
}

function assignEpoch(createdAt: string): { epoch: number; label: string; description: string } {
  const runDate = createdAt.slice(0, 10);
  let best = MILESTONES[0];
  for (const m of MILESTONES) {
    if (m.date <= runDate) best = m;
  }
  return { epoch: best.epoch, label: best.label, description: best.description };
}

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const consolidatedPath = path.join(outputDir, 'token-dataset.jsonl');
  const metaPath = path.join(outputDir, 'run-index.json');

  log(`Collecting token data from ${REPO} since ${since}`);
  log(`Output: ${outputDir}`);

  // ── Step 1: List all relevant runs ─────────────────────────────────────────
  log('\n[1/3] Enumerating workflow runs...');
  const allRuns: WorkflowRun[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `repos/${REPO}/actions/runs?per_page=${perPage}&page=${page}&created=>=${since}`;
    const res = ghApi(url) as { workflow_runs: WorkflowRun[]; total_count: number };
    const batch = res.workflow_runs ?? [];
    if (batch.length === 0) break;

    const relevant = batch.filter(r =>
      TARGET_WORKFLOWS.some(t => r.name?.toLowerCase().includes(t.toLowerCase())) &&
      r.conclusion === 'success'
    );
    allRuns.push(...relevant);
    log(`  page ${page}: ${batch.length} total runs, ${relevant.length} relevant → ${allRuns.length} accumulated`);

    if (batch.length < perPage) break;
    page++;
    if (allRuns.length >= maxRuns) break;
  }

  log(`Found ${allRuns.length} successful target workflow runs`);

  if (dryRun) {
    const summary = allRuns.reduce((acc, r) => {
      acc[r.name] = (acc[r.name] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    log('\nDry run — runs by workflow:');
    for (const [k, v] of Object.entries(summary)) log(`  ${k}: ${v}`);
    return;
  }

  // ── Step 2: Download artifacts + extract token data ────────────────────────
  log('\n[2/3] Downloading agent artifacts...');
  const records: DatasetRecord[] = [];
  const runIndex: RunMeta[] = [];

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-paper-'));
  let downloaded = 0;
  let skipped = 0;

  for (const run of allRuns) {
    const runDir = path.join(tmpBase, String(run.id));
    const epochInfo = assignEpoch(run.created_at);

    // Check if this run has an 'agent' artifact
    let hasAgentArtifact = false;
    try {
      const artifacts = ghApi(`repos/${REPO}/actions/runs/${run.id}/artifacts`) as { artifacts: Artifact[] };
      hasAgentArtifact = artifacts.artifacts.some(a => a.name === 'agent');
    } catch {
      skipped++;
      continue;
    }

    if (!hasAgentArtifact) {
      log(`  SKIP ${run.id} (${run.name} @ ${run.created_at.slice(0, 10)}) — no agent artifact`);
      skipped++;
      continue;
    }

    log(`  GET  ${run.id} (${run.name} @ ${run.created_at.slice(0, 10)}) epoch=${epochInfo.epoch}/${epochInfo.label}`);

    try {
      fs.mkdirSync(runDir, { recursive: true });
      gh(['run', 'download', String(run.id), '--repo', REPO, '--name', 'agent', '--dir', runDir]);

      // Extract aggregated usage summary
      const usageSummaryPath = path.join(runDir, 'agent_usage.json');
      let usageSummary: UsageSummary | null = null;
      if (fs.existsSync(usageSummaryPath)) {
        usageSummary = JSON.parse(fs.readFileSync(usageSummaryPath, 'utf8'));
      }

      // Extract per-call token records
      const tokenLogPath = path.join(runDir, 'sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl');
      const perCallRecords: TokenCall[] = [];
      if (fs.existsSync(tokenLogPath)) {
        const lines = fs.readFileSync(tokenLogPath, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try { perCallRecords.push(JSON.parse(line)); } catch { /* skip malformed */ }
        }
      }

      if (!usageSummary && perCallRecords.length === 0) {
        log(`    → no token data found, skipping`);
        skipped++;
        fs.rmSync(runDir, { recursive: true });
        continue;
      }

      // Derive summary from per-call records if agent_usage.json absent
      if (!usageSummary && perCallRecords.length > 0) {
        usageSummary = {
          input_tokens: perCallRecords.reduce((s, r) => s + (r.input_tokens ?? 0), 0),
          output_tokens: perCallRecords.reduce((s, r) => s + (r.output_tokens ?? 0), 0),
          cache_read_tokens: perCallRecords.reduce((s, r) => s + (r.cache_read_tokens ?? 0), 0),
          cache_write_tokens: perCallRecords.reduce((s, r) => s + (r.cache_write_tokens ?? 0), 0),
          effective_tokens: 0,
        };
        const eff = usageSummary.input_tokens - usageSummary.cache_read_tokens +
          usageSummary.output_tokens + usageSummary.cache_write_tokens;
        usageSummary.effective_tokens = eff;
      }

      const models = [...new Set(perCallRecords.map(r => r.model).filter(Boolean))];
      const providers = [...new Set(perCallRecords.map(r => r.provider).filter(Boolean))];
      const cacheHitRate = usageSummary!.input_tokens > 0
        ? usageSummary!.cache_read_tokens / usageSummary!.input_tokens
        : 0;

      const record: DatasetRecord = {
        run_id: run.id,
        workflow: run.name,
        created_at: run.created_at,
        date: run.created_at.slice(0, 10),
        branch: run.head_branch,
        ...epochInfo,
        models,
        providers,
        api_calls: perCallRecords.length,
        input_tokens: usageSummary!.input_tokens,
        output_tokens: usageSummary!.output_tokens,
        cache_read_tokens: usageSummary!.cache_read_tokens,
        cache_write_tokens: usageSummary!.cache_write_tokens,
        effective_tokens: usageSummary!.effective_tokens,
        cache_hit_rate: Math.round(cacheHitRate * 1000) / 1000,
        total_tokens: usageSummary!.input_tokens + usageSummary!.output_tokens,
      };

      records.push(record);
      runIndex.push({
        run_id: run.id,
        workflow: run.name,
        created_at: run.created_at,
        epoch: epochInfo.epoch,
        label: epochInfo.label,
        total_tokens: record.total_tokens,
        effective_tokens: record.effective_tokens,
        cache_hit_rate: record.cache_hit_rate,
        models,
      });

      downloaded++;
      fs.rmSync(runDir, { recursive: true });
    } catch (e) {
      log(`    → ERROR: ${(e as Error).message}`);
      skipped++;
      try { fs.rmSync(runDir, { recursive: true }); } catch { /* ignore */ }
    }
  }

  fs.rmSync(tmpBase, { recursive: true, force: true });

  // ── Step 3: Write output ───────────────────────────────────────────────────
  log('\n[3/3] Writing output files...');

  // Main dataset (JSONL)
  const jsonl = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(consolidatedPath, jsonl);
  log(`  ${consolidatedPath} (${records.length} records)`);

  // Run index (JSON for quick inspection)
  fs.writeFileSync(metaPath, JSON.stringify({ milestones: MILESTONES, runs: runIndex }, null, 2));
  log(`  ${metaPath}`);

  // ── Quick per-epoch summary ────────────────────────────────────────────────
  log('\n── Per-epoch summary ──────────────────────────────────────────────────');
  log('epoch | label              | workflow          | n  | avg input | avg total | cache%');
  log('------|--------------------|-------------------|----|-----------|-----------|-------');

  const byEpochWorkflow = new Map<string, DatasetRecord[]>();
  for (const r of records) {
    const key = `${r.epoch}|${r.workflow}`;
    if (!byEpochWorkflow.has(key)) byEpochWorkflow.set(key, []);
    byEpochWorkflow.get(key)!.push(r);
  }

  for (const [key, recs] of [...byEpochWorkflow.entries()].sort()) {
    const [epochStr, workflow] = key.split('|');
    const m = MILESTONES.find(m => m.epoch === parseInt(epochStr))!;
    const n = recs.length;
    const avgInput = Math.round(recs.reduce((s, r) => s + r.input_tokens, 0) / n);
    const avgTotal = Math.round(recs.reduce((s, r) => s + r.total_tokens, 0) / n);
    const avgCache = Math.round(recs.reduce((s, r) => s + r.cache_hit_rate, 0) / n * 100);
    log(
      `  ${epochStr.padEnd(3)} | ${m.label.padEnd(18)} | ${workflow.slice(0, 17).padEnd(17)} | ${String(n).padEnd(2)} | ${String(avgInput).padStart(9)} | ${String(avgTotal).padStart(9)} | ${String(avgCache).padStart(5)}%`
    );
  }

  log(`\nDone. Downloaded: ${downloaded}, Skipped: ${skipped}`);
  log(`Dataset: ${consolidatedPath}`);
}

// ── Type definitions ──────────────────────────────────────────────────────────
interface WorkflowRun {
  id: number;
  name: string;
  created_at: string;
  conclusion: string;
  head_branch: string;
}

interface Artifact {
  name: string;
  size_in_bytes: number;
}

interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  effective_tokens: number;
}

interface TokenCall {
  timestamp: string;
  request_id: string;
  provider: string;
  model: string;
  path: string;
  status: number;
  streaming: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  duration_ms: number;
}

interface RunMeta {
  run_id: number;
  workflow: string;
  created_at: string;
  epoch: number;
  label: string;
  total_tokens: number;
  effective_tokens: number;
  cache_hit_rate: number;
  models: string[];
}

interface DatasetRecord {
  run_id: number;
  workflow: string;
  created_at: string;
  date: string;
  branch: string;
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
}

main().catch(e => { console.error(e); process.exit(1); });
