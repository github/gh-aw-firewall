import { generateSquidConfig, generatePolicyManifest } from './squid-config';
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

describe('generatePolicyManifest', () => {
  const defaultPort = 3128;

  it('should generate manifest with basic allowed domains', () => {
    const manifest = generatePolicyManifest({
      domains: ['github.com', 'api.github.com'],
      port: defaultPort,
    });

    expect(manifest.version).toBe(1);
    expect(manifest.generatedAt).toBeDefined();
    expect(manifest.sslBumpEnabled).toBe(false);
    expect(manifest.dlpEnabled).toBe(false);

    // Should have allow-both-plain and deny-default rules
    const allowRule = manifest.rules.find(r => r.id === 'allow-both-plain');
    expect(allowRule).toBeDefined();
    expect(allowRule!.action).toBe('allow');
    expect(allowRule!.protocol).toBe('both');
    expect(allowRule!.domains).toContain('.github.com');

    const denyRule = manifest.rules.find(r => r.id === 'deny-default');
    expect(denyRule).toBeDefined();
    expect(denyRule!.action).toBe('deny');
  });

  it('should include blocked domains as deny rules with precedence', () => {
    const manifest = generatePolicyManifest({
      domains: ['github.com'],
      blockedDomains: ['evil.com'],
      port: defaultPort,
    });

    const blockedRule = manifest.rules.find(r => r.id === 'deny-blocked-plain');
    expect(blockedRule).toBeDefined();
    // Blocked domains come after port safety and raw IP rules but before allow rules
    expect(blockedRule!.action).toBe('deny');
    expect(blockedRule!.domains).toContain('.evil.com');

    const allowRule = manifest.rules.find(r => r.id === 'allow-both-plain');
    expect(allowRule).toBeDefined();
    expect(allowRule!.order).toBeGreaterThan(blockedRule!.order);
  });

  it('should handle protocol-specific domains', () => {
    const manifest = generatePolicyManifest({
      domains: ['http://httponly.com', 'https://httpsonly.com', 'both.com'],
      port: defaultPort,
    });

    const httpRule = manifest.rules.find(r => r.id === 'allow-http-only-plain');
    expect(httpRule).toBeDefined();
    expect(httpRule!.protocol).toBe('http');

    const httpsRule = manifest.rules.find(r => r.id === 'allow-https-only-plain');
    expect(httpsRule).toBeDefined();
    expect(httpsRule!.protocol).toBe('https');

    const bothRule = manifest.rules.find(r => r.id === 'allow-both-plain');
    expect(bothRule).toBeDefined();
    expect(bothRule!.protocol).toBe('both');
  });

  it('should handle wildcard domains as regex rules', () => {
    const manifest = generatePolicyManifest({
      domains: ['*.github.com'],
      port: defaultPort,
    });

    const regexRule = manifest.rules.find(r => r.id === 'allow-both-regex');
    expect(regexRule).toBeDefined();
    expect(regexRule!.aclName).toBe('allowed_domains_regex');
    expect(regexRule!.domains.length).toBeGreaterThan(0);
  });

  it('should always end with deny-default rule', () => {
    const manifest = generatePolicyManifest({
      domains: ['github.com'],
      port: defaultPort,
    });

    const lastRule = manifest.rules[manifest.rules.length - 1];
    expect(lastRule.id).toBe('deny-default');
    expect(lastRule.action).toBe('deny');
    expect(lastRule.aclName).toBe('all');
  });

  it('should include dangerous ports list', () => {
    const manifest = generatePolicyManifest({
      domains: ['github.com'],
      port: defaultPort,
    });

    expect(manifest.dangerousPorts).toContain(22);
    expect(manifest.dangerousPorts).toContain(3306);
    expect(manifest.dangerousPorts).toContain(5432);
  });

  it('should reflect config flags', () => {
    const manifest = generatePolicyManifest({
      domains: ['github.com'],
      port: defaultPort,
      sslBump: true,
      enableDlp: true,
      enableHostAccess: true,
      allowHostPorts: '3000,8080',
      dnsServers: ['1.1.1.1'],
    });

    expect(manifest.sslBumpEnabled).toBe(true);
    expect(manifest.dlpEnabled).toBe(true);
    expect(manifest.hostAccessEnabled).toBe(true);
    expect(manifest.allowHostPorts).toBe('3000,8080');
    expect(manifest.dnsServers).toEqual(['1.1.1.1']);
  });

  it('should maintain consistent rule ordering with generateSquidConfig', () => {
    // The manifest rule order should mirror the http_access rule order
    const config: SquidConfig = {
      domains: ['github.com', 'http://httponly.com'],
      blockedDomains: ['evil.com'],
      port: defaultPort,
    };

    const manifest = generatePolicyManifest(config);
    const squidConfig = generateSquidConfig(config);

    // Port safety and raw IP rules come first, then blocked domains, then allow rules
    const portRule = manifest.rules.find(r => r.id === 'deny-unsafe-ports');
    const blockedRule = manifest.rules.find(r => r.id === 'deny-blocked-plain');
    expect(portRule!.order).toBeLessThan(blockedRule!.order);
    expect(squidConfig.indexOf('deny blocked_domains')).toBeLessThan(
      squidConfig.indexOf('allow !CONNECT')
    );

    // HTTP-only should come before the catch-all deny
    const httpRule = manifest.rules.find(r => r.id === 'allow-http-only-plain');
    const denyRule = manifest.rules.find(r => r.id === 'deny-default');
    expect(httpRule!.order).toBeLessThan(denyRule!.order);
  });

  describe('Upstream Proxy Configuration', () => {
    it('generates cache_peer directive for upstream proxy', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        upstreamProxy: { host: 'proxy.corp.com', port: 3128 },
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('cache_peer proxy.corp.com parent 3128 0 no-query default');
      expect(result).toContain('never_direct allow all');
    });

    it('generates always_direct bypass for noProxy domains', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        upstreamProxy: {
          host: 'proxy.corp.com',
          port: 3128,
          noProxy: ['.corp.com', 'internal.example.com'],
        },
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('acl upstream_bypass dstdomain .corp.com');
      expect(result).toContain('acl upstream_bypass dstdomain internal.example.com');
      expect(result).toContain('acl upstream_bypass dstdomain .internal.example.com');
      expect(result).toContain('always_direct allow upstream_bypass');
      expect(result).toContain('never_direct allow all');
    });

    it('omits upstream proxy section when not configured', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).not.toContain('cache_peer');
      expect(result).not.toContain('never_direct');
    });

    it('generates upstream proxy with custom port', () => {
      const config: SquidConfig = {
        domains: ['github.com'],
        port: defaultPort,
        upstreamProxy: { host: '10.0.0.50', port: 8080 },
      };
      const result = generateSquidConfig(config);
      expect(result).toContain('cache_peer 10.0.0.50 parent 8080 0 no-query default');
    });
  });
});
