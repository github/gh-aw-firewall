#!/usr/bin/env node
/**
 * Token-usage sanity checker for the smoke workflows.
 *
 * Runs after the agent job, against the downloaded `agent` artifact, and fails
 * the workflow when the api-proxy token accounting looks wrong. Two independent
 * checks are performed, both engine-independent:
 *
 *   1. Internal consistency — the per-response records in
 *      `token-usage.jsonl` (written by the api-proxy) must sum exactly to the
 *      aggregated `agent_usage.json` summary that gh-aw derives from them. Any
 *      drift means a record was dropped, double-counted, or mis-aggregated.
 *
 *   2. Cache-read red flag — a real multi-request agentic run re-sends a
 *      growing context every turn, so the provider reports prompt-cache reads.
 *      A total `cache_read_tokens` of 0 across multiple requests indicates the
 *      api-proxy silently dropped cached tokens (the class of bug fixed in
 *      PR #5262 / issue #5203), so it is treated as a hard failure.
 *
 * The checker is intentionally zero-dependency CommonJS so the CI job only
 * needs `node` plus the downloaded artifact — no `npm ci` / `tsx`.
 *
 * Usage:
 *   node scripts/ci/check-token-usage.js --artifact-root /tmp/gh-aw --engine copilot
 *
 * Flags:
 *   --artifact-root <dir>   Root of the downloaded agent artifact (default: /tmp/gh-aw)
 *   --engine <id>           Engine id, for diagnostics only (copilot|claude|codex)
 *   --token-usage <path>    Explicit path to the per-response token-usage.jsonl
 *   --agent-usage <path>    Explicit path to the aggregated agent_usage.json
 *   --min-requests <n>      Minimum record count before cache_read==0 is fatal (default: 2)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];

/** Parse JSONL text into an array of objects, skipping blank / malformed lines. */
function parseJsonl(text) {
  const records = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Tolerate partial / non-JSON lines (e.g. truncated final write).
    }
  }
  return records;
}

/** Sum the per-response token-usage records into a single aggregate. */
function sumTokenUsage(records) {
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    count: 0,
    firstInputTokens: null,
    lastAiCreditsTotal: null,
  };

  for (const record of records) {
    if (record == null || typeof record !== 'object') continue;
    // Only count actual usage records (defensive against mixed log streams).
    if (record.event && record.event !== 'token_usage') continue;
    totals.count += 1;
    for (const field of TOKEN_FIELDS) {
      const value = record[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[field] += value;
      }
    }
    if (totals.firstInputTokens === null && typeof record.input_tokens === 'number') {
      totals.firstInputTokens = record.input_tokens;
    }
    if (typeof record.ai_credits_total === 'number' && Number.isFinite(record.ai_credits_total)) {
      totals.lastAiCreditsTotal = record.ai_credits_total;
    }
  }

  return totals;
}

/** True when two AI-credit figures agree within rounding noise. */
function aiCreditsMatch(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  const tolerance = Math.max(0.01, Math.abs(b) * 0.005);
  return Math.abs(a - b) <= tolerance;
}

/**
 * Evaluate both checks. Returns { failures: string[], warnings: string[], summary }.
 * Pure function: takes already-parsed inputs so it is trivially unit-testable.
 */
function evaluateTokenUsage({ records, aggregate, minRequests = 2 }) {
  const failures = [];
  const warnings = [];
  const totals = sumTokenUsage(records);

  if (totals.count === 0) {
    failures.push(
      'No token-usage records found. The agent produced no model requests, ' +
        'or the api-proxy failed to record usage.',
    );
    return { failures, warnings, summary: totals };
  }

  // ── Check 1: internal consistency (per-response sum === aggregate) ──
  if (!aggregate || typeof aggregate !== 'object') {
    failures.push(
      'Aggregated agent_usage summary is missing or unreadable, so per-response ' +
        'totals cannot be verified.',
    );
  } else {
    for (const field of TOKEN_FIELDS) {
      const summed = totals[field];
      const reported = typeof aggregate[field] === 'number' ? aggregate[field] : undefined;
      if (reported === undefined) {
        failures.push(`agent_usage is missing "${field}" — cannot verify consistency.`);
        continue;
      }
      if (summed !== reported) {
        failures.push(
          `Inconsistent ${field}: token-usage.jsonl sums to ${summed} across ` +
            `${totals.count} responses, but agent_usage reports ${reported} ` +
            `(delta ${summed - reported}).`,
        );
      }
    }

    // ai_credits and ambient_context are derived figures: surface drift as a
    // warning rather than failing the build on float-rounding differences.
    if (typeof aggregate.ai_credits === 'number' && totals.lastAiCreditsTotal !== null) {
      if (!aiCreditsMatch(totals.lastAiCreditsTotal, aggregate.ai_credits)) {
        warnings.push(
          `ai_credits drift: last ai_credits_total is ${totals.lastAiCreditsTotal}, ` +
            `agent_usage reports ${aggregate.ai_credits}.`,
        );
      }
    }
    if (
      typeof aggregate.ambient_context === 'number' &&
      totals.firstInputTokens !== null &&
      aggregate.ambient_context !== totals.firstInputTokens
    ) {
      warnings.push(
        `ambient_context (${aggregate.ambient_context}) does not match the first ` +
          `response input_tokens (${totals.firstInputTokens}).`,
      );
    }
  }

  // ── Check 2: cache-read red flag ──
  if (totals.cache_read_tokens === 0) {
    if (totals.count >= minRequests) {
      failures.push(
        `cache_read_tokens is 0 across ${totals.count} responses. A multi-request ` +
          'agentic run should report prompt-cache reads; zero almost always means ' +
          'the api-proxy dropped cached tokens (cf. issue #5203 / PR #5262).',
      );
    } else {
      warnings.push(
        `cache_read_tokens is 0, but only ${totals.count} response(s) were recorded ` +
          `(< ${minRequests}); too short to assert prompt caching.`,
      );
    }
  }

  return { failures, warnings, summary: totals };
}

/** Return the first path in `candidates` that exists on disk, else null. */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore and keep looking
    }
  }
  return null;
}

/** Recursively find the first file named `name` under `root` (bounded depth). */
function findFileRecursive(root, name, maxDepth = 6) {
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === name) return full;
      if (entry.isDirectory() && depth < maxDepth) {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}

/** Locate the per-response token-usage.jsonl and aggregated agent_usage.json. */
function locateUsageFiles(root, overrides = {}) {
  const tokenUsage =
    overrides.tokenUsage ||
    firstExisting([
      path.join(root, 'sandbox/firewall/logs/api-proxy-logs/token-usage.jsonl'),
      path.join(root, 'sandbox/firewall/audit/api-proxy-logs/token-usage.jsonl'),
      path.join(root, 'sandbox/firewall-audit-logs/api-proxy-logs/token-usage.jsonl'),
      path.join(root, 'usage/agent/token_usage.jsonl'),
    ]) ||
    findFileRecursive(root, 'token-usage.jsonl');

  const agentUsage =
    overrides.agentUsage ||
    firstExisting([
      path.join(root, 'agent_usage.json'),
      path.join(root, 'agent_usage.jsonl'),
      path.join(root, 'usage/agent_usage.json'),
      path.join(root, 'usage/agent_usage.jsonl'),
    ]) ||
    findFileRecursive(root, 'agent_usage.json');

  return { tokenUsage, agentUsage };
}

function parseArgs(argv) {
  const options = { artifactRoot: '/tmp/gh-aw', engine: 'unknown', minRequests: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case '--artifact-root':
        options.artifactRoot = next();
        break;
      case '--engine':
        options.engine = next();
        break;
      case '--token-usage':
        options.tokenUsage = next();
        break;
      case '--agent-usage':
        options.agentUsage = next();
        break;
      case '--min-requests':
        options.minRequests = parseInt(next(), 10) || 2;
        break;
      default:
        break;
    }
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const { tokenUsage, agentUsage } = locateUsageFiles(options.artifactRoot, {
    tokenUsage: options.tokenUsage,
    agentUsage: options.agentUsage,
  });

  console.log(`Token-usage sanity check (engine: ${options.engine})`);
  console.log(`  artifact root: ${options.artifactRoot}`);
  console.log(`  token-usage.jsonl: ${tokenUsage || '(not found)'}`);
  console.log(`  agent_usage.json:  ${agentUsage || '(not found)'}`);

  if (!tokenUsage) {
    console.error(
      '::error::Could not locate token-usage.jsonl in the agent artifact. ' +
        'The api-proxy did not record token usage.',
    );
    return 1;
  }

  const records = parseJsonl(fs.readFileSync(tokenUsage, 'utf8'));
  let aggregate = null;
  if (agentUsage) {
    const text = fs.readFileSync(agentUsage, 'utf8').trim();
    // agent_usage may be a single JSON object or a one-line JSONL file.
    const parsed = parseJsonl(text);
    aggregate = parsed.length > 0 ? parsed[parsed.length - 1] : null;
  }

  const { failures, warnings, summary } = evaluateTokenUsage({
    records,
    aggregate,
    minRequests: options.minRequests,
  });

  console.log(
    `  totals: responses=${summary.count} input=${summary.input_tokens} ` +
      `output=${summary.output_tokens} cache_read=${summary.cache_read_tokens} ` +
      `cache_write=${summary.cache_write_tokens}`,
  );

  for (const warning of warnings) {
    console.log(`::warning::${warning}`);
  }
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }

  if (failures.length > 0) {
    console.error(`Token-usage sanity check FAILED with ${failures.length} error(s).`);
    return 1;
  }
  console.log('Token-usage sanity check passed.');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  parseJsonl,
  sumTokenUsage,
  aiCreditsMatch,
  evaluateTokenUsage,
  firstExisting,
  findFileRecursive,
  locateUsageFiles,
  parseArgs,
  main,
};
