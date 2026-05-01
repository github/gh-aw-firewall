#!/usr/bin/env npx tsx
/**
 * Token Usage Data Collector for Token Efficiency Paper
 *
 * Downloads token-usage data from GitHub Actions artifacts across target
 * workflows, correlates with the optimization commit timeline, and writes
 * a consolidated JSONL dataset for analysis.
 *
 * Strategy: query per workflow-file × epoch date window to stay under the
 * GitHub API's 1000-result cap (the busy repo has ~500 total runs/day, but
 * each individual workflow only has ~20-50 runs/day).
 *
 * Usage:
 *   npx tsx scripts/paper/collect-token-data.ts [--output ./paper-data] [--dry-run]
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO = 'github/gh-aw-firewall';
const MAX_BUF = 64 * 1024 * 1024; // 64 MB

// ── Optimization milestones ─────────────────────────────────────────────────
// Each milestone is an exclusive lower bound for the NEXT epoch.
// Runs are assigned the epoch of the most-recent milestone whose date ≤ run date.
// Epoch -1 covers pre-April data (from repo launch through March 31 2026).
const MILESTONES = [
  { date: '2025-11-01', epoch: -1, label: 'pre-tracking',       pr: null, description: 'Before api-proxy token tracking (data from agent logs only)' },
  { date: '2026-04-01', epoch: 0,  label: 'baseline',           pr: null, description: 'api-proxy tracking enabled, before any token optimization' },
  { date: '2026-04-03', epoch: 1,  label: 'sg-opt-1',           pr: 1648, description: 'security-guard first optimization' },
  { date: '2026-04-12', epoch: 2,  label: 'sg-opt-2',           pr: 1940, description: 'security-guard turn cap + relevance gate (~32%)' },
  { date: '2026-04-14', epoch: 3,  label: 'haiku-switch',        pr: 1974, description: 'secret-digger-claude → Haiku' },
  { date: '2026-04-17', epoch: 4,  label: 'smoke-claude-haiku',  pr: 2065, description: 'smoke-claude Haiku + turn cap + narrow toolset' },
  { date: '2026-04-18', epoch: 5,  label: 'sg-cache-align',      pr: 2085, description: 'security-guard prompt cache alignment' },
  { date: '2026-04-20', epoch: 6,  label: 'sg-relevance-gate',   pr: 2113, description: 'security-guard pre-run relevance gating' },
];

// Date windows derived from milestones: [milestone[i].date, milestone[i+1].date)
// plus a final window from the last milestone to today+1.
function buildDateWindows(): Array<{ start: string; end: string; epoch: number; label: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const windows = [];
  for (let i = 0; i < MILESTONES.length; i++) {
    const start = MILESTONES[i].date;
    const end = i + 1 < MILESTONES.length ? MILESTONES[i + 1].date : today;
    windows.push({ start, end, epoch: MILESTONES[i].epoch, label: MILESTONES[i].label });
  }
  return windows;
}

// ── Target workflow lock files ────────────────────────────────────────────────
// Maps workflow filename → human label. These are the files that use
// --enable-api-proxy and produce token-usage.jsonl artifacts.
const TARGET_WORKFLOW_FILES: Record<string, string> = {
  'security-guard.lock.yml':             'Security Guard',
  'smoke-claude.lock.yml':               'Smoke Claude',
  'smoke-copilot.lock.yml':              'Smoke Copilot',
  'secret-digger-claude.lock.yml':       'Secret Digger (Claude)',
  'claude-token-optimizer.lock.yml':     'Claude Token Optimizer',
  'copilot-token-optimizer.lock.yml':    'Copilot Token Optimizer',
};

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) ? args[i + 1] : def;
}
const dryRun = args.includes('--dry-run');
const outputDir = getArg('--output', './paper-data');
// Go back to repo start — old runs have token data in agent-stdio.log / process-*.log
const TOKEN_TRACKING_SINCE = '2025-11-01';

// ── Helpers ───────────────────────────────────────────────────────────────────

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: MAX_BUF, stdio: ['pipe', 'pipe', 'pipe'] });
}

function ghApi(apiPath: string): unknown {
  return JSON.parse(gh(['api', apiPath]));
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

/**
 * Extract token usage from an artifact directory.
 *
 * Tries three sources in priority order:
 *  1. agent_usage.json  — present in new-format runs (April 1 2026+)
 *  2. agent-stdio.log   — Claude stream-json: find the {"type":"result"} line
 *  3. process-*.log     — Copilot/OpenAI debug log: deduplicate by Request-ID,
 *                         sum unique API calls
 */
function extractTokenUsage(dir: string): UsageSummary | null {
  // ── Source 1: agent_usage.json (new runs, April 1+) ──────────────────────
  const usageJsonPath = path.join(dir, 'agent_usage.json');
  if (fs.existsSync(usageJsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(usageJsonPath, 'utf8')) as UsageSummary;
    } catch { /* fall through */ }
  }

  // ── Source 2: agent-stdio.log — Claude result line ───────────────────────
  // Present in both old (agent-artifacts) and new (agent) artifact layouts.
  // Claude --output-format stream-json emits a final {"type":"result",...} line
  // with aggregate usage, per-model breakdown, and cost.
  for (const candidate of ['agent-stdio.log', path.join('sandbox', 'agent-stdio.log')]) {
    const p = path.join(dir, candidate);
    if (!fs.existsSync(p)) continue;
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n').reverse()) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const obj = JSON.parse(t) as Record<string, unknown>;
          if (obj.type === 'result' && obj.subtype === 'success' && obj.usage) {
            const u = obj.usage as Record<string, number>;
            const input  = (u.input_tokens ?? 0);
            const output = (u.output_tokens ?? 0);
            const cacheRead  = (u.cache_read_input_tokens ?? 0);
            const cacheWrite = (u.cache_creation_input_tokens ?? 0);
            return {
              input_tokens:        input,
              output_tokens:       output,
              cache_read_tokens:   cacheRead,
              cache_write_tokens:  cacheWrite,
              effective_tokens:    input - cacheRead + output + cacheWrite,
              cost_usd:            (obj.total_cost_usd as number | undefined) ?? null,
              model_usage:         (obj.modelUsage as Record<string, unknown> | undefined) ?? null,
            };
          }
        } catch { /* skip non-JSON lines */ }
      }
    } catch { /* file unreadable */ }
  }

  // ── Source 3: process-*.log — Copilot/OpenAI format ─────────────────────
  // The Copilot CLI logs each API response in multi-line debug format:
  //   TIMESTAMP [DEBUG] response (Request-ID <uuid>):
  //   TIMESTAMP [DEBUG] data:
  //   TIMESTAMP [DEBUG] { "usage": { "prompt_tokens":…, … }, "id": "msg_…", … }
  // Deduplicate by Request-ID to avoid counting the same call twice
  // (the CLI sometimes logs the same response multiple times).
  const logsDir = path.join(dir, 'sandbox', 'agent', 'logs');
  if (fs.existsSync(logsDir)) {
    const processLogs = fs.readdirSync(logsDir).filter(f => f.startsWith('process-') && f.endsWith('.log'));
    if (processLogs.length > 0) {
      const seenReqIds = new Set<string>();
      let promptTotal = 0, completionTotal = 0, cachedTotal = 0;
      let found = false;

      for (const logFile of processLogs) {
        const lines = fs.readFileSync(path.join(logsDir, logFile), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          // Look for: TIMESTAMP [DEBUG] response (Request-ID <id>):
          const reqMatch = lines[i].match(/\[DEBUG\] response \(Request-ID ([^)]+)\)/);
          if (!reqMatch) continue;
          const reqId = reqMatch[1];
          if (seenReqIds.has(reqId)) continue;

          // Collect the JSON block that follows (the next [DEBUG] data: + lines)
          let jsonLines: string[] = [];
          let j = i + 1;
          while (j < lines.length && j < i + 200) {
            const content = lines[j].replace(/^\S+ \[DEBUG\] /, '');
            if (content === 'data:') { j++; continue; }
            // Stop collecting when we hit another timestamp line that isn't part of the JSON
            if (lines[j].match(/^\d{4}-\d{2}-\d{2}T/) && jsonLines.length > 3 && content.trim() === '}') {
              jsonLines.push(content);
              break;
            }
            jsonLines.push(content);
            j++;
          }

          try {
            const obj = JSON.parse(jsonLines.join('\n')) as Record<string, unknown>;
            const u = obj.usage as Record<string, unknown> | undefined;
            if (!u || typeof u.prompt_tokens !== 'number') continue;
            seenReqIds.add(reqId);
            promptTotal     += (u.prompt_tokens as number);
            completionTotal += (u.completion_tokens as number) ?? 0;
            const details = u.prompt_tokens_details as Record<string, number> | undefined;
            cachedTotal += details?.cached_tokens ?? 0;
            found = true;
          } catch { /* malformed JSON block */ }
        }
      }

      if (found) {
        return {
          input_tokens:       promptTotal,
          output_tokens:      completionTotal,
          cache_read_tokens:  cachedTotal,
          cache_write_tokens: 0,
          effective_tokens:   promptTotal - cachedTotal + completionTotal,
          cost_usd:           null,
          model_usage:        null,
        };
      }
    }
  }

  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const consolidatedPath = path.join(outputDir, 'token-dataset.jsonl');
  const metaPath = path.join(outputDir, 'run-index.json');

  // Load existing dataset to avoid re-downloading cached runs
  const existingRecords: DatasetRecord[] = [];
  const cachedRunIds = new Set<number>();
  if (fs.existsSync(consolidatedPath)) {
    for (const line of fs.readFileSync(consolidatedPath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const rec = JSON.parse(line) as DatasetRecord;
        existingRecords.push(rec);
        cachedRunIds.add(rec.run_id);
      } catch { /* skip malformed lines */ }
    }
  }

  // Also load the skip-cache: runs that were checked but had no usable data
  const skipCachePath = path.join(outputDir, '.skip-cache.json');
  let skipCache: number[] = [];
  if (fs.existsSync(skipCachePath)) {
    try { skipCache = JSON.parse(fs.readFileSync(skipCachePath, 'utf8')); } catch { /* ignore */ }
  }
  const skippedRunIds = new Set<number>(skipCache);
  for (const id of cachedRunIds) skippedRunIds.add(id); // union of both

  log(`Collecting token data from ${REPO} (since ${TOKEN_TRACKING_SINCE})`);
  log(`Output: ${outputDir}`);
  if (cachedRunIds.size > 0) {
    log(`Cached: ${cachedRunIds.size} runs already downloaded — will skip`);
  }

  // ── Step 1: List all relevant runs ─────────────────────────────────────────
  // Use per-workflow endpoints (/actions/workflows/{file}/runs) instead of the
  // general /actions/runs endpoint. The general endpoint is capped at 1000
  // results regardless of pagination, but the per-workflow endpoint returns
  // ALL matching runs — same as what you see in the GitHub UI.
  log('\n[1/3] Enumerating workflow runs per workflow file...');
  const allRuns: WorkflowRun[] = [];

  for (const [workflowFile, workflowLabel] of Object.entries(TARGET_WORKFLOW_FILES)) {
    let page = 1;
    let wfTotal = 0;
    log(`  ${workflowFile}`);

    while (true) {
      const url = `repos/${REPO}/actions/workflows/${workflowFile}/runs` +
        `?per_page=100&page=${page}&created=>=${TOKEN_TRACKING_SINCE}&status=success`;
      let res: { workflow_runs: WorkflowRun[] };
      try {
        res = ghApi(url) as { workflow_runs: WorkflowRun[] };
      } catch (e) {
        log(`    → API error page ${page}: ${(e as Error).message} — stopping`);
        break;
      }

      const batch = res.workflow_runs ?? [];
      if (batch.length === 0) break;

      // Tag each run with its human label (API returns the display name in run.name)
      allRuns.push(...batch);
      wfTotal += batch.length;

      if (batch.length < 100) break;
      page++;
    }

    log(`    → ${wfTotal} successful runs since ${TOKEN_TRACKING_SINCE}`);
  }

  // Deduplicate by run ID (unlikely but safe)
  const seen = new Set<number>();
  const uniqueRuns = allRuns.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
  log(`\nFound ${uniqueRuns.length} unique successful runs across all target workflows`);

  if (dryRun) {
    const byWf: Record<string, Record<string, number>> = {};
    for (const r of uniqueRuns) {
      const d = r.created_at.slice(0, 7); // YYYY-MM
      byWf[r.name] ??= {};
      byWf[r.name][d] = (byWf[r.name][d] ?? 0) + 1;
    }
    log('\nDry run — runs by workflow × month:');
    for (const [wf, months] of Object.entries(byWf)) {
      const parts = Object.entries(months).sort().map(([m, n]) => `${m}: ${n}`).join(', ');
      log(`  ${wf}: ${parts}`);
    }
    return;
  }

  // ── Step 2: Download artifacts + extract token data ────────────────────────
  log('\n[2/3] Downloading agent artifacts...');
  const records: DatasetRecord[] = [];
  const runIndex: RunMeta[] = [];

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-paper-'));
  let downloaded = 0;
  let skipped = 0;

  for (const run of uniqueRuns) {
    // Skip runs we already have data for or previously checked
    if (skippedRunIds.has(run.id)) continue;

    const runDir = path.join(tmpBase, String(run.id));
    const epochInfo = assignEpoch(run.created_at);

    // Determine which artifact name exists for this run.
    // Newer runs use 'agent'; older runs use 'agent-artifacts'.
    let artifactName: string | null = null;
    try {
      const { artifacts } = ghApi(`repos/${REPO}/actions/runs/${run.id}/artifacts`) as { artifacts: Artifact[] };
      if (artifacts.some(a => a.name === 'agent'))           artifactName = 'agent';
      else if (artifacts.some(a => a.name === 'agent-artifacts')) artifactName = 'agent-artifacts';
    } catch { skipped++; skippedRunIds.add(run.id); continue; }

    if (!artifactName) {
      log(`  SKIP ${run.id} (${run.name} @ ${run.created_at.slice(0, 10)}) — no agent artifact`);
      skipped++;
      skippedRunIds.add(run.id);
      continue;
    }

    log(`  GET  ${run.id} (${run.name} @ ${run.created_at.slice(0, 10)}) [${artifactName}] epoch=${epochInfo.epoch}/${epochInfo.label}`);

    try {
      fs.mkdirSync(runDir, { recursive: true });
      gh(['run', 'download', String(run.id), '--repo', REPO, '--name', artifactName, '--dir', runDir]);

      const usageSummary = extractTokenUsage(runDir);

      if (!usageSummary) {
        log(`    → no token data found, skipping`);
        skipped++;
        skippedRunIds.add(run.id);
        fs.rmSync(runDir, { recursive: true });
        continue;
      }

      // Also pick up per-call records from token-usage.jsonl when present (new runs only)
      const tokenLogPath = path.join(runDir, 'sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl');
      const perCallRecords: TokenCall[] = [];
      if (fs.existsSync(tokenLogPath)) {
        for (const line of fs.readFileSync(tokenLogPath, 'utf8').split('\n').filter(Boolean)) {
          try { perCallRecords.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }

      const models = perCallRecords.length > 0
        ? [...new Set(perCallRecords.map(r => r.model).filter(Boolean))]
        : usageSummary.model_usage ? Object.keys(usageSummary.model_usage) : [];
      const providers = [...new Set(perCallRecords.map(r => r.provider).filter(Boolean))];
      const cacheHitRate = usageSummary.input_tokens > 0
        ? usageSummary.cache_read_tokens / usageSummary.input_tokens : 0;

      const record: DatasetRecord = {
        run_id: run.id,
        workflow: run.name,
        created_at: run.created_at,
        date: run.created_at.slice(0, 10),
        branch: run.head_branch,
        artifact: artifactName,
        ...epochInfo,
        models,
        providers,
        api_calls: perCallRecords.length,
        input_tokens:       usageSummary.input_tokens,
        output_tokens:      usageSummary.output_tokens,
        cache_read_tokens:  usageSummary.cache_read_tokens,
        cache_write_tokens: usageSummary.cache_write_tokens,
        effective_tokens:   usageSummary.effective_tokens,
        cache_hit_rate:     Math.round(cacheHitRate * 1000) / 1000,
        total_tokens:       usageSummary.input_tokens + usageSummary.output_tokens,
        cost_usd:           usageSummary.cost_usd ?? null,
      };

      records.push(record);
      runIndex.push({
        run_id: run.id, workflow: run.name, created_at: run.created_at,
        epoch: epochInfo.epoch, label: epochInfo.label,
        total_tokens: record.total_tokens, effective_tokens: record.effective_tokens,
        cache_hit_rate: record.cache_hit_rate, cost_usd: record.cost_usd, models,
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

  // Persist skip cache for runs with no usable data
  fs.writeFileSync(skipCachePath, JSON.stringify([...skippedRunIds].filter(id => !cachedRunIds.has(id))));

  // ── Step 3: Write output ───────────────────────────────────────────────────
  log('\n[3/3] Writing output files...');

  // Merge existing cached records with newly downloaded ones
  const allRecords = [...existingRecords, ...records];
  // Sort by created_at for consistent ordering
  allRecords.sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Main dataset (JSONL)
  const jsonl = allRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(consolidatedPath, jsonl);
  log(`  ${consolidatedPath} (${allRecords.length} records, ${records.length} new)`);

  // Run index (JSON for quick inspection) — rebuild from all records
  const allRunIndex: RunMeta[] = allRecords.map(r => ({
    run_id: r.run_id, workflow: r.workflow, created_at: r.created_at,
    epoch: r.epoch, label: r.label,
    total_tokens: r.total_tokens, effective_tokens: r.effective_tokens,
    cache_hit_rate: r.cache_hit_rate, cost_usd: r.cost_usd ?? null, models: r.models,
  }));
  fs.writeFileSync(metaPath, JSON.stringify({ milestones: MILESTONES, runs: allRunIndex }, null, 2));
  log(`  ${metaPath}`);

  // ── Quick per-epoch summary ────────────────────────────────────────────────
  log('\n── Per-epoch summary ──────────────────────────────────────────────────');
  log('epoch | label              | workflow          | n  | avg input | avg total | cache%');
  log('------|--------------------|-------------------|----|-----------|-----------|-------');

  const byEpochWorkflow = new Map<string, DatasetRecord[]>();
  for (const r of allRecords) {
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
  cost_usd?: number | null;
  model_usage?: Record<string, unknown> | null;
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
  cost_usd: number | null;
  models: string[];
}

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

main().catch(e => { console.error(e); process.exit(1); });
