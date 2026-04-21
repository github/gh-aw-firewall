#!/usr/bin/env npx tsx
/**
 * Workload Augmentation Script
 *
 * Re-downloads agent artifacts for new-format runs (artifact == 'agent') and
 * extracts workload metrics not present in the original token dataset:
 *
 *   gh_cli_calls      — number of `gh` CLI executions (exec_start events in
 *                       cli-proxy-logs/access.log). Proxy for GitHub-API work
 *                       done via the deterministic gh-CLI path (post-cli-proxy).
 *
 *   gh_cli_by_cmd     — breakdown by command, e.g. {"pr list": 3, "api graphql": 6}
 *
 *   gh_cli_success    — number of exec_done events with exitCode === 0
 *
 *   mcp_tool_calls    — outgoing MCP tool calls (method == "tools/call" in
 *                       mcp-logs/rpc-messages.jsonl). These are the complement:
 *                       work done via the MCP server path.
 *
 *   squid_gh_calls    — GitHub API calls passing through the Squid proxy
 *                       (api.github.com or graphql in squid access.log).
 *                       Available in both old and new format runs.
 *
 * Output: paper-data/workload-augment.jsonl  (one JSON object per run_id)
 * The analyze script will join this with token-dataset.jsonl on run_id.
 *
 * Usage:
 *   npx tsx scripts/paper/augment-workload.ts [--output ./paper-data] [--limit N]
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

const REPO = 'github/gh-aw-firewall';
const MAX_BUF = 64 * 1024 * 1024;

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const outputDir = args[args.indexOf('--output') + 1] ?? './paper-data';
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;
// Re-run only: skip runs already in augment file
const SKIP_EXISTING = !args.includes('--force');

// ── Load existing dataset ────────────────────────────────────────────────────
const datasetPath = path.join(outputDir, 'token-dataset.jsonl');
const augmentPath = path.join(outputDir, 'workload-augment.jsonl');

if (!fs.existsSync(datasetPath)) {
  console.error(`Dataset not found: ${datasetPath}`);
  process.exit(1);
}

// Load runs that need augmentation (new-format artifact == 'agent')
const allRecords: Array<Record<string, unknown>> = [];
for (const line of fs.readFileSync(datasetPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { allRecords.push(JSON.parse(line)); } catch { /* skip */ }
}

const targetRecords = allRecords.filter(r => r.artifact === 'agent');
console.log(`Total records: ${allRecords.length}, new-format (artifact=agent): ${targetRecords.length}`);

// Load already-augmented run_ids to support resuming
const doneIds = new Set<number>();
if (SKIP_EXISTING && fs.existsSync(augmentPath)) {
  for (const line of fs.readFileSync(augmentPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { run_id: number };
      doneIds.add(obj.run_id);
    } catch { /* skip */ }
  }
  console.log(`Already augmented: ${doneIds.size} runs (skipping)`);
}

const toProcess = targetRecords.filter(r => !doneIds.has(r.run_id as number));
console.log(`To process: ${Math.min(toProcess.length, LIMIT)} runs\n`);

// ── Extraction helpers ───────────────────────────────────────────────────────

interface WorkloadRecord {
  run_id: number;
  workflow: string;
  epoch: number;
  gh_cli_calls: number;
  gh_cli_success: number;
  gh_cli_by_cmd: Record<string, number>;
  mcp_tool_calls: number;
  squid_gh_calls: number;
}

function extractWorkload(artifactDir: string, runId: number, workflow: string, epoch: number): WorkloadRecord {
  const result: WorkloadRecord = {
    run_id: runId,
    workflow,
    epoch,
    gh_cli_calls: 0,
    gh_cli_success: 0,
    gh_cli_by_cmd: {},
    mcp_tool_calls: 0,
    squid_gh_calls: 0,
  };

  // ── 1. cli-proxy-logs/access.log ─────────────────────────────────────────
  // Nested path: sandbox/firewall/logs/cli-proxy-logs/access.log
  const cliProxyLog = path.join(artifactDir, 'sandbox', 'firewall', 'logs', 'cli-proxy-logs', 'access.log');
  if (fs.existsSync(cliProxyLog)) {
    for (const line of fs.readFileSync(cliProxyLog, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.event === 'exec_start') {
          const argArr = (entry.args as string[]) ?? [];
          // Skip meta commands (--version, --help)
          if (argArr[0]?.startsWith('-')) continue;
          result.gh_cli_calls++;
          const cmdKey = argArr.slice(0, 2).join(' ') || argArr[0] || '(unknown)';
          result.gh_cli_by_cmd[cmdKey] = (result.gh_cli_by_cmd[cmdKey] ?? 0) + 1;
        } else if (entry.event === 'exec_done' && (entry.exitCode as number) === 0) {
          const argArr = (entry.args as string[]) ?? [];
          if (argArr[0]?.startsWith('-')) continue;
          result.gh_cli_success++;
        }
      } catch { /* skip */ }
    }
  }

  // ── 2. mcp-logs/rpc-messages.jsonl ───────────────────────────────────────
  // Count outgoing tool calls (direction == 'OUT', method == 'tools/call')
  const mcpLog = path.join(artifactDir, 'mcp-logs', 'rpc-messages.jsonl');
  if (fs.existsSync(mcpLog)) {
    for (const line of fs.readFileSync(mcpLog, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.direction === 'OUT' && entry.method === 'tools/call') {
          result.mcp_tool_calls++;
        }
      } catch { /* skip */ }
    }
  }

  // ── 3. squid access.log ───────────────────────────────────────────────────
  // Count successful connects to GitHub API domains
  // Format: timestamp elapsed client action/code size method url ...
  const squidLog = path.join(artifactDir, 'sandbox', 'firewall', 'logs', 'access.log');
  if (fs.existsSync(squidLog)) {
    const ghPattern = /api\.github\.com|github\.com\/graphql|objects\.githubusercontent\.com/;
    for (const line of fs.readFileSync(squidLog, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      // Squid log columns: ts elapsed client action/status bytes method url ...
      const parts = line.split(/\s+/);
      if (parts.length < 7) continue;
      const action = parts[3] ?? '';
      const url = parts[6] ?? '';
      // Count allowed GitHub API calls (TCP_TUNNEL = HTTPS CONNECT, TCP_MISS = HTTP)
      if ((action.includes('TCP_TUNNEL') || action.includes('TCP_MISS')) && ghPattern.test(url)) {
        result.squid_gh_calls++;
      }
    }
  }

  return result;
}

// ── Main loop ────────────────────────────────────────────────────────────────
const out = fs.createWriteStream(augmentPath, { flags: 'a' });
let processed = 0;
let skippedNoArtifact = 0;
let errors = 0;

const batch = toProcess.slice(0, LIMIT);

for (let i = 0; i < batch.length; i++) {
  const record = batch[i];
  const runId = record.run_id as number;
  const workflow = record.workflow as string;
  const epoch = record.epoch as number;

  process.stdout.write(`\r[${i + 1}/${batch.length}] run ${runId} (${workflow})  `);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `awf-aug-${runId}-`));
  try {
    // Download artifact named 'agent'
    const dlResult = spawnSync(
      'gh', ['run', 'download', String(runId), '--repo', REPO, '--name', 'agent', '--dir', tmpDir],
      { maxBuffer: MAX_BUF, timeout: 120_000 }
    );

    if (dlResult.status !== 0) {
      skippedNoArtifact++;
      continue;
    }

    const workload = extractWorkload(tmpDir, runId, workflow, epoch);
    out.write(JSON.stringify(workload) + '\n');
    processed++;
  } catch (err) {
    errors++;
    process.stderr.write(`\n  ERROR run ${runId}: ${(err as Error).message}\n`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Progress summary every 50 runs
  if ((i + 1) % 50 === 0) {
    console.log(`\n  Progress: ${processed} written, ${skippedNoArtifact} no-artifact, ${errors} errors`);
  }
}

out.end();
console.log(`\n\nDone. Processed: ${processed}, no-artifact: ${skippedNoArtifact}, errors: ${errors}`);
console.log(`Output: ${augmentPath}`);
