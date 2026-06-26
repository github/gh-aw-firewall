import { generateSquidConfig } from './squid-config';
import { SquidConfig } from './types';
const WILDCARD_DOMAIN_CHARS = '[a-zA-Z0-9.-]*';

describe('generateSquidConfig', () => {
  const defaultPort = 3128;

  describe('Blocklist Support', () => {
    it('should generate blocked domain ACL for plain domain', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['internal.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains dstdomain .internal.github.com');
      expect(result).toContain('http_access deny blocked_domains');
    });

    it('should generate blocked domain ACL for wildcard pattern', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        blockedDomains: ['*.internal.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains_regex dstdom_regex -i');
      expect(result).toContain(`^${WILDCARD_DOMAIN_CHARS}\\.internal\\.example\\.com$`);
      expect(result).toContain('http_access deny blocked_domains_regex');
    });

    it('should handle both plain and wildcard blocked domains', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        blockedDomains: ['internal.example.com', '*.secret.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains dstdomain .internal.example.com');
      expect(result).toContain('acl blocked_domains_regex dstdom_regex -i');
      expect(result).toContain('http_access deny blocked_domains');
      expect(result).toContain('http_access deny blocked_domains_regex');
    });

    it('should place blocked domains deny rule before allowed domains deny rule', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['internal.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      const blockRuleIndex = result.indexOf('http_access deny blocked_domains');
      const allowRuleIndex = result.indexOf('http_access deny !allowed_domains');
      expect(blockRuleIndex).toBeLessThan(allowRuleIndex);
    });

    it('should include blocklist comment section', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['internal.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('# ACL definitions for blocked domains');
      expect(result).toContain('# Deny requests to blocked domains (blocklist takes precedence)');
    });

    it('should work without blocklist (backward compatibility)', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).not.toContain('blocked_domains');
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
    });

    it('should work with empty blocklist', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: [],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).not.toContain('blocked_domains');
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
    });

    it('should normalize blocked domains (remove protocol)', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['https://internal.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains dstdomain .internal.github.com');
      expect(result).not.toContain('https://');
    });

    it('should handle multiple blocked domains', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        blockedDomains: ['internal.example.com', 'secret.example.com', 'admin.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl blocked_domains dstdomain .internal.example.com');
      expect(result).toContain('acl blocked_domains dstdomain .secret.example.com');
      expect(result).toContain('acl blocked_domains dstdomain .admin.example.com');
    });

    it('should throw error for invalid blocked domain pattern', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        blockedDomains: ['*'],
        port: defaultPort,
      };
      expect(() => generateSquidConfig(config)).toThrow();
    });
  });
});
