/**
 * Formatter for log statistics output in various formats
 */

import chalk from 'chalk';
import { AggregatedStats, DomainStats } from './log-aggregator';

/**
 * Formats aggregated stats as JSON
 *
 * @param stats - Aggregated statistics
 * @returns JSON string
 */
export function formatStatsJson(stats: AggregatedStats): string {
  // Convert Map to object for JSON serialization
  const byDomain: Record<string, Omit<DomainStats, 'domain'>> = {};
  for (const [domain, domainStats] of stats.byDomain) {
    byDomain[domain] = {
      allowed: domainStats.allowed,
      denied: domainStats.denied,
      total: domainStats.total,
    };
  }

  const output: Record<string, unknown> = {
    totalRequests: stats.totalRequests,
    allowedRequests: stats.allowedRequests,
    deniedRequests: stats.deniedRequests,
    uniqueDomains: stats.uniqueDomains,
    timeRange: stats.timeRange,
    byDomain,
  };

  if (stats.byRule) {
    output.byRule = stats.byRule;
  }

  return JSON.stringify(output, null, 2);
}

/**
 * Formats aggregated stats as markdown (suitable for GitHub Actions step summary)
 *
 * @param stats - Aggregated statistics
 * @returns Markdown string
 */
export function formatStatsMarkdown(stats: AggregatedStats): string {
  const lines: string[] = [];

  // Summary line
  const requestWord = stats.totalRequests === 1 ? 'request' : 'requests';
  const domainWord = stats.uniqueDomains === 1 ? 'domain' : 'domains';

  // Filter out "-" domain for valid domain count
  const validDomains = Array.from(stats.byDomain.values()).filter(d => d.domain !== '-');
  const validDomainCount = validDomains.length;
  
  // Show both counts if there are invalid domains
  const domainCountText =
    validDomainCount === stats.uniqueDomains
      ? `${stats.uniqueDomains} unique ${domainWord}`
      : `${stats.uniqueDomains} unique ${domainWord} (${validDomainCount} valid)`;

  lines.push('<details>');
  lines.push('<summary>Firewall Activity</summary>\n');
  lines.push(
    `▼ ${stats.totalRequests} ${requestWord} | ` +
      `${stats.allowedRequests} allowed | ` +
      `${stats.deniedRequests} blocked | ` +
      `${domainCountText}\n`
  );

  // Domain breakdown table
  if (stats.uniqueDomains > 0) {
    // Sort domains: by total requests descending
    const sortedDomains = validDomains.sort((a, b) => b.total - a.total);

    if (sortedDomains.length > 0) {
      lines.push('| Domain | Allowed | Denied |');
      lines.push('|--------|---------|--------|');

      for (const domainStats of sortedDomains) {
        lines.push(
          `| ${domainStats.domain} | ${domainStats.allowed} | ${domainStats.denied} |`
        );
      }
    } else {
      lines.push('No valid domain activity detected.');
    }
  } else {
    lines.push('No firewall activity detected.');
  }

  // Policy rules section (when available)
  if (stats.byRule && stats.byRule.length > 0) {
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>Policy Rules</summary>\n');
    lines.push('| Rule | Action | Hits | Description |');
    lines.push('|------|--------|------|-------------|');

    for (const rule of stats.byRule) {
      const actionEmoji = rule.action === 'allow' ? '✅' : '🚫';
      lines.push(`| ${rule.ruleId} | ${actionEmoji} ${rule.action} | ${rule.hits} | ${rule.description} |`);
    }

    lines.push('\n</details>');
  }

  lines.push('\n</details>\n');

  return lines.join('\n');
}

/**
 * Formats aggregated stats for terminal display (with colors)
 *
 * @param stats - Aggregated statistics
 * @param colorize - Whether to use colors (default: true)
 * @returns Formatted string
 */
export function formatStatsPretty(
  stats: AggregatedStats,
  colorize: boolean = true
): string {
  const lines: string[] = [];

  // Helper for conditional coloring - use Proxy for clean no-op fallback
  const c = colorize
    ? chalk
    : (new Proxy({}, { get: () => (s: string) => s }) as typeof chalk);

  lines.push(c.bold('Firewall Statistics'));
  lines.push(c.gray('─'.repeat(40)));
  lines.push('');

  // Overall stats
  const allowedPct =
    stats.totalRequests > 0
      ? ((stats.allowedRequests / stats.totalRequests) * 100).toFixed(1)
      : '0.0';
  const deniedPct =
    stats.totalRequests > 0
      ? ((stats.deniedRequests / stats.totalRequests) * 100).toFixed(1)
      : '0.0';

  lines.push(`Total Requests:  ${stats.totalRequests}`);
  lines.push(
    `Allowed:         ${c.green(String(stats.allowedRequests))} (${allowedPct}%)`
  );
  lines.push(
    `Denied:          ${c.red(String(stats.deniedRequests))} (${deniedPct}%)`
  );
  lines.push(`Unique Domains:  ${stats.uniqueDomains}`);

  // Time range if available
  if (stats.timeRange) {
    const startDate = new Date(stats.timeRange.start * 1000);
    const endDate = new Date(stats.timeRange.end * 1000);
    lines.push('');
    lines.push(c.gray(`Time Range: ${startDate.toISOString()} - ${endDate.toISOString()}`));
  }

  // Domain breakdown
  if (stats.uniqueDomains > 0) {
    lines.push('');
    lines.push(c.bold('Domains:'));

    // Sort by total requests descending, filter out "-"
    const sortedDomains = Array.from(stats.byDomain.values())
      .filter(d => d.domain !== '-')
      .sort((a, b) => b.total - a.total);

    // Calculate max domain length for alignment (guard against empty array)
    const maxDomainLen = sortedDomains.length > 0
      ? Math.max(...sortedDomains.map(d => d.domain.length))
      : 0;

    for (const domainStats of sortedDomains) {
      const padded = domainStats.domain.padEnd(maxDomainLen + 2);
      const allowedStr = c.green(`${domainStats.allowed} allowed`);
      const deniedStr =
        domainStats.denied > 0
          ? c.red(`${domainStats.denied} denied`)
          : c.gray(`${domainStats.denied} denied`);
      lines.push(`  ${padded}${allowedStr}, ${deniedStr}`);
    }
  }

  // Policy rules section
  if (stats.byRule && stats.byRule.length > 0) {
    lines.push(c.bold('Policy Rules:'));
    const maxIdLen = Math.max(...stats.byRule.map(r => r.ruleId.length));
    for (const rule of stats.byRule) {
      const paddedId = rule.ruleId.padEnd(maxIdLen + 2);
      const actionStr = rule.action === 'allow' ? c.green(rule.action) : c.red(rule.action);
      const hitsStr = rule.hits > 0 ? String(rule.hits) : c.gray('0');
      lines.push(`  ${paddedId}${actionStr}  ${hitsStr} hits  ${c.gray(rule.description)}`);
    }
    lines.push('');
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Formats aggregated stats based on the specified format
 *
 * @param stats - Aggregated statistics
 * @param format - Output format (json, markdown, pretty)
 * @param colorize - Whether to use colors for pretty format
 * @returns Formatted string
 */
export function formatStats(
  stats: AggregatedStats,
  format: 'json' | 'markdown' | 'pretty',
  colorize: boolean = true
): string {
  switch (format) {
    case 'json':
      return formatStatsJson(stats);
    case 'markdown':
      return formatStatsMarkdown(stats);
    case 'pretty':
    default:
      return formatStatsPretty(stats, colorize);
  }
}
