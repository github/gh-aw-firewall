/**
 * Tests for src/squid/acl-generator.ts – generateAclSections.
 *
 * Covers every branch in generateDomainAcls and generateBlockedDomainAcls:
 *  - both-protocol plain domains → allowed_domains ACL
 *  - both-protocol wildcard patterns → allowed_domains_regex ACL
 *  - HTTP-only plain domains → allowed_http_only ACL
 *  - HTTP-only wildcard patterns → allowed_http_only_regex ACL
 *  - HTTPS-only plain domains → allowed_https_only ACL
 *  - HTTPS-only wildcard patterns → allowed_https_only_regex ACL
 *  - Blocked plain domains → blocked_domains ACL + deny rule
 *  - Blocked wildcard patterns → blocked_domains_regex ACL + deny rule
 *  - Protocol-prefix / trailing-slash stripping for blocked domains
 *  - Empty / undefined blocked domains → no blocked config
 */
import { generateAclSections } from './acl-generator';
import { parseDomainConfig } from './domain-acl';

describe('generateAclSections', () => {
  // ── Empty config ────────────────────────────────────────────────────────────

  describe('empty domain config', () => {
    it('returns empty aclLines and empty blockedDomainConfig', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig([]);
      const result = generateAclSections(domainsByProto, patternsByProto);

      expect(result.aclLines).toEqual([]);
      expect(result.blockedDomainConfig.aclLines).toEqual([]);
      expect(result.blockedDomainConfig.accessRules).toEqual([]);
    });
  });

  // ── Both-protocol plain domains ─────────────────────────────────────────────

  describe('both-protocol plain domains', () => {
    it('generates allowed_domains ACL with section header', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      expect(aclLines).toContain('# ACL definitions for allowed domains (HTTP and HTTPS)');
      expect(aclLines.some(l => l.startsWith('acl allowed_domains dstdomain') && l.includes('github.com'))).toBe(true);
    });

    it('generates one ACL entry per domain', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com', 'npmjs.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      const domainAcls = aclLines.filter(l => l.startsWith('acl allowed_domains dstdomain'));
      expect(domainAcls).toHaveLength(2);
    });

    it('uses formatDomainForSquid (leading dot) for domain values', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      const aclLine = aclLines.find(l => l.startsWith('acl allowed_domains dstdomain'));
      expect(aclLine).toMatch(/^acl allowed_domains dstdomain \.github\.com$/);
    });
  });

  // ── Both-protocol wildcard patterns ─────────────────────────────────────────

  describe('both-protocol wildcard patterns', () => {
    it('generates allowed_domains_regex ACL with section header', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['*.example.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      expect(aclLines).toContain('# ACL definitions for allowed domain patterns (HTTP and HTTPS)');
      expect(aclLines.some(l => l.startsWith('acl allowed_domains_regex dstdom_regex -i'))).toBe(true);
    });

    it('inserts a blank separator before the regex ACL section when plain domains precede it', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com', '*.example.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      const patternHeaderIdx = aclLines.indexOf('# ACL definitions for allowed domain patterns (HTTP and HTTPS)');
      expect(patternHeaderIdx).toBeGreaterThan(0);
      expect(aclLines[patternHeaderIdx - 1]).toBe('');
    });
  });

  // ── HTTP-only plain domains ─────────────────────────────────────────────────

  describe('HTTP-only plain domains', () => {
    it('generates allowed_http_only ACL with section header', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['http://metrics.example.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      expect(aclLines).toContain('# ACL definitions for HTTP-only domains');
      expect(
        aclLines.some(
          l =>
            l.startsWith('acl allowed_http_only dstdomain') &&
            /\b\.metrics\.example\.com\b/.test(l)
        )
      ).toBe(true);
    });

    it('inserts blank separator before the HTTP-only section', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com', 'http://metrics.example.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      const headerIdx = aclLines.indexOf('# ACL definitions for HTTP-only domains');
      expect(headerIdx).toBeGreaterThan(0);
      expect(aclLines[headerIdx - 1]).toBe('');
    });
  });

  // ── HTTP-only wildcard patterns ─────────────────────────────────────────────

  describe('HTTP-only wildcard patterns', () => {
    it('generates allowed_http_only_regex ACL with section header', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['http://*.metrics.example.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      expect(aclLines).toContain('# ACL definitions for HTTP-only domain patterns');
      expect(aclLines.some(l => l.startsWith('acl allowed_http_only_regex dstdom_regex -i'))).toBe(true);
    });
  });

  // ── HTTPS-only plain domains ────────────────────────────────────────────────

  describe('HTTPS-only plain domains', () => {
    it('generates allowed_https_only ACL with section header', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['https://secure.example.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      expect(aclLines).toContain('# ACL definitions for HTTPS-only domains');
      expect(
        aclLines.some(l => l.startsWith('acl allowed_https_only dstdomain') && l.includes('secure.example.com'))
      ).toBe(true);
    });

    it('inserts blank separator before the HTTPS-only section', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com', 'https://secure.example.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      const headerIdx = aclLines.indexOf('# ACL definitions for HTTPS-only domains');
      expect(headerIdx).toBeGreaterThan(0);
      expect(aclLines[headerIdx - 1]).toBe('');
    });
  });

  // ── HTTPS-only wildcard patterns ────────────────────────────────────────────

  describe('HTTPS-only wildcard patterns', () => {
    it('generates allowed_https_only_regex ACL with section header', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['https://*.secure.example.com']);
      const { aclLines } = generateAclSections(domainsByProto, patternsByProto);

      expect(aclLines).toContain('# ACL definitions for HTTPS-only domain patterns');
      expect(aclLines.some(l => l.startsWith('acl allowed_https_only_regex dstdom_regex -i'))).toBe(true);
    });
  });

  // ── Blocked domains – plain ─────────────────────────────────────────────────

  describe('blocked plain domains', () => {
    it('generates blocked_domains ACL and http_access deny rule', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { blockedDomainConfig } = generateAclSections(domainsByProto, patternsByProto, ['evil.com']);

      expect(blockedDomainConfig.aclLines).toContain('# ACL definitions for blocked domains');
      expect(
        blockedDomainConfig.aclLines.some(l => l.startsWith('acl blocked_domains dstdomain') && l.includes('evil.com'))
      ).toBe(true);
      expect(blockedDomainConfig.accessRules).toContain('http_access deny blocked_domains');
    });

    it('strips https:// prefix from blocked domains before generating the ACL', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { blockedDomainConfig } = generateAclSections(domainsByProto, patternsByProto, ['https://evil.com']);

      const aclLine = blockedDomainConfig.aclLines.find(l => l.includes('evil.com'));
      expect(aclLine).toBeDefined();
      expect(aclLine).not.toContain('https://');
    });

    it('strips http:// prefix from blocked domains', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { blockedDomainConfig } = generateAclSections(domainsByProto, patternsByProto, ['http://evil.com']);

      const aclLine = blockedDomainConfig.aclLines.find(l => l.includes('evil.com'));
      expect(aclLine).toBeDefined();
      expect(aclLine).not.toContain('http://');
    });

    it('strips trailing slash from blocked domains', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { blockedDomainConfig } = generateAclSections(domainsByProto, patternsByProto, ['evil.com/']);

      const aclLine = blockedDomainConfig.aclLines.find(l => l.includes('evil.com'));
      expect(aclLine).toBeDefined();
      expect(aclLine).not.toContain('/');
    });

    it('works on a stand-alone allowlist (no allowed domains)', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig([]);
      const { blockedDomainConfig } = generateAclSections(domainsByProto, patternsByProto, ['evil.com']);

      expect(blockedDomainConfig.accessRules).toContain('http_access deny blocked_domains');
    });
  });

  // ── Blocked domains – wildcard patterns ────────────────────────────────────

  describe('blocked wildcard patterns', () => {
    it('generates blocked_domains_regex ACL and http_access deny rule', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { blockedDomainConfig } = generateAclSections(domainsByProto, patternsByProto, ['*.evil.com']);

      expect(blockedDomainConfig.aclLines).toContain('# ACL definitions for blocked domain patterns (wildcard)');
      expect(blockedDomainConfig.aclLines.some(l => l.startsWith('acl blocked_domains_regex dstdom_regex -i'))).toBe(true);
      expect(blockedDomainConfig.accessRules).toContain('http_access deny blocked_domains_regex');
    });
  });

  // ── Blocked domains – mixed plain + wildcard ────────────────────────────────

  describe('blocked mixed plain and wildcard', () => {
    it('generates both blocked_domains and blocked_domains_regex ACLs', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { blockedDomainConfig } = generateAclSections(domainsByProto, patternsByProto, [
        'evil.com',
        '*.malware.net',
      ]);

      expect(blockedDomainConfig.aclLines.some(l => l.startsWith('acl blocked_domains dstdomain'))).toBe(true);
      expect(blockedDomainConfig.aclLines.some(l => l.startsWith('acl blocked_domains_regex dstdom_regex -i'))).toBe(true);
      expect(blockedDomainConfig.accessRules).toContain('http_access deny blocked_domains');
      expect(blockedDomainConfig.accessRules).toContain('http_access deny blocked_domains_regex');
    });
  });

  // ── Empty / undefined blocked domains ──────────────────────────────────────

  describe('no blocked domains', () => {
    it('returns empty blocked config when blockedDomains is an empty array', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { blockedDomainConfig } = generateAclSections(domainsByProto, patternsByProto, []);

      expect(blockedDomainConfig.aclLines).toEqual([]);
      expect(blockedDomainConfig.accessRules).toEqual([]);
    });

    it('returns empty blocked config when blockedDomains is undefined', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { blockedDomainConfig } = generateAclSections(domainsByProto, patternsByProto, undefined);

      expect(blockedDomainConfig.aclLines).toEqual([]);
      expect(blockedDomainConfig.accessRules).toEqual([]);
    });
  });
});
