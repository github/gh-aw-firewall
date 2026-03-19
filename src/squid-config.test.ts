import { generateSquidConfig } from './squid-config';
import { SquidConfig } from './types';

// Pattern constant for the safer domain character class (matches the implementation)
const DOMAIN_CHAR_PATTERN = '[a-zA-Z0-9.-]*';

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

  describe('Configuration Structure', () => {
    it('should use the specified port', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: 8080,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('http_port 8080');
      expect(result).not.toContain('http_port 3128');
    });

    it('should include all required Squid configuration sections', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);

      // Check for key configuration sections
      expect(result).toContain('access_log');
      expect(result).toContain('cache_log');
      expect(result).toContain('cache deny all');
      expect(result).toContain('http_port');
      expect(result).toContain('acl localnet');
      expect(result).toContain('acl SSL_ports');
      expect(result).toContain('acl Safe_ports');
      expect(result).toContain('acl CONNECT method CONNECT');
      expect(result).toContain('http_access deny !allowed_domains');
      expect(result).toContain('dns_nameservers');
      // Check for custom log format
      expect(result).toContain('logformat firewall_detailed');
    });

    it('should allow CONNECT to Safe_ports (80 and 443) for HTTP proxy compatibility', () => {
      // See: https://github.com/github/gh-aw-firewall/issues/189
      // Node.js fetch uses CONNECT method even for HTTP connections when proxied
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);

      // Should deny CONNECT to non-Safe_ports (not just SSL_ports)
      expect(result).toContain('http_access deny CONNECT !Safe_ports');
      // Should NOT deny CONNECT to non-SSL_ports (would block port 80)
      expect(result).not.toContain('http_access deny CONNECT !SSL_ports');
      // Safe_ports should include both 80 and 443
      expect(result).toContain('acl Safe_ports port 80');
      expect(result).toContain('acl Safe_ports port 443');
    });

    it('should deny access to domains not in the allowlist', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('http_access deny !allowed_domains');
    });

    it('should disable caching', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('cache deny all');
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

  describe('Logging Configuration', () => {
    it('should include custom firewall_detailed log format', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('logformat firewall_detailed');
    });

    it('should log timestamp with milliseconds', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %ts.%03tu provides timestamp in seconds.milliseconds format
      expect(result).toMatch(/logformat firewall_detailed.*%ts\.%03tu/);
    });

    it('should log client IP and port', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %>a:%>p provides client IP:port
      expect(result).toMatch(/logformat firewall_detailed.*%>a:%>p/);
    });

    it('should log destination domain and IP:port', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %{Host}>h for domain, %<a:%<p for dest IP:port
      expect(result).toMatch(/logformat firewall_detailed.*%{Host}>h.*%<a:%<p/);
    });

    it('should log protocol and HTTP method', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %rv for protocol version, %rm for request method
      expect(result).toMatch(/logformat firewall_detailed.*%rv.*%rm/);
    });

    it('should log HTTP status code', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %>Hs for HTTP status code
      expect(result).toMatch(/logformat firewall_detailed.*%>Hs/);
    });

    it('should log decision (Squid status:hierarchy)', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // %Ss:%Sh provides decision like TCP_DENIED:HIER_NONE or TCP_TUNNEL:HIER_DIRECT
      expect(result).toMatch(/logformat firewall_detailed.*%Ss:%Sh/);
    });

    it('should include comment about CONNECT requests for HTTPS', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // For HTTPS/CONNECT requests, domain is in the URL field
      expect(result).toContain('For CONNECT requests (HTTPS), the domain is in the URL field');
    });

    it('should use firewall_detailed format for access_log', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('access_log /var/log/squid/access.log firewall_detailed');
    });

    it('should filter localhost healthcheck probes from logs', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Squid 5+ uses ACL filter on access_log directive instead of deprecated log_access
      expect(result).toContain('acl healthcheck_localhost src 127.0.0.1 ::1');
      expect(result).toContain('access_log /var/log/squid/access.log firewall_detailed !healthcheck_localhost');
      // Ensure deprecated log_access directive is NOT present (removed in Squid 5+)
      expect(result).not.toContain('log_access');
    });

    it('should place healthcheck ACL before access_log directive', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Verify the order: ACL definition comes before access_log that uses it
      const aclIndex = result.indexOf('acl healthcheck_localhost');
      const accessLogIndex = result.indexOf('access_log /var/log/squid/access.log firewall_detailed !healthcheck_localhost');

      expect(aclIndex).toBeGreaterThan(-1);
      expect(accessLogIndex).toBeGreaterThan(aclIndex);
    });
  });

  describe('Streaming/Long-lived Connection Support', () => {
    it('should include read_timeout for streaming connections', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('read_timeout 30 minutes');
    });

    it('should include connect_timeout', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('connect_timeout 30 seconds');
    });

    it('should include client_lifetime for long sessions', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('client_lifetime 8 hours');
    });

    it('should enable half_closed_clients for SSE streaming', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('half_closed_clients on');
    });

    it('should include request_timeout', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('request_timeout 2 minutes');
    });

    it('should include persistent_request_timeout', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('persistent_request_timeout 2 minutes');
    });

    it('should include pconn_timeout', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('pconn_timeout 2 minutes');
    });

    it('should include shutdown_lifetime 0 for fast shutdown', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('shutdown_lifetime 0 seconds');
    });
  });

  describe('Real-world Domain Patterns', () => {
    it('should handle GitHub-related domains', () => {
      const config: SquidConfig = {
        domains: [
          'github.com',
          'api.github.com',
          'raw.githubusercontent.com',
          'github.githubassets.com',
        ],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);

      // github.com should be present, api.github.com should be removed
      expect(result).toContain('acl allowed_domains dstdomain .github.com');
      expect(result).not.toContain('api.github.com');

      // Other independent domains should remain
      expect(result).toContain('acl allowed_domains dstdomain .raw.githubusercontent.com');
      expect(result).toContain('acl allowed_domains dstdomain .github.githubassets.com');
    });

    it('should handle AWS-related domains', () => {
      const config: SquidConfig = {
        domains: [
          'amazonaws.com',
          's3.amazonaws.com',
          'ec2.amazonaws.com',
          'lambda.us-east-1.amazonaws.com',
        ],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);

      // Only amazonaws.com should be present
      expect(result).toContain('acl allowed_domains dstdomain .amazonaws.com');
      expect(result).not.toContain('s3.amazonaws.com');
      expect(result).not.toContain('ec2.amazonaws.com');
      expect(result).not.toContain('lambda.us-east-1.amazonaws.com');

      const aclLines = result.match(/acl allowed_domains dstdomain/g);
      expect(aclLines).toHaveLength(1);
    });

    it('should handle CDN domains', () => {
      const config: SquidConfig = {
        domains: [
          'cloudflare.com',
          'cdn.cloudflare.com',
          'cdnjs.cloudflare.com',
        ],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);

      // Only cloudflare.com should be present
      expect(result).toContain('acl allowed_domains dstdomain .cloudflare.com');
      expect(result).not.toContain('cdn.cloudflare.com');
      expect(result).not.toContain('cdnjs.cloudflare.com');
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

  describe('Protocol Access Rules Order', () => {
    it('should put protocol-specific allow rules before deny rule', () => {
      const config: SquidConfig = {
        domains: ['http://api.example.com', 'both.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      const allowIndex = result.indexOf('http_access allow !CONNECT allowed_http_only');
      const denyIndex = result.indexOf('http_access deny !allowed_domains');
      expect(allowIndex).toBeGreaterThan(-1);
      expect(denyIndex).toBeGreaterThan(-1);
      expect(allowIndex).toBeLessThan(denyIndex);
    });

    it('should deny all when only protocol-specific domains are configured', () => {
      const config: SquidConfig = {
        domains: ['http://api.example.com', 'https://secure.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Should have deny all since no 'both' domains
      expect(result).toContain('http_access deny all');
      // But should have allow rules for specific protocols
      expect(result).toContain('http_access allow !CONNECT allowed_http_only');
      expect(result).toContain('http_access allow CONNECT allowed_https_only');
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
      expect(result).toContain(`^${DOMAIN_CHAR_PATTERN}\\.internal\\.example\\.com$`);
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

  describe('SSL Bump Mode', () => {
    it('should add SSL Bump section when sslBump is enabled', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('SSL Bump configuration for HTTPS content inspection');
      expect(result).toContain('ssl-bump');
      expect(result).toContain('security_file_certgen');
    });

    it('should include SSL Bump warning comment', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('SSL Bump mode enabled');
      expect(result).toContain('HTTPS traffic will be intercepted');
    });

    it('should configure HTTP port with SSL Bump', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('http_port 3128 ssl-bump');
    });

    it('should include CA certificate path', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('cert=/tmp/test/ssl/ca-cert.pem');
      expect(result).toContain('key=/tmp/test/ssl/ca-key.pem');
    });

    it('should include SSL Bump ACL steps', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl step1 at_step SslBump1');
      expect(result).toContain('acl step2 at_step SslBump2');
      expect(result).toContain('ssl_bump peek step1');
      expect(result).toContain('ssl_bump stare step2');
    });

    it('should include ssl_bump rules for allowed domains', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('ssl_bump bump allowed_domains');
      expect(result).toContain('ssl_bump terminate all');
    });

    it('should include ssl_bump rules for regex patterns only', () => {
      const config: SquidConfig = {
        domains: ['api-*.example.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('ssl_bump bump allowed_domains_regex');
      expect(result).toContain('ssl_bump terminate all');
    });

    it('should include ssl_bump rules for both plain domains and regex patterns', () => {
      const config: SquidConfig = {
        domains: ['github.com', 'api-*.example.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('ssl_bump bump allowed_domains');
      expect(result).toContain('ssl_bump bump allowed_domains_regex');
      expect(result).toContain('ssl_bump terminate all');
    });

    it('should include URL pattern ACLs when provided', () => {
      // URL patterns passed here are the output of parseUrlPatterns which now uses [^\s]*
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: true,
        caFiles: {
          certPath: '/tmp/test/ssl/ca-cert.pem',
          keyPath: '/tmp/test/ssl/ca-key.pem',
        },
        sslDbPath: '/tmp/test/ssl_db',
        urlPatterns: ['^https://github\\.com/myorg/[^\\s]*'],
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl allowed_url_0 url_regex');
      expect(result).toContain('^https://github\\.com/myorg/[^\\s]*');
    });

    it('should handle HTTP-only protocol-restricted domains', () => {
      const config: SquidConfig = {
        domains: ['http://legacy-api.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('allowed_http_only');
      expect(result).toContain('!CONNECT');
    });

    it('should handle HTTPS-only protocol-restricted domains', () => {
      const config: SquidConfig = {
        domains: ['https://secure.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('allowed_https_only');
      expect(result).toContain('CONNECT');
    });

    it('should handle mix of HTTP-only plain domains and wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['http://legacy.example.com', 'http://api-*.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Both plain and regex ACLs should be generated for http-only
      expect(result).toContain('allowed_http_only');
      expect(result).toContain('allowed_http_only_regex');
    });

    it('should handle mix of HTTPS-only plain domains and wildcard patterns', () => {
      const config: SquidConfig = {
        domains: ['https://secure.example.com', 'https://api-*.example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      // Both plain and regex ACLs should be generated for https-only
      expect(result).toContain('allowed_https_only');
      expect(result).toContain('allowed_https_only_regex');
    });

    it('should not include SSL Bump section when disabled', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        sslBump: false,
      };
      const result = generateSquidConfig(config);
      expect(result).not.toContain('SSL Bump configuration');
      expect(result).not.toContain('https_port');
      expect(result).not.toContain('ssl-bump');
    });

    it('should use http_port only when SSL Bump is disabled', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('http_port 3128');
      expect(result).not.toContain('https_port');
    });
  });
});

describe('Direct IP bypass protection', () => {
  const defaultPort = 3128;

  it('should include IPv4 deny ACL in generated config', () => {
    const config: SquidConfig = {
      domains: ['github.com'],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    expect(result).toContain('acl dst_ipv4 dstdom_regex');
    expect(result).toContain('http_access deny dst_ipv4');
  });

  it('should include IPv6 deny ACL in generated config', () => {
    const config: SquidConfig = {
      domains: ['github.com'],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    expect(result).toContain('acl dst_ipv6 dstdom_regex');
    expect(result).toContain('http_access deny dst_ipv6');
  });

  it('should place IP deny rules before domain allow/deny rules', () => {
    const config: SquidConfig = {
      domains: ['github.com'],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    const ipv4DenyPos = result.indexOf('http_access deny dst_ipv4');
    const domainDenyPos = result.indexOf('http_access deny !allowed_domains');
    expect(ipv4DenyPos).toBeGreaterThan(-1);
    expect(domainDenyPos).toBeGreaterThan(-1);
    expect(ipv4DenyPos).toBeLessThan(domainDenyPos);
  });

  it('should include IP deny rules even with no domains configured', () => {
    const config: SquidConfig = {
      domains: [],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    expect(result).toContain('http_access deny dst_ipv4');
    expect(result).toContain('http_access deny dst_ipv6');
  });

  it('should include IP deny rules in SSL Bump mode', () => {
    const config: SquidConfig = {
      domains: ['github.com'],
      port: defaultPort,
      sslBump: true,
      caFiles: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
      sslDbPath: '/tmp/ssl_db',
    };
    const result = generateSquidConfig(config);
    expect(result).toContain('http_access deny dst_ipv4');
    expect(result).toContain('http_access deny dst_ipv6');
  });
});

describe('Port validation in generateSquidConfig', () => {
  it('should accept valid single ports', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000,8080,9000',
      });
    }).not.toThrow();
  });

  it('should accept valid port ranges', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000-3010,7000-7090',
      });
    }).not.toThrow();
  });

  it('should reject invalid port numbers', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '70000',
      });
    }).toThrow('Invalid port: 70000');
  });

  it('should reject negative ports', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '-1',
      });
    }).toThrow('Invalid port: -1');
  });

  it('should reject non-numeric ports', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: 'abc',
      });
    }).toThrow('Invalid port: abc');
  });

  it('should reject invalid port ranges', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000-2000',
      });
    }).toThrow('Invalid port range: 3000-2000');
  });

  it('should reject port ranges with invalid boundaries', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000-70000',
      });
    }).toThrow('Invalid port range: 3000-70000');
  });
});

describe('Dangerous ports blocklist in generateSquidConfig', () => {
  it('should reject SSH port 22', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '22',
      });
    }).toThrow('Port 22 is blocked for security reasons');
  });

  it('should reject MySQL port 3306', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3306',
      });
    }).toThrow('Port 3306 is blocked for security reasons');
  });

  it('should reject PostgreSQL port 5432', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '5432',
      });
    }).toThrow('Port 5432 is blocked for security reasons');
  });

  it('should reject Redis port 6379', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '6379',
      });
    }).toThrow('Port 6379 is blocked for security reasons');
  });

  it('should reject MongoDB port 27017', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '27017',
      });
    }).toThrow('Port 27017 is blocked for security reasons');
  });

  it('should reject CouchDB port 5984', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '5984',
      });
    }).toThrow('Port 5984 is blocked for security reasons');
  });

  it('should reject CouchDB SSL port 6984', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '6984',
      });
    }).toThrow('Port 6984 is blocked for security reasons');
  });

  it('should reject Elasticsearch HTTP port 9200', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '9200',
      });
    }).toThrow('Port 9200 is blocked for security reasons');
  });

  it('should reject Elasticsearch transport port 9300', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '9300',
      });
    }).toThrow('Port 9300 is blocked for security reasons');
  });

  it('should reject InfluxDB HTTP port 8086', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '8086',
      });
    }).toThrow('Port 8086 is blocked for security reasons');
  });

  it('should reject InfluxDB RPC port 8088', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '8088',
      });
    }).toThrow('Port 8088 is blocked for security reasons');
  });

  it('should reject port range containing SSH (20-25)', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '20-25',
      });
    }).toThrow('Port range 20-25 includes dangerous port 22');
  });

  it('should reject port range containing MySQL (3300-3310)', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3300-3310',
      });
    }).toThrow('Port range 3300-3310 includes dangerous port 3306');
  });

  it('should reject port range containing PostgreSQL (5400-5500)', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '5400-5500',
      });
    }).toThrow('Port range 5400-5500 includes dangerous port 5432');
  });

  it('should reject port range containing InfluxDB (8080-8090)', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '8080-8090',
      });
    }).toThrow('Port range 8080-8090 includes dangerous port 8086');
  });

  it('should reject multiple ports including a dangerous one', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000,3306,8080',
      });
    }).toThrow('Port 3306 is blocked for security reasons');
  });

  it('should accept safe ports not in blocklist', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '3000,8080,9000',
      });
    }).not.toThrow();
  });

  it('should accept safe port range not overlapping with dangerous ports', () => {
    expect(() => {
      generateSquidConfig({
        domains: ['github.com'],
        port: 3128,
        enableHostAccess: true,
        allowHostPorts: '7000-7100',
      });
    }).not.toThrow();
  });
});

describe('Empty Domain List', () => {
  it('should generate config that denies all traffic when no domains are specified', () => {
    const config = {
      domains: [],
      port: 3128,
    };
    const result = generateSquidConfig(config);
    // Should deny all traffic when no domains are allowed
    expect(result).toContain('http_access deny all');
    // Should have a comment indicating no domains configured
    expect(result).toContain('# No domains configured');
    // Should not have any allowed_domains ACL
    expect(result).not.toContain('acl allowed_domains');
    expect(result).not.toContain('acl allowed_http_only');
    expect(result).not.toContain('acl allowed_https_only');
  });
});

describe('DLP Integration', () => {
  const defaultPort = 3128;

  it('should not include DLP rules when enableDlp is false', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: false,
    };
    const result = generateSquidConfig(config);
    expect(result).not.toContain('dlp_blocked');
    expect(result).not.toContain('DLP');
  });

  it('should not include DLP rules when enableDlp is undefined', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    expect(result).not.toContain('dlp_blocked');
  });

  it('should include DLP ACL and deny rules when enableDlp is true', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);
    // Should have DLP ACL definitions
    expect(result).toContain('acl dlp_blocked url_regex -i');
    // Should have DLP deny rule
    expect(result).toContain('http_access deny dlp_blocked');
    // Should still have normal domain ACLs
    expect(result).toContain('acl allowed_domains dstdomain .github.com');
  });

  it('should place DLP deny rules before domain allow rules', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);

    const dlpDenyIndex = result.indexOf('http_access deny dlp_blocked');
    const domainDenyIndex = result.indexOf('http_access deny !allowed_domains');
    // DLP deny should appear before domain deny
    expect(dlpDenyIndex).toBeGreaterThan(-1);
    expect(domainDenyIndex).toBeGreaterThan(-1);
    expect(dlpDenyIndex).toBeLessThan(domainDenyIndex);
  });

  it('should include credential patterns like ghp_ and AKIA in ACLs', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);
    // Check for a few key patterns
    expect(result).toContain('ghp_');
    expect(result).toContain('AKIA');
    expect(result).toContain('sk-ant-');
  });

  it('should work with DLP and blocked domains together', () => {
    const config = {
      domains: ['github.com'],
      blockedDomains: ['evil.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);
    // Should have both DLP and blocked domain rules
    expect(result).toContain('http_access deny dlp_blocked');
    expect(result).toContain('http_access deny blocked_domains');
    expect(result).toContain('acl dlp_blocked url_regex -i');
  });

  it('should work with DLP and SSL Bump together', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
      sslBump: true,
      caFiles: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
      sslDbPath: '/var/spool/squid_ssl_db',
    };
    const result = generateSquidConfig(config);
    // Should have DLP rules
    expect(result).toContain('http_access deny dlp_blocked');
    // Should have SSL Bump config
    expect(result).toContain('ssl_bump');
  });
});
