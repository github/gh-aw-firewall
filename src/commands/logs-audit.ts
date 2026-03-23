/**
 * Command handler for `awf logs audit` subcommand
 *
 * Enriches firewall logs with policy rule matching when a policy-manifest.json
 * is available alongside the log files. Shows which specific rule caused each
 * allow/deny decision.
 */

import chalk from 'chalk';
import type { LogStatsFormat, PolicyManifest } from '../types';
import { loadAllLogs } from '../logs/log-aggregator';
import { enrichWithPolicyRules, computeRuleStats, EnrichedLogEntry } from '../logs/audit-enricher';
import {
  discoverAndSelectSource,
  findPolicyManifestForSource,
} from './logs-command-helpers';
import { logger } from '../logger';

export interface AuditCommandOptions {
  format: LogStatsFormat;
  source?: string;
  /** Filter to specific rule ID */
  rule?: string;
  /** Filter to specific domain */
  domain?: string;
  /** Filter to 'allowed' or 'denied' */
  decision?: 'allowed' | 'denied';
}

function formatAuditJson(entries: EnrichedLogEntry[]): string {
  const items = entries.map(e => ({
    timestamp: e.timestamp,
    domain: e.domain,
    method: e.method,
    status: e.statusCode,
    decision: e.isAllowed ? 'allowed' : 'denied',
    matchedRule: e.matchedRuleId,
    matchReason: e.matchReason,
    url: e.url,
  }));
  return JSON.stringify(items, null, 2);
}

function formatAuditMarkdown(entries: EnrichedLogEntry[], manifest: PolicyManifest): string {
  const lines: string[] = [];
  const ruleStats = computeRuleStats(entries, manifest);

  lines.push('## Firewall Audit Report\n');

  // Policy summary
  lines.push('### Active Policy\n');
  lines.push(`- **SSL Bump**: ${manifest.sslBumpEnabled ? 'enabled' : 'disabled'}`);
  lines.push(`- **DLP**: ${manifest.dlpEnabled ? 'enabled' : 'disabled'}`);
  lines.push(`- **Host Access**: ${manifest.hostAccessEnabled ? 'enabled' : 'disabled'}`);
  lines.push(`- **DNS Servers**: ${manifest.dnsServers.join(', ')}`);
  lines.push(`- **Dangerous Ports Blocked**: ${manifest.dangerousPorts.length} ports\n`);

  // Rule hits table
  lines.push('### Rule Evaluation\n');
  lines.push('| Rule | Action | Hits | Description |');
  lines.push('|------|--------|------|-------------|');
  for (const rule of ruleStats) {
    const actionIcon = rule.action === 'allow' ? '✅' : '🚫';
    const hitsStr = rule.hits > 0 ? `**${rule.hits}**` : '0';
    lines.push(`| ${rule.ruleId} | ${actionIcon} ${rule.action} | ${hitsStr} | ${rule.description} |`);
  }

  // Denied requests detail
  const denied = entries.filter(e => !e.isAllowed && e.url !== 'error:transaction-end-before-headers');
  if (denied.length > 0) {
    lines.push('\n### Denied Requests\n');
    lines.push('| Timestamp | Domain | Rule | Reason |');
    lines.push('|-----------|--------|------|--------|');
    for (const entry of denied.slice(0, 50)) { // Cap at 50
      const ts = new Date(entry.timestamp * 1000).toISOString();
      lines.push(`| ${ts} | ${entry.domain} | ${entry.matchedRuleId} | ${entry.matchReason} |`);
    }
    if (denied.length > 50) {
      lines.push(`\n_...and ${denied.length - 50} more denied requests_`);
    }
  }

  return lines.join('\n');
}

function formatAuditPretty(entries: EnrichedLogEntry[], manifest: PolicyManifest, colorize: boolean): string {
  const c = colorize
    ? chalk
    : (new Proxy({}, { get: () => (s: string) => s }) as typeof chalk);

  const lines: string[] = [];
  const ruleStats = computeRuleStats(entries, manifest);

  lines.push(c.bold('Firewall Audit Report'));
  lines.push(c.gray('─'.repeat(60)));
  lines.push('');

  // Rule hits
  lines.push(c.bold('Rule Evaluation:'));
  const maxIdLen = Math.max(...ruleStats.map(r => r.ruleId.length));
  for (const rule of ruleStats) {
    const paddedId = rule.ruleId.padEnd(maxIdLen + 2);
    const actionStr = rule.action === 'allow' ? c.green(rule.action) : c.red(rule.action);
    const hitsStr = rule.hits > 0 ? c.bold(String(rule.hits)) : c.gray('0');
    lines.push(`  ${paddedId}${actionStr}  ${hitsStr} hits  ${c.gray(rule.description)}`);
  }

  // Denied requests
  const denied = entries.filter(e => !e.isAllowed && e.url !== 'error:transaction-end-before-headers');
  if (denied.length > 0) {
    lines.push('');
    lines.push(c.bold(`Denied Requests (${denied.length}):`));
    for (const entry of denied.slice(0, 20)) {
      const ts = new Date(entry.timestamp * 1000).toISOString().slice(11, 23);
      lines.push(`  ${c.gray(ts)}  ${c.red(entry.domain)}  ${c.gray(`→ ${entry.matchedRuleId}`)}`);
    }
    if (denied.length > 20) {
      lines.push(c.gray(`  ...and ${denied.length - 20} more`));
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Main handler for the `awf logs audit` subcommand
 */
export async function auditCommand(options: AuditCommandOptions): Promise<void> {
  const source = await discoverAndSelectSource(options.source, {
    format: options.format,
    shouldLog: (format) => format !== 'json',
  });

  // Load raw log entries
  const entries = await loadAllLogs(source);

  if (entries.length === 0) {
    logger.error('No log entries found.');
    process.exit(1);
  }

  // Find policy manifest (uses shared discovery logic)
  const manifest = findPolicyManifestForSource(source);

  if (!manifest) {
    logger.error(
      'No policy-manifest.json found. The audit command requires a policy manifest.\n' +
      'Ensure you are using a version of awf that generates audit artifacts (--audit-dir).'
    );
    process.exit(1);
  }

  // Enrich entries with rule matching
  let enriched = enrichWithPolicyRules(entries, manifest);

  // Apply filters
  if (options.rule) {
    enriched = enriched.filter(e => e.matchedRuleId === options.rule);
  }
  if (options.domain) {
    const domainFilter = options.domain.toLowerCase();
    enriched = enriched.filter(e => e.domain.toLowerCase().includes(domainFilter));
  }
  if (options.decision) {
    const wantAllowed = options.decision === 'allowed';
    enriched = enriched.filter(e => e.isAllowed === wantAllowed);
  }

  // Filter out benign operational entries
  const meaningful = enriched.filter(e => e.url !== 'error:transaction-end-before-headers');

  // Format and output
  const colorize = !!(process.stdout.isTTY && options.format === 'pretty');
  let output: string;

  switch (options.format) {
    case 'json':
      output = formatAuditJson(meaningful);
      break;
    case 'markdown':
      output = formatAuditMarkdown(meaningful, manifest);
      break;
    case 'pretty':
    default:
      output = formatAuditPretty(meaningful, manifest, colorize);
      break;
  }

  console.log(output);
}
