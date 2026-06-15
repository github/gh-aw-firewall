/**
 * Tests for src/squid/access-rules.ts – generateAccessRules.
 *
 * Covers every branch in generateProtocolRules, generateDenyRule, and
 * generateAccessRulesSection:
 *
 *  generateDenyRule
 *   - both domains + patterns  → deny !allowed_domains !allowed_domains_regex
 *   - only both-protocol plain domains  → deny !allowed_domains
 *   - only both-protocol patterns       → deny !allowed_domains_regex
 *   - only HTTP-only or HTTPS-only (no "both") → deny all
 *   - completely empty config → deny all
 *
 *  generateProtocolRules
 *   - HTTP-only plain domains only → !CONNECT allowed_http_only rule
 *   - HTTP-only patterns only      → !CONNECT allowed_http_only_regex rule
 *   - HTTP-only domains + patterns → both !CONNECT rules
 *   - HTTPS-only plain domains only → CONNECT allowed_https_only rule
 *   - HTTPS-only patterns only      → CONNECT allowed_https_only_regex rule
 *   - HTTPS-only domains + patterns → both CONNECT rules
 *   - no protocol-specific domains  → empty array
 *
 *  generateAccessRulesSection
 *   - blocked rules present  → section with header included in output
 *   - protocol rules present → section with header included in output
 *   - both absent            → empty string
 */
import { generateAccessRules } from './access-rules';
import { parseDomainConfig } from './domain-acl';

describe('generateAccessRules', () => {
  // ── denyRule generation ─────────────────────────────────────────────────────

  describe('denyRule', () => {
    it('returns "deny all" for completely empty domain config', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig([]);
      const { denyRule } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(denyRule).toBe('http_access deny all');
    });

    it('returns "deny !allowed_domains" when only both-protocol plain domains are present', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { denyRule } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(denyRule).toBe('http_access deny !allowed_domains');
    });

    it('returns "deny !allowed_domains_regex" when only both-protocol patterns are present', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['*.example.com']);
      const { denyRule } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(denyRule).toBe('http_access deny !allowed_domains_regex');
    });

    it('returns "deny !allowed_domains !allowed_domains_regex" when both-protocol domains AND patterns are present', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com', '*.example.com']);
      const { denyRule } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(denyRule).toBe('http_access deny !allowed_domains !allowed_domains_regex');
    });

    it('returns "deny all" when only HTTP-only plain domains are present', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['http://metrics.example.com']);
      const { denyRule } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(denyRule).toBe('http_access deny all');
    });

    it('returns "deny all" when only HTTPS-only plain domains are present', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['https://secure.example.com']);
      const { denyRule } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(denyRule).toBe('http_access deny all');
    });

    it('returns "deny all" when only HTTP-only patterns are present', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['http://*.metrics.example.com']);
      const { denyRule } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(denyRule).toBe('http_access deny all');
    });

    it('returns "deny all" when only HTTPS-only patterns are present', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['https://*.secure.example.com']);
      const { denyRule } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(denyRule).toBe('http_access deny all');
    });
  });

  // ── HTTP-only protocol rules ────────────────────────────────────────────────

  describe('HTTP-only protocol rules', () => {
    it('generates "allow !CONNECT allowed_http_only" for plain HTTP-only domains', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['http://metrics.example.com']);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection).toContain('http_access allow !CONNECT allowed_http_only');
    });

    it('generates "allow !CONNECT allowed_http_only_regex" for HTTP-only patterns', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['http://*.metrics.example.com']);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection).toContain('http_access allow !CONNECT allowed_http_only_regex');
    });

    it('generates both !CONNECT rules when HTTP-only domains and patterns coexist', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig([
        'http://metrics.example.com',
        'http://*.metrics2.example.com',
      ]);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection).toContain('http_access allow !CONNECT allowed_http_only');
      expect(accessRulesSection).toContain('http_access allow !CONNECT allowed_http_only_regex');
    });
  });

  // ── HTTPS-only protocol rules ───────────────────────────────────────────────

  describe('HTTPS-only protocol rules', () => {
    it('generates "allow CONNECT allowed_https_only" for plain HTTPS-only domains', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['https://secure.example.com']);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection).toContain('http_access allow CONNECT allowed_https_only');
    });

    it('generates "allow CONNECT allowed_https_only_regex" for HTTPS-only patterns', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['https://*.secure.example.com']);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection).toContain('http_access allow CONNECT allowed_https_only_regex');
    });

    it('generates both CONNECT rules when HTTPS-only domains and patterns coexist', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig([
        'https://secure.example.com',
        'https://*.secure2.example.com',
      ]);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection).toContain('http_access allow CONNECT allowed_https_only');
      expect(accessRulesSection).toContain('http_access allow CONNECT allowed_https_only_regex');
    });
  });

  // ── accessRulesSection structure ────────────────────────────────────────────

  describe('accessRulesSection', () => {
    it('is empty string when there are no protocol-specific rules and no blocked rules', () => {
      // Only both-protocol domains → no protocol rules, no blocked rules
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection).toBe('');
    });

    it('is empty string for a fully empty config with no blocked rules', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig([]);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection).toBe('');
    });

    it('includes blocked rules section header when blocked access rules are provided', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['github.com']);
      const blockedAccessRules = ['http_access deny blocked_domains'];
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, blockedAccessRules);

      expect(accessRulesSection).toContain('# Deny requests to blocked domains (blocklist takes precedence)');
      expect(accessRulesSection).toContain('http_access deny blocked_domains');
    });

    it('includes protocol rules section header when protocol-specific rules are present', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['http://metrics.example.com']);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection).toContain('# Protocol-specific domain access rules');
    });

    it('positions blocked rules before protocol-specific rules', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['http://metrics.example.com']);
      const blockedAccessRules = ['http_access deny blocked_domains'];
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, blockedAccessRules);

      const blockedHeaderPos = accessRulesSection.indexOf('# Deny requests to blocked domains');
      const protocolHeaderPos = accessRulesSection.indexOf('# Protocol-specific domain access rules');
      expect(blockedHeaderPos).toBeLessThan(protocolHeaderPos);
    });

    it('ends with a trailing newline when non-empty', () => {
      const { domainsByProto, patternsByProto } = parseDomainConfig(['http://metrics.example.com']);
      const { accessRulesSection } = generateAccessRules(domainsByProto, patternsByProto, []);

      expect(accessRulesSection.endsWith('\n')).toBe(true);
    });
  });
});
