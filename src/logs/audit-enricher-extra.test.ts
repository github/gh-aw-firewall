/**
 * Additional tests for audit-enricher.ts covering branches not reached
 * by the main audit-enricher.test.ts suite.
 */
import { enrichWithPolicyRules, computeRuleStats, EnrichedLogEntry } from './audit-enricher';
import { ParsedLogEntry, PolicyManifest, PolicyRule } from '../types';
import { createLogEntry } from './log-test-fixtures.test-utils';

function makeEntry(overrides: Partial<ParsedLogEntry> = {}): ParsedLogEntry {
  return createLogEntry({
    timestamp: 1700000000.0,
    host: 'github.com:443',
    url: 'github.com:443',
    userAgent: 'curl/7.81.0',
    domain: 'github.com',
    ...overrides,
  });
}

function makeManifest(rules: PolicyRule[]): PolicyManifest {
  return {
    version: 1,
    generatedAt: '2024-01-01T00:00:00.000Z',
    rules,
    dangerousPorts: [22, 3306],
    dnsServers: ['8.8.8.8'],
    sslBumpEnabled: false,
    dlpEnabled: false,
    hostAccessEnabled: false,
    allowHostPorts: null,
  };
}

const allowRule = (overrides: Partial<PolicyRule> = {}): PolicyRule => ({
  id: 'allow-both-plain',
  order: 1,
  action: 'allow',
  aclName: 'allowed_domains',
  protocol: 'both',
  domains: ['.github.com'],
  description: 'Allow',
  ...overrides,
});

const denyAll = (order = 99): PolicyRule => ({
  id: 'deny-default',
  order,
  action: 'deny',
  aclName: 'all',
  protocol: 'both',
  domains: [],
  description: 'Default deny',
});

describe('enrichWithPolicyRules – uncovered branches', () => {
  describe('domainMatchesRule edge cases', () => {
    it('treats dash domain "-" as no-match (returns unknown)', () => {
      const manifest = makeManifest([allowRule(), denyAll()]);
      const entry = makeEntry({ domain: '-', isAllowed: false });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      // '-' does not match any domain rule; falls through to deny-default (aclName 'all')
      expect(enriched.matchedRuleId).toBe('deny-default');
    });

    it('treats empty domain as no-match, falls through to deny-default', () => {
      const manifest = makeManifest([allowRule(), denyAll()]);
      const entry = makeEntry({ domain: '', isAllowed: false });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      expect(enriched.matchedRuleId).toBe('deny-default');
    });

    it('matches domains in a rule whose domains contain regex metacharacters (non-regex aclName)', () => {
      // isRegexRule is triggered by domains containing metacharacters,
      // even when aclName does not include "regex"
      const manifest = makeManifest([
        {
          id: 'allow-meta-plain',
          order: 1,
          action: 'allow',
          aclName: 'allowed_custom',
          protocol: 'both',
          domains: ['^api\\.github\\.com$'],
          description: 'Allow via metacharacter pattern',
        },
        denyAll(),
      ]);
      const entry = makeEntry({ domain: 'api.github.com', isAllowed: true });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      expect(enriched.matchedRuleId).toBe('allow-meta-plain');
    });

    it('skips an invalid regex pattern without throwing', () => {
      // The catch block in domainMatchesRule ignores invalid patterns
      const manifest = makeManifest([
        {
          id: 'allow-bad-regex',
          order: 1,
          action: 'allow',
          aclName: 'allowed_domains_regex',
          protocol: 'both',
          // First entry is an invalid regex, second is valid and matches
          domains: ['[invalid', '^github\\.com$'],
          description: 'Allow with bad regex first',
        },
        denyAll(),
      ]);
      const entry = makeEntry({ domain: 'github.com', isAllowed: true });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      expect(enriched.matchedRuleId).toBe('allow-bad-regex');
    });

    it('does not match when every regex entry is invalid and no fallback rule covers it', () => {
      const manifest = makeManifest([
        {
          id: 'deny-bad-regex',
          order: 1,
          action: 'deny',
          aclName: 'blocked_domains_regex',
          protocol: 'both',
          domains: ['[invalid'],
          description: 'Deny with bad regex',
        },
        denyAll(),
      ]);
      const entry = makeEntry({ domain: 'github.com', isAllowed: false });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      // bad regex doesn't match, falls through to deny-default
      expect(enriched.matchedRuleId).toBe('deny-default');
    });
  });

  describe('protocol matching', () => {
    it('matches HTTP-only rule for plain HTTP request', () => {
      const manifest = makeManifest([
        {
          id: 'allow-http-only',
          order: 1,
          action: 'allow',
          aclName: 'allowed_http_only',
          protocol: 'http',
          domains: ['.example.com'],
          description: 'Allow HTTP only',
        },
        denyAll(),
      ]);
      const entry = makeEntry({ domain: 'example.com', isHttps: false, method: 'GET', isAllowed: true });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      expect(enriched.matchedRuleId).toBe('allow-http-only');
    });

    it('does not match HTTP-only rule for HTTPS request', () => {
      const manifest = makeManifest([
        {
          id: 'allow-http-only',
          order: 1,
          action: 'allow',
          aclName: 'allowed_http_only',
          protocol: 'http',
          domains: ['.example.com'],
          description: 'Allow HTTP only',
        },
        denyAll(),
      ]);
      const entry = makeEntry({ domain: 'example.com', isHttps: true, isAllowed: false });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      // HTTP-only rule skipped (HTTPS); falls through to deny-default
      expect(enriched.matchedRuleId).toBe('deny-default');
    });

    it('returns false for protocol when rule is https but request is HTTP', () => {
      const manifest = makeManifest([
        {
          id: 'allow-https-only',
          order: 1,
          action: 'allow',
          aclName: 'allowed_https_only',
          protocol: 'https',
          domains: ['.example.com'],
          description: 'Allow HTTPS only',
        },
        denyAll(),
      ]);
      const entry = makeEntry({ domain: 'example.com', isHttps: false, isAllowed: false });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      expect(enriched.matchedRuleId).toBe('deny-default');
    });
  });

  describe('unknown fallback path', () => {
    it('returns unknown matchedRuleId when no rule matches the entry', () => {
      // A manifest with only an allow rule for a specific domain and no deny-all rule
      const manifest = makeManifest([
        allowRule({ domains: ['.github.com'] }),
        // No deny-default (aclName: 'all') rule here
      ]);
      // A denied entry for a domain that doesn't match the allow rule
      const entry = makeEntry({ domain: 'unmatched.example.com', isAllowed: false });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      expect(enriched.matchedRuleId).toBe('unknown');
      expect(enriched.matchReason).toContain('Denied');
    });

    it('returns unknown matchedRuleId for an allowed entry with no matching allow rule', () => {
      const manifest = makeManifest([
        // Deny rule first, no allow rule that covers this domain
        {
          id: 'deny-blocked',
          order: 1,
          action: 'deny',
          aclName: 'blocked_domains',
          protocol: 'both',
          domains: ['.blocked.com'],
          description: 'Deny blocked',
        },
      ]);
      const entry = makeEntry({ domain: 'unmatched.com', isAllowed: true });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      expect(enriched.matchedRuleId).toBe('unknown');
      expect(enriched.matchReason).toContain('Allowed');
    });
  });

  describe('rule action mismatch skips rule', () => {
    it('skips a domain-matching rule whose action does not match the observed outcome', () => {
      // The allow rule matches the domain, but the entry was *denied* — action mismatch
      // so the loop continues and falls through to deny-default
      const manifest = makeManifest([allowRule(), denyAll()]);
      const entry = makeEntry({ domain: 'github.com', isAllowed: false });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      expect(enriched.matchedRuleId).toBe('deny-default');
    });
  });

  describe('rules with empty domains list are skipped', () => {
    it('skips non-all rules that have no domain entries', () => {
      const manifest = makeManifest([
        {
          id: 'deny-unsafe-ports',
          order: 1,
          action: 'deny',
          aclName: 'unsafe_ports',
          protocol: 'both',
          domains: [], // port-based rule — no domains
          description: 'Deny unsafe ports',
        },
        denyAll(),
      ]);
      const entry = makeEntry({ domain: 'github.com', isAllowed: false });
      const [enriched] = enrichWithPolicyRules([entry], manifest);
      // Port rule skipped (no domains); falls to deny-default
      expect(enriched.matchedRuleId).toBe('deny-default');
    });
  });
});

describe('computeRuleStats – uncovered branches', () => {
  it('skips entries with url "error:transaction-end-before-headers"', () => {
    const manifest = makeManifest([allowRule(), denyAll()]);
    const entries: EnrichedLogEntry[] = [
      {
        ...makeEntry({ url: 'error:transaction-end-before-headers' }),
        matchedRuleId: 'allow-both-plain',
        matchReason: '',
      },
    ];
    const stats = computeRuleStats(entries, manifest);
    // Despite having a matchedRuleId, the entry is skipped — 0 hits
    const allowStats = stats.find(r => r.ruleId === 'allow-both-plain');
    expect(allowStats?.hits).toBe(0);
  });

  it('includes "unknown" entry in stats when there are unknown-matched hits', () => {
    const manifest = makeManifest([allowRule(), denyAll()]);
    const entries: EnrichedLogEntry[] = [
      {
        ...makeEntry({ domain: 'unmatched.com', isAllowed: false }),
        matchedRuleId: 'unknown',
        matchReason: 'Denied (rule not identified)',
      },
    ];
    const stats = computeRuleStats(entries, manifest);
    const unknownStats = stats.find(r => r.ruleId === 'unknown');
    expect(unknownStats).toBeDefined();
    expect(unknownStats?.hits).toBe(1);
    expect(unknownStats?.action).toBe('deny');
  });

  it('does not include "unknown" row when there are no unknown hits', () => {
    const manifest = makeManifest([allowRule(), denyAll()]);
    const entries: EnrichedLogEntry[] = [
      {
        ...makeEntry({ domain: 'github.com' }),
        matchedRuleId: 'allow-both-plain',
        matchReason: 'Allow',
      },
    ];
    const stats = computeRuleStats(entries, manifest);
    expect(stats.find(r => r.ruleId === 'unknown')).toBeUndefined();
  });
});
