/**
 * Tests for src/squid/domain-acl.ts.
 *
 * Covers all public functions:
 *   assertSafeForSquidConfig – injection-prevention defence-in-depth
 *   formatDomainForSquid     – leading-dot canonicalisation
 *   parseDomainConfig        – domain parsing, grouping, deduplication
 */
import { assertSafeForSquidConfig, formatDomainForSquid, parseDomainConfig } from './domain-acl';

// ── assertSafeForSquidConfig ────────────────────────────────────────────────

describe('assertSafeForSquidConfig', () => {
  it('returns safe domain strings unchanged', () => {
    expect(assertSafeForSquidConfig('github.com')).toBe('github.com');
    expect(assertSafeForSquidConfig('.github.com')).toBe('.github.com');
    expect(assertSafeForSquidConfig('api.internal-service.example.com')).toBe('api.internal-service.example.com');
  });

  it('throws for strings containing whitespace', () => {
    expect(() => assertSafeForSquidConfig('github.com evil.com')).toThrow(/SECURITY/);
    expect(() => assertSafeForSquidConfig('github.com\tevil.com')).toThrow(/SECURITY/);
    expect(() => assertSafeForSquidConfig('github.com\nevil.com')).toThrow(/SECURITY/);
  });

  it('throws for strings containing a double quote', () => {
    expect(() => assertSafeForSquidConfig('"github.com"')).toThrow(/SECURITY/);
  });

  it('throws for strings containing a single quote', () => {
    expect(() => assertSafeForSquidConfig("github.com'")).toThrow(/SECURITY/);
  });

  it('throws for strings containing a semicolon', () => {
    expect(() => assertSafeForSquidConfig('github.com;evil')).toThrow(/SECURITY/);
  });

  it('throws for strings containing a backtick', () => {
    expect(() => assertSafeForSquidConfig('github.com`evil`')).toThrow(/SECURITY/);
  });

  it('throws for strings containing a hash / comment character', () => {
    expect(() => assertSafeForSquidConfig('github.com#evil')).toThrow(/SECURITY/);
  });

  it('throws for strings containing a null byte', () => {
    expect(() => assertSafeForSquidConfig('github.com\x00evil')).toThrow(/SECURITY/);
  });
});

// ── formatDomainForSquid ───────────────────────────────────────────────────

describe('formatDomainForSquid', () => {
  it('prepends a dot to a plain domain', () => {
    expect(formatDomainForSquid('github.com')).toBe('.github.com');
  });

  it('leaves a domain that already starts with a dot unchanged', () => {
    expect(formatDomainForSquid('.github.com')).toBe('.github.com');
  });

  it('handles multi-level subdomains', () => {
    expect(formatDomainForSquid('api.internal.example.com')).toBe('.api.internal.example.com');
  });

  it('throws for domains containing dangerous characters', () => {
    expect(() => formatDomainForSquid('evil.com;http_access allow all')).toThrow(/SECURITY/);
  });
});

// ── parseDomainConfig ──────────────────────────────────────────────────────

describe('parseDomainConfig', () => {
  describe('empty input', () => {
    it('returns empty domain groups for an empty array', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig([]);

      expect(domainsByProto.both).toEqual([]);
      expect(domainsByProto.http).toEqual([]);
      expect(domainsByProto.https).toEqual([]);
      expect(patternsByProto.both).toEqual([]);
      expect(patternsByProto.http).toEqual([]);
      expect(patternsByProto.https).toEqual([]);
    });
  });

  describe('protocol grouping', () => {
    it('places a plain domain with no protocol prefix in domainsByProto.both', () => {
      const { domainsByProto } = parseDomainConfig(['github.com']);
      expect(domainsByProto.both).toContain('github.com');
      expect(domainsByProto.http).toHaveLength(0);
      expect(domainsByProto.https).toHaveLength(0);
    });

    it('places an http:// prefixed domain in domainsByProto.http', () => {
      const { domainsByProto } = parseDomainConfig(['http://metrics.internal.com']);
      expect(domainsByProto.http).toContain('metrics.internal.com');
      expect(domainsByProto.both).toHaveLength(0);
      expect(domainsByProto.https).toHaveLength(0);
    });

    it('places an https:// prefixed domain in domainsByProto.https', () => {
      const { domainsByProto } = parseDomainConfig(['https://secure.example.com']);
      expect(domainsByProto.https).toContain('secure.example.com');
      expect(domainsByProto.both).toHaveLength(0);
      expect(domainsByProto.http).toHaveLength(0);
    });
  });

  describe('wildcard patterns', () => {
    it('places a wildcard domain in patternsByProto.both', () => {
      const { patternsByProto, domainsByProto } = parseDomainConfig(['*.example.com']);
      expect(patternsByProto.both).toHaveLength(1);
      expect(domainsByProto.both).toHaveLength(0);
      expect(patternsByProto.both[0]).toHaveProperty('regex');
    });

    it('places an http:// wildcard in patternsByProto.http', () => {
      const { patternsByProto } = parseDomainConfig(['http://*.metrics.example.com']);
      expect(patternsByProto.http).toHaveLength(1);
      expect(patternsByProto.http[0]).toHaveProperty('regex');
    });

    it('places an https:// wildcard in patternsByProto.https', () => {
      const { patternsByProto } = parseDomainConfig(['https://*.secure.example.com']);
      expect(patternsByProto.https).toHaveLength(1);
      expect(patternsByProto.https[0]).toHaveProperty('regex');
    });
  });

  describe('subdomain deduplication', () => {
    it('removes a subdomain when its parent domain is also in the list', () => {
      const { domainsByProto } = parseDomainConfig(['api.github.com', 'github.com']);
      // api.github.com is redundant: github.com already covers it
      expect(domainsByProto.both).not.toContain('api.github.com');
      expect(domainsByProto.both).toContain('github.com');
    });

    it('keeps both domains when they share no parent-child relationship', () => {
      const { domainsByProto } = parseDomainConfig(['github.com', 'npmjs.com']);
      expect(domainsByProto.both).toContain('github.com');
      expect(domainsByProto.both).toContain('npmjs.com');
    });
  });

  describe('wildcard pattern coverage deduplication', () => {
    it('removes a plain subdomain already matched by a wildcard pattern', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['api.github.com', '*.github.com']);
      // api.github.com is covered by *.github.com — should be filtered out
      expect(domainsByProto.both).not.toContain('api.github.com');
      expect(patternsByProto.both).toHaveLength(1);
    });
  });

  describe('mixed protocol domains', () => {
    it('correctly groups multiple domains with different protocols', () => {
      const { domainsByProto } = parseDomainConfig([
        'github.com',
        'http://metrics.internal.com',
        'https://secure.example.com',
      ]);
      expect(domainsByProto.both).toContain('github.com');
      expect(domainsByProto.http).toContain('metrics.internal.com');
      expect(domainsByProto.https).toContain('secure.example.com');
    });
  });
});
