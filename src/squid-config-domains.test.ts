import { generateSquidConfig } from './squid-config';
import { SquidConfig } from './types';
import { DOMAIN_CHAR_PATTERN } from './domain-patterns';

describe('generateSquidConfig', () => {
  const defaultPort = 3128;

  describe('Protocol-Specific Domain Handling', () => {
    it('should treat http:// prefix as HTTP-only domain', () => {
      const config: SquidConfig = {
        domains: ['http://github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_http_only dstdomain .github.com');
      expect(result).toContain('http_access allow !CONNECT allowed_http_only');
      expect(result).not.toContain('http://');
    });

    it('should treat https:// prefix as HTTPS-only domain', () => {
      const config: SquidConfig = {
        domains: ['https://api.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_https_only dstdomain .api.github.com');
      expect(result).toContain('http_access allow CONNECT allowed_https_only');
      expect(result).not.toContain('https://');
    });

    it('should treat domain without prefix as allowing both protocols', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
      expect(result).toContain('http_access deny !allowed_domains');
    });

    it('should handle mixed protocol domains', () => {
      const config: SquidConfig = {
        domains: ['http://api.httponly.com', 'https://secure.httpsonly.com', 'both.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // HTTP-only domain
      expect(result).toContain('acl allowed_http_only dstdomain .api.httponly.com');
      // HTTPS-only domain
      expect(result).toContain('acl allowed_https_only dstdomain .secure.httpsonly.com');
      // Both protocols domain
      expect(result).toContain('acl allowed_domains dstdomain .both.com');
    });

    it('should remove trailing slash', () => {
      const config: SquidConfig = {
        domains: ['github.com/'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
      expect(result).not.toContain('github.com/');
    });

    it('should remove trailing slash with protocol prefix', () => {
      const config: SquidConfig = {
        domains: ['https://example.com/'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_https_only dstdomain .example.com');
      expect(result).not.toContain('https://');
      expect(result).not.toContain('example.com/');
    });

    it('should handle domain with port number', () => {
      const config: SquidConfig = {
        domains: ['example.com:8080'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Port should be preserved in the domain
      expect(result).toContain('acl allowed_domains dstdomain .example.com:8080');
    });

    it('should handle domain with path', () => {
      const config: SquidConfig = {
        domains: ['https://api.github.com/v3/users'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Path should be preserved (Squid handles domain matching), as HTTPS-only
      expect(result).toContain('acl allowed_https_only dstdomain .api.github.com/v3/users');
    });
  });

  describe('Subdomain Handling', () => {
    it('should add leading dot for subdomain matching', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
    });

    it('should preserve existing leading dot', () => {
      const config: SquidConfig = {
        domains: ['.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Should only have one leading dot, not two
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
      expect(result).not.toContain('..github.com');
    });

    it('should allow multiple independent domains', () => {
      const config: SquidConfig = {
        domains: ['github.com', 'gitlab.com', 'bitbucket.org'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
      expect(result).toContain('acl allowed_domains dstdomain .gitlab.com');
      expect(result).toContain('acl allowed_domains dstdomain .bitbucket.org');
    });
  });

  describe('Redundant Subdomain Removal', () => {
    it('should remove subdomain when parent domain is present', () => {
      const config: SquidConfig = {
        domains: ['github.com', 'api.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Should only contain github.com, not api.github.com
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
      expect(result).not.toContain('acl allowed_domains dstdomain .api.github.com');
      // Should only have one ACL line for github.com
      const aclLines = result.match(/acl allowed_domains dstdomain/g);
      expect(aclLines).toHaveLength(1);
    });

    it('should remove multiple subdomains when parent domain is present', () => {
      const config: SquidConfig = {
        domains: ['github.com', 'api.github.com', 'raw.github.com', 'gist.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Should only contain github.com
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
      expect(result).not.toContain('api.github.com');
      expect(result).not.toContain('raw.github.com');
      expect(result).not.toContain('gist.github.com');
      const aclLines = result.match(/acl allowed_domains dstdomain/g);
      expect(aclLines).toHaveLength(1);
    });

    it('should keep nested subdomains when intermediate parent is not present', () => {
      const config: SquidConfig = {
        domains: ['api.v2.example.com', 'example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Should only contain example.com since it's the parent
      expect(result).toContain('acl allowed_domains dstdomain .example.com');
      expect(result).not.toContain('api.v2.example.com');
    });

    it('should preserve subdomains when parent is not in the list', () => {
      const config: SquidConfig = {
        domains: ['api.github.com', 'raw.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Should contain both subdomains since github.com is not in the list
      expect(result).toContain('acl allowed_domains dstdomain .api.github.com');
      expect(result).toContain('acl allowed_domains dstdomain .raw.github.com');
      const aclLines = result.match(/acl allowed_domains dstdomain/g);
      expect(aclLines).toHaveLength(2);
    });

    it('should handle mixed parent and subdomain correctly', () => {
      const config: SquidConfig = {
        domains: ['api.github.com', 'github.com', 'gitlab.com', 'api.gitlab.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Should only contain github.com and gitlab.com (parents)
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
      expect(result).toContain('acl allowed_domains dstdomain .gitlab.com');
      expect(result).not.toContain('api.github.com');
      expect(result).not.toContain('api.gitlab.com');
      const aclLines = result.match(/acl allowed_domains dstdomain/g);
      expect(aclLines).toHaveLength(2);
    });

    it('should not remove domains that look similar but are not subdomains', () => {
      const config: SquidConfig = {
        domains: ['github.com', 'mygithub.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Both should be preserved as they are independent domains
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
      expect(result).toContain('acl allowed_domains dstdomain .mygithub.com');
      const aclLines = result.match(/acl allowed_domains dstdomain/g);
      expect(aclLines).toHaveLength(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty domain list', () => {
      const config: SquidConfig = {
        domains: [],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Should not contain any ACL lines for allowed_domains
      expect(result).not.toContain('acl allowed_domains dstdomain');
    });

    it('should handle single domain', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .example.com');
      const aclLines = result.match(/acl allowed_domains dstdomain/g);
      expect(aclLines).toHaveLength(1);
    });

    it('should handle domains with hyphens', () => {
      const config: SquidConfig = {
        domains: ['my-awesome-site.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .my-awesome-site.com');
    });

    it('should handle domains with numbers', () => {
      const config: SquidConfig = {
        domains: ['api123.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .api123.example.com');
    });

    it('should handle international domains', () => {
      const config: SquidConfig = {
        domains: ['münchen.de', '日本.jp'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .münchen.de');
      expect(result).toContain('acl allowed_domains dstdomain .日本.jp');
    });

    it('should handle duplicate domains', () => {
      const config: SquidConfig = {
        domains: ['github.com', 'github.com', 'github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Duplicates should result in same number of ACL lines (not filtered at this level)
      const aclLines = result.match(/acl allowed_domains dstdomain .github.com/g);
      expect(aclLines).toHaveLength(3);
    });

    it('should handle mixed case domains', () => {
      const config: SquidConfig = {
        domains: ['GitHub.COM', 'Api.GitHub.COM'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Case should be preserved (DNS is case-insensitive but this is up to Squid)
      expect(result).toContain('.GitHub.COM');
    });

    it('should handle very long subdomain chains', () => {
      const config: SquidConfig = {
        domains: ['a.b.c.d.e.f.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .a.b.c.d.e.f.example.com');
    });

    it('should handle TLD-only domain (edge case)', () => {
      const config: SquidConfig = {
        domains: ['com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .com');
    });
  });

  describe('Domain Ordering', () => {
    it('should preserve order of independent domains', () => {
      const config: SquidConfig = {
        domains: ['alpha.com', 'beta.com', 'gamma.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      const alphaIndex = result.indexOf('.alpha.com');
      const betaIndex = result.indexOf('.beta.com');
      const gammaIndex = result.indexOf('.gamma.com');

      expect(alphaIndex).toBeLessThan(betaIndex);
      expect(betaIndex).toBeLessThan(gammaIndex);
    });
  });

  describe('Wildcard Pattern Support', () => {
    it('should generate dstdom_regex for wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['*.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains_regex dstdom_regex -i');
      expect(result).toContain(`^${DOMAIN_CHAR_PATTERN}\\.github\\.com$`);
    });

    it('should use separate ACLs for plain and pattern domains', () => {
      const config: SquidConfig = {
        domains: ['example.com', '*.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain .example.com');
      expect(result).toContain('acl allowed_domains_regex dstdom_regex -i');
      expect(result).toContain(`^${DOMAIN_CHAR_PATTERN}\\.github\\.com$`);
    });

    it('should combine ACLs in http_access rule when both present', () => {
      const config: SquidConfig = {
        domains: ['example.com', '*.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('http_access deny !allowed_domains !allowed_domains_regex');
    });

    it('should handle only plain domains (backward compatibility)', () => {
      const config: SquidConfig = {
        domains: ['github.com', 'example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains dstdomain');
      expect(result).not.toContain('acl allowed_domains_regex dstdom_regex');
      expect(result).toContain('http_access deny !allowed_domains');
      expect(result).not.toContain('allowed_domains_regex');
    });

    it('should handle only pattern domains', () => {
      const config: SquidConfig = {
        domains: ['*.github.com', '*.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_domains_regex dstdom_regex');
      expect(result).not.toContain('acl allowed_domains dstdomain');
      expect(result).toContain('http_access deny !allowed_domains_regex');
    });

    it('should remove plain subdomain when covered by pattern', () => {
      const config: SquidConfig = {
        domains: ['*.github.com', 'api.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // api.github.com should be removed since *.github.com covers it
      expect(result).not.toContain('acl allowed_domains dstdomain .api.github.com');
      expect(result).toContain(`^${DOMAIN_CHAR_PATTERN}\\.github\\.com$`);
    });

    it('should handle middle wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['api-*.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain(`^api-${DOMAIN_CHAR_PATTERN}\\.example\\.com$`);
    });

    it('should handle multiple wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['*.github.com', '*.gitlab.com', 'api-*.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain(`^${DOMAIN_CHAR_PATTERN}\\.github\\.com$`);
      expect(result).toContain(`^${DOMAIN_CHAR_PATTERN}\\.gitlab\\.com$`);
      expect(result).toContain(`^api-${DOMAIN_CHAR_PATTERN}\\.example\\.com$`);
      // Should only have regex ACLs
      expect(result).not.toContain('acl allowed_domains dstdomain');
    });

    it('should use case-insensitive matching for patterns (-i flag)', () => {
      const config: SquidConfig = {
        domains: ['*.GitHub.COM'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // The -i flag makes matching case-insensitive
      expect(result).toContain('dstdom_regex -i');
    });

    it('should keep plain domain if not matched by pattern', () => {
      const config: SquidConfig = {
        domains: ['*.github.com', 'gitlab.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // gitlab.com should be kept as a plain domain
      expect(result).toContain('acl allowed_domains dstdomain .gitlab.com');
      expect(result).toContain('acl allowed_domains_regex dstdom_regex');
    });

    it('should throw error for overly broad patterns', () => {
      const config: SquidConfig = {
        domains: ['*'],
        port: defaultPort,
      };
      expect(() => generateSquidConfig(config)).toThrow();
    });

    it('should throw error for *.*', () => {
      const config: SquidConfig = {
        domains: ['*.*'],
        port: defaultPort,
      };
      expect(() => generateSquidConfig(config)).toThrow();
    });

    it('should include ACL section comments', () => {
      const config: SquidConfig = {
        domains: ['example.com', '*.github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('# ACL definitions for allowed domains');
      expect(result).toContain('# ACL definitions for allowed domain patterns');
    });
  });

  describe('Protocol-Specific Wildcard Patterns', () => {
    it('should handle HTTP-only wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['http://*.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_http_only_regex dstdom_regex -i');
      expect(result).toContain(`^${DOMAIN_CHAR_PATTERN}\\.example\\.com$`);
      expect(result).toContain('http_access allow !CONNECT allowed_http_only_regex');
    });

    it('should handle HTTPS-only wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['https://*.secure.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_https_only_regex dstdom_regex -i');
      expect(result).toContain(`^${DOMAIN_CHAR_PATTERN}\\.secure\\.com$`);
      expect(result).toContain('http_access allow CONNECT allowed_https_only_regex');
    });

    it('should handle mixed protocol wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['http://*.api.com', 'https://*.secure.com', '*.both.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // HTTP-only pattern
      expect(result).toContain(`acl allowed_http_only_regex dstdom_regex -i ^${DOMAIN_CHAR_PATTERN}\\.api\\.com$`);
      // HTTPS-only pattern
      expect(result).toContain(`acl allowed_https_only_regex dstdom_regex -i ^${DOMAIN_CHAR_PATTERN}\\.secure\\.com$`);
      // Both protocols pattern
      expect(result).toContain(`acl allowed_domains_regex dstdom_regex -i ^${DOMAIN_CHAR_PATTERN}\\.both\\.com$`);
    });
  });

  describe('Protocol-Specific Subdomain Handling', () => {
    it('should not remove http-only subdomain when parent has https-only', () => {
      const config: SquidConfig = {
        domains: ['https://example.com', 'http://api.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Both should be present since protocols are different
      expect(result).toContain('acl allowed_https_only dstdomain .example.com');
      expect(result).toContain('acl allowed_http_only dstdomain .api.example.com');
    });

    it('should remove subdomain when parent has "both" protocol', () => {
      const config: SquidConfig = {
        domains: ['example.com', 'http://api.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // api.example.com should be removed since example.com with 'both' covers it
      expect(result).toContain('acl allowed_domains dstdomain .example.com');
      expect(result).not.toContain('api.example.com');
    });

    it('should not remove "both" subdomain when parent has single protocol', () => {
      const config: SquidConfig = {
        domains: ['https://example.com', 'api.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Both should be present since api.example.com needs both protocols
      expect(result).toContain('acl allowed_https_only dstdomain .example.com');
      expect(result).toContain('acl allowed_domains dstdomain .api.example.com');
    });
  });
});
