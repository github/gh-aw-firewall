import { generateSquidConfig, generatePolicyManifest } from './squid-config';
import { SquidConfig } from './types';

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

    it('rejects unsafe upstream host values', () => {
      expect(() => {
        generateSquidConfig({
          domains: ['github.com'],
          port: defaultPort,
          upstreamProxy: { host: 'proxy.corp.com\nhttp_access allow all', port: 3128 },
        });
      }).toThrow(/SECURITY/);
    });

    it('rejects unsafe upstream noProxy values', () => {
      expect(() => {
        generateSquidConfig({
          domains: ['github.com'],
          port: defaultPort,
          upstreamProxy: {
            host: 'proxy.corp.com',
            port: 3128,
            noProxy: ['internal.example.com#inject'],
          },
        });
      }).toThrow(/SECURITY/);
    });
  });

  describe('Api-Proxy Sidecar Configuration', () => {
    const apiProxyIp = '172.30.0.30';
    const apiProxyPorts = [10000, 10001, 10002, 10003];

    it('should add api-proxy ports to Safe_ports when apiProxyPorts is set', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
        apiProxyIp,
        apiProxyPorts,
      };
      const result = generateSquidConfig(config);
      for (const p of apiProxyPorts) {
        expect(result).toContain(`acl Safe_ports port ${p}`);
      }
    });

    it('should insert allow_api_proxy_ip rule before http_access deny dst_ipv4', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
        apiProxyIp,
        apiProxyPorts,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain(`acl allow_api_proxy_ip dst ${apiProxyIp}`);
      expect(result).toContain('http_access allow allow_api_proxy_ip');
      const allowPos = result.indexOf('http_access allow allow_api_proxy_ip');
      const denyIpv4Pos = result.indexOf('http_access deny dst_ipv4');
      expect(allowPos).toBeLessThan(denyIpv4Pos);
    });

    it('should insert from_api_proxy src rule before domain denyRule', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
        apiProxyIp,
        apiProxyPorts,
      };
      const result = generateSquidConfig(config);
      expect(result).toContain(`acl from_api_proxy src ${apiProxyIp}/32`);
      expect(result).toContain('http_access allow from_api_proxy');
      // from_api_proxy allow rule must fire before the domain denyRule
      const fromApiProxyPos = result.indexOf('http_access allow from_api_proxy');
      const denyRulePos = result.indexOf('http_access deny !allowed_domains');
      expect(fromApiProxyPos).toBeLessThan(denyRulePos);
    });

    it('should not emit api-proxy rules when apiProxyIp is not set', () => {
      const config: SquidConfig = {
        domains: ['example.com'],
        port: defaultPort,
      };
      const result = generateSquidConfig(config);
      expect(result).not.toContain('allow_api_proxy_ip');
      expect(result).not.toContain('from_api_proxy');
    });

    it('should reject non-integer apiProxyPorts values', () => {
      expect(() => {
        generateSquidConfig({
          domains: ['example.com'],
          port: defaultPort,
          apiProxyIp,
          apiProxyPorts: [10000, NaN],
        });
      }).toThrow(/Invalid api-proxy port/);
    });

    it('should reject out-of-range apiProxyPorts values', () => {
      expect(() => {
        generateSquidConfig({
          domains: ['example.com'],
          port: defaultPort,
          apiProxyIp,
          apiProxyPorts: [0],
        });
      }).toThrow(/Invalid api-proxy port/);

      expect(() => {
        generateSquidConfig({
          domains: ['example.com'],
          port: defaultPort,
          apiProxyIp,
          apiProxyPorts: [65536],
        });
      }).toThrow(/Invalid api-proxy port/);
    });

    it('should reject dangerous apiProxyPorts values', () => {
      expect(() => {
        generateSquidConfig({
          domains: ['example.com'],
          port: defaultPort,
          apiProxyIp,
          apiProxyPorts: [22],
        });
      }).toThrow(/blocked for security reasons/);
    });

    it('should reject invalid apiProxyIp (injection attempt)', () => {
      expect(() => {
        generateSquidConfig({
          domains: ['example.com'],
          port: defaultPort,
          apiProxyIp: '172.30.0.30\nhttp_access allow all',
          apiProxyPorts,
        });
      }).toThrow(/SECURITY.*apiProxyIp/);
    });

    it('should reject apiProxyIp with invalid octets', () => {
      expect(() => {
        generateSquidConfig({
          domains: ['example.com'],
          port: defaultPort,
          apiProxyIp: '999.30.0.30',
          apiProxyPorts,
        });
      }).toThrow(/SECURITY.*apiProxyIp/);
    });
  });
});
