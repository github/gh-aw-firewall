#!/usr/bin/env npx tsx
/**
 * Token Usage Data Collector for gh-aw repository workflows
 *
 * Companion to collect-token-data.ts (which targets gh-aw-firewall).
 * Downloads token-usage data from GitHub Actions artifacts for the blog-referenced
 * gh-aw workflows, correlates with the optimization commit timeline, and writes
 * a consolidated JSONL dataset for analysis.
 *
 * Usage:
 *   npx tsx scripts/paper/collect-gh-aw-data.ts [--output ./paper-data] [--dry-run]
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REPO = 'github/gh-aw';
const MAX_BUF = 64 * 1024 * 1024; // 64 MB

// ── Optimization milestones for gh-aw workflows ─────────────────────────────
// Each milestone is an exclusive lower bound for the NEXT epoch.
// Runs are assigned the epoch of the most-recent milestone whose date ≤ run date.
const MILESTONES = [
  { date: '2026-03-01', epoch: 0,  label: 'baseline',                  pr: null,  description: 'Before any token optimization' },
  { date: '2026-04-06', epoch: 1,  label: 'syntax-error-opt',          pr: 24914, description: 'daily-syntax-error-quality: unblock /tmp compile, remove unused GitHub toolset' },
  { date: '2026-04-08', epoch: 2,  label: 'glossary-opt',              pr: 25228, description: 'glossary-maintainer: scope toolsets, pre-fetch git history' },
  { date: '2026-04-10', epoch: 3,  label: 'sentinel-opt',              pr: 25685, description: 'test-quality-sentinel: pre-fetch PR diff, trim toolsets, cap continuations' },
  { date: '2026-04-14', epoch: 4,  label: 'contrib-triage-opt',        pr: 26124, description: 'contribution-check + auto-triage-issues optimization' },
  { date: '2026-04-15', epoch: 5,  label: 'community-attribution-opt', pr: 26473, description: 'daily-community-attribution: pre-compute tiers, downgrade model, trim MCP' },
  { date: '2026-04-17', epoch: 6,  label: 'compiler-quality-opt',      pr: 26907, description: 'daily-compiler-quality: reduce token overhead' },
];

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
// The seven workflows referenced in the blog post's "Initial results" section
const TARGET_WORKFLOW_FILES: Record<string, string> = {
  'auto-triage-issues.lock.yml':           'Auto-Triage Issues',
  'contribution-check.lock.yml':           'Contribution Check',
  'test-quality-sentinel.lock.yml':        'Test Quality Sentinel',
  'glossary-maintainer.lock.yml':          'Glossary Maintainer',
  'daily-syntax-error-quality.lock.yml':   'Daily Syntax Error Quality',
  'daily-compiler-quality.lock.yml':       'Daily Compiler Quality',
  'daily-community-attribution.lock.yml':  'Daily Community Attribution',
};

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const i = args.indexOf(flag);
  return (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) ? args[i + 1] : def;
}
const dryRun = args.includes('--dry-run');
const outputDir = getArg('--output', './paper-data');
const COLLECT_SINCE = '2026-03-01';

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
 *  1. agent_usage.json  — present in new-format runs
 *  2. agent-stdio.log   — Claude stream-json: find the {"type":"result"} line
 *  3. token-usage.jsonl  — api-proxy per-call records (sum them up)
 */
function extractTokenUsage(dir: string): UsageSummary | null {
  // ── Source 1: agent_usage.json ──────────────────────────────────────────
  const usageJsonPath = path.join(dir, 'agent_usage.json');
  if (fs.existsSync(usageJsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(usageJsonPath, 'utf8')) as UsageSummary;
    } catch { /* fall through */ }
  }

  // ── Source 2: agent-stdio.log — Claude result line ─────────────────────
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

  // ── Source 3: token-usage.jsonl — api-proxy per-call records ────────────
  const tokenLogCandidates = [
    path.join(dir, 'sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl'),
    path.join(dir, 'token-usage.jsonl'),
  ];
  for (const tokenLogPath of tokenLogCandidates) {
    if (!fs.existsSync(tokenLogPath)) continue;
    const calls: TokenCall[] = [];
    for (const line of fs.readFileSync(tokenLogPath, 'utf8').split('\n').filter(Boolean)) {
      try { calls.push(JSON.parse(line)); } catch { /* skip */ }
    }
    if (calls.length > 0) {
      const input  = calls.reduce((s, c) => s + (c.input_tokens ?? 0), 0);
      const output = calls.reduce((s, c) => s + (c.output_tokens ?? 0), 0);
      const cacheRead  = calls.reduce((s, c) => s + (c.cache_read_tokens ?? 0), 0);
      const cacheWrite = calls.reduce((s, c) => s + (c.cache_write_tokens ?? 0), 0);
      return {
        input_tokens:       input,
        output_tokens:      output,
        cache_read_tokens:  cacheRead,
        cache_write_tokens: cacheWrite,
        effective_tokens:   input - cacheRead + output + cacheWrite,
        cost_usd:           null,
        model_usage:        null,
      };
    }
  }

  // ── Source 4: process-*.log — Copilot/OpenAI format ─────────────────────
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
          const reqMatch = lines[i].match(/\[DEBUG\] response \(Request-ID ([^)]+)\)/);
          if (!reqMatch) continue;
          const reqId = reqMatch[1];
          if (seenReqIds.has(reqId)) continue;

          let jsonLines: string[] = [];
          let j = i + 1;
          while (j < lines.length && j < i + 200) {
            const content = lines[j].replace(/^\S+ \[DEBUG\] /, '');
            if (content === 'data:') { j++; continue; }
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
  const consolidatedPath = path.join(outputDir, 'gh-aw-token-dataset.jsonl');
  const metaPath = path.join(outputDir, 'gh-aw-run-index.json');

  log(`Collecting token data from ${REPO} (since ${COLLECT_SINCE})`);
  log(`Output: ${outputDir}`);

  // ── Step 1: List all relevant runs ─────────────────────────────────────────
  log('\n[1/3] Enumerating workflow runs per workflow file...');
  const allRuns: WorkflowRun[] = [];

  for (const [workflowFile, workflowLabel] of Object.entries(TARGET_WORKFLOW_FILES)) {
    let page = 1;
    let wfTotal = 0;
    log(`  ${workflowFile}`);

    while (true) {
      const url = `repos/${REPO}/actions/workflows/${workflowFile}/runs` +
        `?per_page=100&page=${page}&created=>=${COLLECT_SINCE}&status=success`;
      let res: { workflow_runs: WorkflowRun[] };
      try {
        res = ghApi(url) as { workflow_runs: WorkflowRun[] };
      } catch (e) {
        log(`    → API error page ${page}: ${(e as Error).message} — stopping`);
        break;
      }

      const batch = res.workflow_runs ?? [];
      if (batch.length === 0) break;

      allRuns.push(...batch);
      wfTotal += batch.length;

      if (batch.length < 100) break;
      page++;
    }

    log(`    → ${wfTotal} successful runs since ${COLLECT_SINCE}`);
  }

  // Deduplicate by run ID
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

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-aw-paper-'));
  let downloaded = 0;
  let skipped = 0;

  for (const run of uniqueRuns) {
    const runDir = path.join(tmpBase, String(run.id));
    const epochInfo = assignEpoch(run.created_at);

    // Determine which artifact name exists for this run
    let artifactName: string | null = null;
    try {
      const { artifacts } = ghApi(`repos/${REPO}/actions/runs/${run.id}/artifacts`) as { artifacts: Artifact[] };
      if (artifacts.some(a => a.name === 'agent'))           artifactName = 'agent';
      else if (artifacts.some(a => a.name === 'agent-artifacts')) artifactName = 'agent-artifacts';
    } catch { skipped++; continue; }

    if (!artifactName) {
      log(`  SKIP ${run.id} (${run.name} @ ${run.created_at.slice(0, 10)}) — no agent artifact`);
      skipped++;
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
        fs.rmSync(runDir, { recursive: true });
        continue;
      }

      // Also pick up per-call records from token-usage.jsonl when present
      let perCallRecords: TokenCall[] = [];
      const tokenLogCandidates = [
        path.join(runDir, 'sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl'),
        path.join(runDir, 'token-usage.jsonl'),
      ];
      for (const tokenLogPath of tokenLogCandidates) {
        if (fs.existsSync(tokenLogPath)) {
          for (const line of fs.readFileSync(tokenLogPath, 'utf8').split('\n').filter(Boolean)) {
            try { perCallRecords.push(JSON.parse(line)); } catch { /* skip */ }
          }
          break;
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
  log('epoch | label                      | workflow                        | n  | avg ET      | avg total');
  log('------|----------------------------|---------------------------------|----|-------------|----------');

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
    const avgET = Math.round(recs.reduce((s, r) => s + r.effective_tokens, 0) / n);
    const avgTotal = Math.round(recs.reduce((s, r) => s + r.total_tokens, 0) / n);
    log(
      `  ${epochStr.padEnd(3)} | ${m.label.padEnd(26)} | ${workflow.slice(0, 31).padEnd(31)} | ${String(n).padEnd(2)} | ${String(avgET).padStart(11)} | ${String(avgTotal).padStart(9)}`
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
