import { generateSquidConfig } from './squid-config';
import { SquidConfig } from './types';

describe('generateSquidConfig', () => {
  const defaultPort = 3128;

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
});
