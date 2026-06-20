/**
 * Unit tests for policy-manifest.ts - uncovered branches
 *
 * Covers the regex-pattern variants of blocked/allowed domain rules
 * (lines 148-154, 173-179, 196-202) that are triggered by wildcard domains
 * with protocol prefixes.
 */

import { generatePolicyManifest } from './policy-manifest';

describe('generatePolicyManifest - regex pattern rules', () => {
  const port = 3128;

  describe('deny-blocked-regex rule', () => {
    it('should emit deny-blocked-regex rule when blockedDomains contains wildcard patterns', () => {
      const manifest = generatePolicyManifest({
        domains: ['github.com'],
        blockedDomains: ['*.evil.com'],
        port,
      });

      const regexRule = manifest.rules.find(r => r.id === 'deny-blocked-regex');
      expect(regexRule).toBeDefined();
      expect(regexRule!.action).toBe('deny');
      expect(regexRule!.protocol).toBe('both');
      expect(regexRule!.aclName).toBe('blocked_domains_regex');
      expect(regexRule!.domains.length).toBeGreaterThan(0);
    });

    it('should emit both deny-blocked-plain and deny-blocked-regex when blockedDomains has mixed plain and wildcard', () => {
      const manifest = generatePolicyManifest({
        domains: ['github.com'],
        blockedDomains: ['evil.com', '*.tracking.com'],
        port,
      });

      expect(manifest.rules.find(r => r.id === 'deny-blocked-plain')).toBeDefined();
      expect(manifest.rules.find(r => r.id === 'deny-blocked-regex')).toBeDefined();
    });

    it('deny-blocked-regex should appear before allow rules', () => {
      const manifest = generatePolicyManifest({
        domains: ['github.com'],
        blockedDomains: ['*.evil.com'],
        port,
      });

      const blockedRegexRule = manifest.rules.find(r => r.id === 'deny-blocked-regex');
      const allowRule = manifest.rules.find(r => r.id === 'allow-both-plain');
      expect(blockedRegexRule!.order).toBeLessThan(allowRule!.order);
    });

    it('should NOT emit deny-blocked-regex when blockedDomains contains only plain domains', () => {
      const manifest = generatePolicyManifest({
        domains: ['github.com'],
        blockedDomains: ['evil.com'],
        port,
      });

      expect(manifest.rules.find(r => r.id === 'deny-blocked-regex')).toBeUndefined();
    });
  });

  describe('allow-http-only-regex rule', () => {
    it('should emit allow-http-only-regex rule for http:// wildcard domains', () => {
      const manifest = generatePolicyManifest({
        domains: ['http://*.example.com'],
        port,
      });

      const regexRule = manifest.rules.find(r => r.id === 'allow-http-only-regex');
      expect(regexRule).toBeDefined();
      expect(regexRule!.action).toBe('allow');
      expect(regexRule!.protocol).toBe('http');
      expect(regexRule!.aclName).toBe('allowed_http_only_regex');
      expect(regexRule!.domains.length).toBeGreaterThan(0);
    });

    it('should emit both allow-http-only-plain and allow-http-only-regex for mixed http domains', () => {
      const manifest = generatePolicyManifest({
        domains: ['http://plain.example.com', 'http://*.wildcard.com'],
        port,
      });

      expect(manifest.rules.find(r => r.id === 'allow-http-only-plain')).toBeDefined();
      expect(manifest.rules.find(r => r.id === 'allow-http-only-regex')).toBeDefined();
    });

    it('should NOT emit allow-http-only-regex when http domains are all plain', () => {
      const manifest = generatePolicyManifest({
        domains: ['http://plain.example.com'],
        port,
      });

      expect(manifest.rules.find(r => r.id === 'allow-http-only-regex')).toBeUndefined();
    });
  });

  describe('allow-https-only-regex rule', () => {
    it('should emit allow-https-only-regex rule for https:// wildcard domains', () => {
      const manifest = generatePolicyManifest({
        domains: ['https://*.secure.com'],
        port,
      });

      const regexRule = manifest.rules.find(r => r.id === 'allow-https-only-regex');
      expect(regexRule).toBeDefined();
      expect(regexRule!.action).toBe('allow');
      expect(regexRule!.protocol).toBe('https');
      expect(regexRule!.aclName).toBe('allowed_https_only_regex');
      expect(regexRule!.domains.length).toBeGreaterThan(0);
    });

    it('should emit both allow-https-only-plain and allow-https-only-regex for mixed https domains', () => {
      const manifest = generatePolicyManifest({
        domains: ['https://api.example.com', 'https://*.cdn.com'],
        port,
      });

      expect(manifest.rules.find(r => r.id === 'allow-https-only-plain')).toBeDefined();
      expect(manifest.rules.find(r => r.id === 'allow-https-only-regex')).toBeDefined();
    });

    it('should NOT emit allow-https-only-regex when https domains are all plain', () => {
      const manifest = generatePolicyManifest({
        domains: ['https://api.example.com'],
        port,
      });

      expect(manifest.rules.find(r => r.id === 'allow-https-only-regex')).toBeUndefined();
    });
  });

  describe('combined protocol-specific regex rules', () => {
    it('should emit both http and https regex rules when both protocol variants have wildcard domains', () => {
      const manifest = generatePolicyManifest({
        domains: ['http://*.insecure.com', 'https://*.secure.com', '*.both.com'],
        port,
      });

      expect(manifest.rules.find(r => r.id === 'allow-http-only-regex')).toBeDefined();
      expect(manifest.rules.find(r => r.id === 'allow-https-only-regex')).toBeDefined();
      expect(manifest.rules.find(r => r.id === 'allow-both-regex')).toBeDefined();
    });

    it('should maintain correct rule order: port safety → raw IP → blocked → protocol allow → deny-default', () => {
      const manifest = generatePolicyManifest({
        domains: ['http://*.insecure.com', 'https://*.secure.com'],
        blockedDomains: ['*.evil.com'],
        port,
      });

      const getOrder = (id: string) => manifest.rules.find(r => r.id === id)!.order;

      expect(getOrder('deny-unsafe-ports')).toBeLessThan(getOrder('deny-raw-ipv4'));
      expect(getOrder('deny-raw-ipv4')).toBeLessThan(getOrder('deny-blocked-regex'));
      expect(getOrder('deny-blocked-regex')).toBeLessThan(getOrder('allow-http-only-regex'));
      expect(getOrder('allow-http-only-regex')).toBeLessThan(getOrder('allow-https-only-regex'));
      expect(getOrder('allow-https-only-regex')).toBeLessThan(getOrder('deny-default'));
    });
  });
});
