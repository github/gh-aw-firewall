import { enrichWithPolicyRules, computeRuleStats, EnrichedLogEntry } from './audit-enricher';
import { ParsedLogEntry, PolicyManifest, PolicyRule } from '../types';

function makeEntry(overrides: Partial<ParsedLogEntry> = {}): ParsedLogEntry {
  return {
    timestamp: 1700000000.000,
    clientIp: '172.30.0.20',
    clientPort: '39748',
    host: 'github.com:443',
    destIp: '140.82.114.22',
    destPort: '443',
    protocol: '1.1',
    method: 'CONNECT',
    statusCode: 200,
    decision: 'TCP_TUNNEL:HIER_DIRECT',
    url: 'github.com:443',
    userAgent: 'curl/7.81.0',
    domain: 'github.com',
    isAllowed: true,
    isHttps: true,
    ...overrides,
  };
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

describe('enrichWithPolicyRules', () => {
  it('should match allowed request to allow-both-plain rule', () => {
    const manifest = makeManifest([
      {
        id: 'allow-both-plain',
        order: 1,
        action: 'allow',
        aclName: 'allowed_domains',
        protocol: 'both',
        domains: ['.github.com'],
        description: 'Allow HTTP and HTTPS traffic to these domains',
      },
      {
        id: 'deny-default',
        order: 2,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Default deny',
      },
    ]);

    const entries = [makeEntry({ domain: 'github.com', isAllowed: true })];
    const enriched = enrichWithPolicyRules(entries, manifest);

    expect(enriched).toHaveLength(1);
    expect(enriched[0].matchedRuleId).toBe('allow-both-plain');
  });

  it('should match subdomain to parent domain rule', () => {
    const manifest = makeManifest([
      {
        id: 'allow-both-plain',
        order: 1,
        action: 'allow',
        aclName: 'allowed_domains',
        protocol: 'both',
        domains: ['.github.com'],
        description: 'Allow',
      },
      {
        id: 'deny-default',
        order: 2,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Default deny',
      },
    ]);

    const entries = [makeEntry({ domain: 'api.github.com', isAllowed: true })];
    const enriched = enrichWithPolicyRules(entries, manifest);

    expect(enriched[0].matchedRuleId).toBe('allow-both-plain');
  });

  it('should match denied request to default deny rule', () => {
    const manifest = makeManifest([
      {
        id: 'allow-both-plain',
        order: 1,
        action: 'allow',
        aclName: 'allowed_domains',
        protocol: 'both',
        domains: ['.github.com'],
        description: 'Allow',
      },
      {
        id: 'deny-default',
        order: 2,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Default deny',
      },
    ]);

    const entries = [makeEntry({
      domain: 'evil.com',
      isAllowed: false,
      statusCode: 403,
      decision: 'TCP_DENIED:HIER_NONE',
    })];
    const enriched = enrichWithPolicyRules(entries, manifest);

    expect(enriched[0].matchedRuleId).toBe('deny-default');
  });

  it('should match blocked domain to deny-blocked rule before allow', () => {
    const manifest = makeManifest([
      {
        id: 'deny-blocked-plain',
        order: 1,
        action: 'deny',
        aclName: 'blocked_domains',
        protocol: 'both',
        domains: ['.evil.com'],
        description: 'Deny blocked',
      },
      {
        id: 'allow-both-plain',
        order: 2,
        action: 'allow',
        aclName: 'allowed_domains',
        protocol: 'both',
        domains: ['.example.com'],
        description: 'Allow',
      },
      {
        id: 'deny-default',
        order: 3,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Default deny',
      },
    ]);

    const entries = [makeEntry({
      domain: 'evil.com',
      isAllowed: false,
      statusCode: 403,
      decision: 'TCP_DENIED:HIER_NONE',
    })];
    const enriched = enrichWithPolicyRules(entries, manifest);

    expect(enriched[0].matchedRuleId).toBe('deny-blocked-plain');
  });

  it('should match regex patterns', () => {
    const manifest = makeManifest([
      {
        id: 'allow-both-regex',
        order: 1,
        action: 'allow',
        aclName: 'allowed_domains_regex',
        protocol: 'both',
        domains: ['^.*\\.github\\.com$'],
        description: 'Allow wildcard',
      },
      {
        id: 'deny-default',
        order: 2,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Default deny',
      },
    ]);

    const entries = [makeEntry({ domain: 'api.github.com', isAllowed: true })];
    const enriched = enrichWithPolicyRules(entries, manifest);

    expect(enriched[0].matchedRuleId).toBe('allow-both-regex');
  });

  it('should match raw IP deny rules (dst_ipv4 with regex patterns)', () => {
    const manifest = makeManifest([
      {
        id: 'deny-raw-ipv4',
        order: 1,
        action: 'deny',
        aclName: 'dst_ipv4',
        protocol: 'both',
        domains: ['^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'],
        description: 'Deny raw IPv4',
      },
      {
        id: 'allow-both-plain',
        order: 2,
        action: 'allow',
        aclName: 'allowed_domains',
        protocol: 'both',
        domains: ['.github.com'],
        description: 'Allow',
      },
      {
        id: 'deny-default',
        order: 3,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Default deny',
      },
    ]);

    const entries = [makeEntry({
      domain: '93.184.216.34',
      isAllowed: false,
      statusCode: 403,
      decision: 'TCP_DENIED:HIER_NONE',
    })];
    const enriched = enrichWithPolicyRules(entries, manifest);

    expect(enriched[0].matchedRuleId).toBe('deny-raw-ipv4');
  });

  it('should respect protocol-specific rules', () => {
    const manifest = makeManifest([
      {
        id: 'allow-https-only-plain',
        order: 1,
        action: 'allow',
        aclName: 'allowed_https_only',
        protocol: 'https',
        domains: ['.secure.com'],
        description: 'HTTPS only',
      },
      {
        id: 'deny-default',
        order: 2,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Default deny',
      },
    ]);

    // HTTPS request should match the HTTPS-only rule
    const httpsEntry = makeEntry({ domain: 'secure.com', isHttps: true, isAllowed: true });
    const enrichedHttps = enrichWithPolicyRules([httpsEntry], manifest);
    expect(enrichedHttps[0].matchedRuleId).toBe('allow-https-only-plain');

    // HTTP request should NOT match the HTTPS-only rule, falls to deny-default
    const httpEntry = makeEntry({ domain: 'secure.com', isHttps: false, method: 'GET', isAllowed: false });
    const enrichedHttp = enrichWithPolicyRules([httpEntry], manifest);
    expect(enrichedHttp[0].matchedRuleId).toBe('deny-default');
  });
});

describe('computeRuleStats', () => {
  it('should count hits per rule', () => {
    const manifest = makeManifest([
      {
        id: 'allow-both-plain',
        order: 1,
        action: 'allow',
        aclName: 'allowed_domains',
        protocol: 'both',
        domains: ['.github.com'],
        description: 'Allow',
      },
      {
        id: 'deny-default',
        order: 2,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Default deny',
      },
    ]);

    const entries: EnrichedLogEntry[] = [
      { ...makeEntry({ domain: 'github.com' }), matchedRuleId: 'allow-both-plain', matchReason: '' },
      { ...makeEntry({ domain: 'api.github.com' }), matchedRuleId: 'allow-both-plain', matchReason: '' },
      { ...makeEntry({ domain: 'evil.com', isAllowed: false }), matchedRuleId: 'deny-default', matchReason: '' },
    ];

    const stats = computeRuleStats(entries, manifest);

    expect(stats).toHaveLength(2);
    expect(stats.find(r => r.ruleId === 'allow-both-plain')?.hits).toBe(2);
    expect(stats.find(r => r.ruleId === 'deny-default')?.hits).toBe(1);
  });

  it('should report 0 hits for unused rules', () => {
    const manifest = makeManifest([
      {
        id: 'allow-both-plain',
        order: 1,
        action: 'allow',
        aclName: 'allowed_domains',
        protocol: 'both',
        domains: ['.github.com'],
        description: 'Allow',
      },
      {
        id: 'deny-default',
        order: 2,
        action: 'deny',
        aclName: 'all',
        protocol: 'both',
        domains: [],
        description: 'Default deny',
      },
    ]);

    const stats = computeRuleStats([], manifest);

    expect(stats).toHaveLength(2);
    expect(stats[0].hits).toBe(0);
    expect(stats[1].hits).toBe(0);
  });
});
