/**
 * Tests for stats-formatter module
 */

import {
  formatStatsJson,
  formatStatsMarkdown,
  formatStatsPretty,
  formatStats,
} from './stats-formatter';
import { AggregatedStats, DomainStats } from './log-aggregator';
import { RuleStats } from './audit-enricher';

describe('stats-formatter', () => {
  describe('formatStatsJson', () => {
    it('should format empty stats as JSON', () => {
      const stats = createEmptyStats();
      const output = formatStatsJson(stats);
      const parsed = JSON.parse(output);

      expect(parsed.totalRequests).toBe(0);
      expect(parsed.allowedRequests).toBe(0);
      expect(parsed.deniedRequests).toBe(0);
      expect(parsed.uniqueDomains).toBe(0);
      expect(parsed.timeRange).toBeNull();
      expect(parsed.byDomain).toEqual({});
    });

    it('should format stats with domains as JSON', () => {
      const stats = createSampleStats();
      const output = formatStatsJson(stats);
      const parsed = JSON.parse(output);

      expect(parsed.totalRequests).toBe(10);
      expect(parsed.allowedRequests).toBe(8);
      expect(parsed.deniedRequests).toBe(2);
      expect(parsed.uniqueDomains).toBe(2);
      expect(parsed.byDomain['github.com']).toEqual({
        allowed: 5,
        denied: 0,
        total: 5,
      });
      expect(parsed.byDomain['evil.com']).toEqual({
        allowed: 3,
        denied: 2,
        total: 5,
      });
    });

    it('should include time range in JSON output', () => {
      const stats = createSampleStats();
      const output = formatStatsJson(stats);
      const parsed = JSON.parse(output);

      expect(parsed.timeRange).toEqual({
        start: 1000,
        end: 2000,
      });
    });
  });

  describe('formatStatsMarkdown', () => {
    it('should format empty stats as markdown', () => {
      const stats = createEmptyStats();
      const output = formatStatsMarkdown(stats);

      expect(output).toContain('<summary>Firewall Activity</summary>');
      expect(output).toContain('0 requests');
      expect(output).toContain('0 allowed');
      expect(output).toContain('0 blocked');
      expect(output).toContain('0 unique domains');
    });

    it('should format stats with domains as markdown', () => {
      const stats = createSampleStats();
      const output = formatStatsMarkdown(stats);

      expect(output).toContain('<summary>Firewall Activity</summary>');
      expect(output).toContain('10 requests');
      expect(output).toContain('8 allowed');
      expect(output).toContain('2 blocked');
      expect(output).toContain('2 unique domains');
      expect(output).toContain('| Domain | Allowed | Denied |');
      expect(output).toContain('| github.com |');
      expect(output).toContain('| evil.com |');
    });

    it('should use collapsible details section with title in summary', () => {
      const stats = createSampleStats();
      const output = formatStatsMarkdown(stats);

      expect(output).toContain('<details>');
      expect(output).toContain('<summary>Firewall Activity</summary>');
      expect(output).toContain('</details>');
    });

    it('should filter out "-" domain from table', () => {
      const stats = createEmptyStats();
      stats.byDomain.set('-', {
        domain: '-',
        allowed: 1,
        denied: 0,
        total: 1,
      });
      stats.byDomain.set('github.com', {
        domain: 'github.com',
        allowed: 2,
        denied: 0,
        total: 2,
      });
      stats.totalRequests = 3;
      stats.uniqueDomains = 2;

      const output = formatStatsMarkdown(stats);

      expect(output).toContain('github.com');
      expect(output).not.toContain('| - |');
    });

    it('should handle singular/plural correctly', () => {
      const singleRequestStats = createEmptyStats();
      singleRequestStats.totalRequests = 1;
      singleRequestStats.uniqueDomains = 1;

      const output = formatStatsMarkdown(singleRequestStats);

      expect(output).toContain('1 request |');
      expect(output).toContain('1 unique domain');
    });
  });

  describe('formatStatsPretty', () => {
    it('should format empty stats for terminal', () => {
      const stats = createEmptyStats();
      const output = formatStatsPretty(stats, false);

      expect(output).toContain('Firewall Statistics');
      expect(output).toContain('Total Requests:  0');
      expect(output).toContain('Unique Domains:  0');
    });

    it('should format stats with percentages', () => {
      const stats = createSampleStats();
      const output = formatStatsPretty(stats, false);

      expect(output).toContain('Total Requests:  10');
      expect(output).toContain('Allowed:         8 (80.0%)');
      expect(output).toContain('Denied:          2 (20.0%)');
    });

    it('should include domain breakdown', () => {
      const stats = createSampleStats();
      const output = formatStatsPretty(stats, false);

      expect(output).toContain('Domains:');
      expect(output).toContain('github.com');
      expect(output).toContain('5 allowed');
      expect(output).toContain('evil.com');
      expect(output).toContain('2 denied');
    });

    it('should include time range when available', () => {
      const stats = createSampleStats();
      const output = formatStatsPretty(stats, false);

      expect(output).toContain('Time Range:');
    });

    it('should work with colorize enabled', () => {
      const stats = createSampleStats();
      // Just verify it doesn't throw with colorize enabled
      const output = formatStatsPretty(stats, true);
      expect(output).toBeTruthy();
    });
  });

  describe('formatStats', () => {
    it('should route to JSON formatter', () => {
      const stats = createSampleStats();
      const output = formatStats(stats, 'json');

      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should route to markdown formatter', () => {
      const stats = createSampleStats();
      const output = formatStats(stats, 'markdown');

      expect(output).toContain('<summary>Firewall Activity</summary>');
    });

    it('should route to pretty formatter', () => {
      const stats = createSampleStats();
      const output = formatStats(stats, 'pretty');

      expect(output).toContain('Firewall Statistics');
    });

    it('should default to pretty format', () => {
      const stats = createSampleStats();
      const output = formatStats(stats, 'pretty');

      expect(output).toContain('Firewall Statistics');
    });
  });
});

/**
 * Helper function to create empty stats
 */
function createEmptyStats(): AggregatedStats {
  return {
    totalRequests: 0,
    allowedRequests: 0,
    deniedRequests: 0,
    uniqueDomains: 0,
    byDomain: new Map(),
    timeRange: null,
  };
}

/**
 * Helper function to create sample stats with data
 */
function createSampleStats(): AggregatedStats {
  const byDomain = new Map<string, DomainStats>();
  byDomain.set('github.com', {
    domain: 'github.com',
    allowed: 5,
    denied: 0,
    total: 5,
  });
  byDomain.set('evil.com', {
    domain: 'evil.com',
    allowed: 3,
    denied: 2,
    total: 5,
  });

  return {
    totalRequests: 10,
    allowedRequests: 8,
    deniedRequests: 2,
    uniqueDomains: 2,
    byDomain,
    timeRange: { start: 1000, end: 2000 },
  };
}

describe('byRule stats in formatters', () => {
  const ruleStats: RuleStats[] = [
    { ruleId: 'allow-both-plain', description: 'Allow domains', action: 'allow', hits: 8 },
    { ruleId: 'deny-default', description: 'Default deny', action: 'deny', hits: 2 },
  ];

  function statsWithRules(): AggregatedStats {
    return { ...createSampleStats(), byRule: ruleStats };
  }

  it('should include byRule in JSON output', () => {
    const output = formatStatsJson(statsWithRules());
    const parsed = JSON.parse(output);
    expect(parsed.byRule).toBeDefined();
    expect(parsed.byRule).toHaveLength(2);
    expect(parsed.byRule[0].ruleId).toBe('allow-both-plain');
  });

  it('should not include byRule in JSON when absent', () => {
    const output = formatStatsJson(createSampleStats());
    const parsed = JSON.parse(output);
    expect(parsed.byRule).toBeUndefined();
  });

  it('should include Policy Rules section in markdown', () => {
    const output = formatStatsMarkdown(statsWithRules());
    expect(output).toContain('Policy Rules');
    expect(output).toContain('allow-both-plain');
    expect(output).toContain('deny-default');
  });

  it('should not include Policy Rules in markdown when absent', () => {
    const output = formatStatsMarkdown(createSampleStats());
    expect(output).not.toContain('Policy Rules');
  });

  it('should include Policy Rules in pretty output', () => {
    const output = formatStatsPretty(statsWithRules(), false);
    expect(output).toContain('Policy Rules');
    expect(output).toContain('allow-both-plain');
  });

  it('should not include Policy Rules in pretty when absent', () => {
    const output = formatStatsPretty(createSampleStats(), false);
    expect(output).not.toContain('Policy Rules');
  });
});
