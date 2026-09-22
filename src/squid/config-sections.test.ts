import { buildConfigSections } from './config-sections';

// Minimal valid domainsByProto and patternsByProto structures
const emptyDomainsByProto = { http: [], https: [], both: [] };
const emptyPatternsByProto = { http: [], https: [], both: [] };

function buildWithDefaults(overrides: Partial<Parameters<typeof buildConfigSections>[0]> = {}) {
  return buildConfigSections({
    port: 3128,
    domainsByProto: emptyDomainsByProto,
    patternsByProto: emptyPatternsByProto,
    ...overrides,
  });
}

function parseSecondsDirective(section: string, directive: string): number {
  const directiveLine = section.split('\n').find(line => line.startsWith(`${directive} `));
  const value = directiveLine?.split(/\s+/)[1];
  if (!value) {
    throw new Error(`Missing ${directive} directive`);
  }
  return Number(value);
}

function canReachFallbackResolver(options: {
  dnsRetransmitIntervalSeconds: number;
  dnsTimeoutSeconds: number;
  resolverOutcomes: ('stall' | 'success')[];
}): boolean {
  const { dnsRetransmitIntervalSeconds, dnsTimeoutSeconds, resolverOutcomes } = options;
  let elapsedSeconds = 0;
  for (const resolverOutcome of resolverOutcomes) {
    if (elapsedSeconds >= dnsTimeoutSeconds) {
      return false;
    }
    if (resolverOutcome === 'success') {
      return true;
    }
    elapsedSeconds += dnsRetransmitIntervalSeconds;
  }
  return false;
}

describe('buildConfigSections', () => {
  describe('portConfig', () => {
    it('uses the guard-only SSL Bump listener by default', () => {
      const { portConfig, sslBumpSection } = buildWithDefaults({ port: 3128 });
      expect(portConfig).toBe('');
      expect(sslBumpSection).toContain('http_port 3128 ssl-bump');
      expect(sslBumpSection).toContain('generate-host-certificates=off');
    });

    it('emits an IPv6 guard-only listener', () => {
      const { sslBumpSection } = buildWithDefaults({ port: 3128 });
      expect(sslBumpSection).toContain('http_port [::]:3128 ssl-bump');
    });

    it('returns empty portConfig when sslBump is enabled with caFiles and sslDbPath', () => {
      const { portConfig } = buildWithDefaults({
        sslBump: true,
        caFiles: { certPath: '/cert.pem', keyPath: '/key.pem' },
        sslDbPath: '/tmp/ssl_db',
      });
      expect(portConfig).toBe('');
    });
  });

  describe('sslBumpSection', () => {
    it('enforces TLS SNI when full SSL Bump is not enabled', () => {
      const { sslBumpSection } = buildWithDefaults();
      expect(sslBumpSection).toContain('TLS SNI allowlist enforcement');
      expect(sslBumpSection).toContain('ssl_bump peek tls_sni_guard_step1');
      expect(sslBumpSection).toContain('ssl_bump terminate tls_sni_guard_step2');
    });

    it('falls back to guard-only enforcement when full SSL Bump files are missing', () => {
      const { sslBumpSection } = buildWithDefaults({ sslBump: true });
      expect(sslBumpSection).toContain('TLS SNI allowlist enforcement');
    });

    it('generates sslBump config when sslBump, caFiles, and sslDbPath are all provided', () => {
      const { sslBumpSection } = buildWithDefaults({
        sslBump: true,
        caFiles: { certPath: '/cert.pem', keyPath: '/key.pem' },
        sslDbPath: '/tmp/ssl_db',
      });
      expect(sslBumpSection).toContain('ssl_bump');
      expect(sslBumpSection).toContain('/cert.pem');
      expect(sslBumpSection).toContain('/tmp/ssl_db');
    });

    it('generates URL ACL access section when urlPatterns provided with sslBump', () => {
      const { sslBumpUrlAccessSection } = buildWithDefaults({
        sslBump: true,
        caFiles: { certPath: '/cert.pem', keyPath: '/key.pem' },
        sslDbPath: '/tmp/ssl_db',
        urlPatterns: ['https://example.com/api.*'],
        domainsByProto: { http: [], https: [], both: ['example.com'] },
      });
      expect(sslBumpUrlAccessSection).toContain('http_access allow allowed_url_0');
    });

    it('generates sslBumpUrlAccessSection with regex deny when only patterns (no plain domains)', () => {
      const { sslBumpUrlAccessSection } = buildWithDefaults({
        sslBump: true,
        caFiles: { certPath: '/cert.pem', keyPath: '/key.pem' },
        sslDbPath: '/tmp/ssl_db',
        urlPatterns: ['https://example.com/api.*'],
        patternsByProto: {
          http: [],
          https: [],
          both: [{ regex: 'example\\.com', protocol: 'both', original: '*.example.com' }],
        },
      });
      expect(sslBumpUrlAccessSection).toContain('allowed_domains_regex');
    });

    it('sslBumpUrlAccessSection is empty string when no urlPatterns', () => {
      const { sslBumpUrlAccessSection } = buildWithDefaults({
        sslBump: true,
        caFiles: { certPath: '/cert.pem', keyPath: '/key.pem' },
        sslDbPath: '/tmp/ssl_db',
      });
      expect(sslBumpUrlAccessSection).toBe('');
    });

    it('allows both unrestricted and HTTPS-only domains as TLS SNI', () => {
      const { sslBumpSection } = buildWithDefaults({
        domainsByProto: {
          http: ['plain-http.example.com'],
          https: ['secure.example.com'],
          both: ['github.com'],
        },
      });
      expect(sslBumpSection).toContain(
        'acl tls_sni_guard_allowed ssl::server_name --client-requested .github.com'
      );
      expect(sslBumpSection).toContain(
        'acl tls_sni_guard_allowed ssl::server_name --client-requested .secure.example.com'
      );
      expect(sslBumpSection).not.toContain('.plain-http.example.com');
    });

    it('generates SNI regex ACLs for HTTPS-capable wildcard patterns', () => {
      const { sslBumpSection } = buildWithDefaults({
        patternsByProto: {
          http: [],
          https: [{ regex: '^secure-[a-z]+\\.example\\.com$', protocol: 'https', original: 'secure-*.example.com' }],
          both: [{ regex: '^[a-z]+\\.github\\.com$', protocol: 'both', original: '*.github.com' }],
        },
      });
      expect(sslBumpSection).toContain(
        'acl tls_sni_guard_allowed_regex ssl::server_name_regex --client-requested -i ^secure-[a-z]+\\.example\\.com$'
      );
      expect(sslBumpSection).toContain(
        'ssl_bump splice tls_sni_guard_step2 tls_sni_guard_allowed_regex'
      );
    });

    it('splices trusted API and CLI proxy sources before inspecting SNI', () => {
      const { sslBumpSection } = buildWithDefaults({
        apiProxyIp: '172.30.0.30',
        cliProxyIp: '172.30.0.50',
      });
      const apiSplice = sslBumpSection.indexOf('ssl_bump splice tls_sni_guard_api_proxy');
      const cliSplice = sslBumpSection.indexOf('ssl_bump splice tls_sni_guard_cli_proxy');
      const peek = sslBumpSection.indexOf('ssl_bump peek tls_sni_guard_step1');
      expect(apiSplice).toBeGreaterThan(-1);
      expect(cliSplice).toBeGreaterThan(-1);
      expect(apiSplice).toBeLessThan(peek);
      expect(cliSplice).toBeLessThan(peek);
    });

    it('terminates blocked SNI before allowing a parent domain', () => {
      const { sslBumpSection } = buildWithDefaults({
        domains: ['example.com'],
        blockedDomains: ['blocked.example.com'],
        domainsByProto: {
          http: [],
          https: [],
          both: ['example.com'],
        },
      });
      const blocked = sslBumpSection.indexOf(
        'ssl_bump terminate tls_sni_guard_step2 tls_sni_guard_blocked'
      );
      const allowed = sslBumpSection.indexOf(
        'ssl_bump splice tls_sni_guard_step2 tls_sni_guard_allowed'
      );
      expect(blocked).toBeGreaterThan(-1);
      expect(blocked).toBeLessThan(allowed);
    });

    it('preserves explicitly allowlisted HTTPS IP destinations', () => {
      const { sslBumpSection } = buildWithDefaults({
        domains: ['192.0.2.10'],
        domainsByProto: {
          http: [],
          https: [],
          both: ['192.0.2.10'],
        },
      });
      expect(sslBumpSection).toContain('acl tls_sni_guard_allowed_ip dst 192.0.2.10');
      expect(sslBumpSection).not.toContain(
        'ssl::server_name --client-requested .192.0.2.10'
      );
    });
  });

  describe('portAclsAndRules', () => {
    it('always includes Safe_ports for 80 and 443', () => {
      const { portAclsAndRules } = buildWithDefaults();
      expect(portAclsAndRules).toContain('acl Safe_ports port 80');
      expect(portAclsAndRules).toContain('acl Safe_ports port 443');
    });

    it('includes user-specified ports when enableHostAccess and allowHostPorts are set', () => {
      const { portAclsAndRules } = buildWithDefaults({
        enableHostAccess: true,
        allowHostPorts: '8080,9090',
      });
      expect(portAclsAndRules).toContain('acl Safe_ports port 8080');
      expect(portAclsAndRules).toContain('acl Safe_ports port 9090');
    });

    it('includes apiProxyPorts when provided', () => {
      const { portAclsAndRules } = buildWithDefaults({
        apiProxyPorts: [10001, 10002],
      });
      expect(portAclsAndRules).toContain('acl Safe_ports port 10001');
      expect(portAclsAndRules).toContain('acl Safe_ports port 10002');
    });

    it('does not add user ports when enableHostAccess is false', () => {
      const { portAclsAndRules } = buildWithDefaults({
        enableHostAccess: false,
        allowHostPorts: '8080',
      });
      expect(portAclsAndRules).not.toContain('8080');
    });

    it('throws on dangerous host port', () => {
      expect(() =>
        buildWithDefaults({ enableHostAccess: true, allowHostPorts: '22' })
      ).toThrow(/dangerous port/i);
    });

    it('throws on invalid port format', () => {
      expect(() =>
        buildWithDefaults({ enableHostAccess: true, allowHostPorts: 'notaport' })
      ).toThrow(/Invalid port/i);
    });

    it('throws on dangerous apiProxyPort', () => {
      expect(() =>
        buildWithDefaults({ apiProxyPorts: [22] })
      ).toThrow(/dangerous/i);
    });
  });

  describe('apiProxySection', () => {
    it('is empty string when apiProxyIp is not set', () => {
      const { apiProxySection } = buildWithDefaults();
      expect(apiProxySection).toBe('');
    });

    it('includes allow rules for the apiProxyIp when provided', () => {
      const { apiProxySection } = buildWithDefaults({ apiProxyIp: '172.30.0.30' });
      expect(apiProxySection).toContain('172.30.0.30');
      expect(apiProxySection).toContain('http_access allow allow_api_proxy_ip');
      expect(apiProxySection).toContain('http_access allow from_api_proxy');
    });
  });

  describe('allowedIpSection', () => {
    it('is empty when no IP addresses in domains', () => {
      const { allowedIpSection } = buildWithDefaults({ domains: ['github.com', 'example.com'] });
      expect(allowedIpSection).toBe('');
    });

    it('generates allow rules for raw IPv4 addresses in domains', () => {
      const { allowedIpSection } = buildWithDefaults({ domains: ['192.168.1.1', 'github.com'] });
      expect(allowedIpSection).toContain('192.168.1.1');
      expect(allowedIpSection).toContain('http_access allow allow_ip_192_168_1_1');
    });

    it('is empty when domains is empty', () => {
      const { allowedIpSection } = buildWithDefaults({ domains: [] });
      expect(allowedIpSection).toBe('');
    });
  });

  describe('dnsSection', () => {
    it('includes default DNS servers when dnsServers not provided', () => {
      const { dnsSection } = buildWithDefaults();
      expect(dnsSection).toContain('dns_nameservers');
      // Should use default Google DNS
      expect(dnsSection).toMatch(/8\.8\.8\.8/);
    });

    it('uses custom DNS servers when provided', () => {
      const { dnsSection } = buildWithDefaults({ dnsServers: ['1.1.1.1', '1.0.0.1'] });
      expect(dnsSection).toMatch(/^dns_nameservers 1\.1\.1\.1 1\.0\.0\.1$/m);
    });

    it('shrinks negative_dns_ttl to avoid caching a single transient SERVFAIL', () => {
      const { dnsSection } = buildWithDefaults();
      expect(dnsSection).toMatch(/^negative_dns_ttl 1 seconds$/m);
    });

    it('uses a short retransmit interval with enough total timeout for resolver fallback', () => {
      const { dnsSection } = buildWithDefaults();
      expect(dnsSection).toMatch(/^dns_retransmit_interval 1 seconds$/m);
      expect(dnsSection).toMatch(/^dns_timeout 10 seconds$/m);
    });

    it('keeps DNS timeout above retransmit interval so fallback nameservers are queried', () => {
      const { dnsSection } = buildWithDefaults();
      const dnsRetransmitIntervalSeconds = parseSecondsDirective(dnsSection, 'dns_retransmit_interval');
      const dnsTimeoutSeconds = parseSecondsDirective(dnsSection, 'dns_timeout');

      expect(dnsRetransmitIntervalSeconds).toBeLessThan(dnsTimeoutSeconds);
      expect(canReachFallbackResolver({
        dnsRetransmitIntervalSeconds,
        dnsTimeoutSeconds,
        resolverOutcomes: ['stall', 'success'],
      })).toBe(true);
    });
  });

  describe('topologyPeersSection', () => {
    it('is empty when topologyPeers is not set', () => {
      const { topologyPeersSection } = buildWithDefaults();
      expect(topologyPeersSection).toBe('');
    });

    it('is empty when topologyPeers is an empty array', () => {
      const { topologyPeersSection } = buildWithDefaults({ topologyPeers: [] });
      expect(topologyPeersSection).toBe('');
    });

    it('generates allow rules for each topology peer', () => {
      const { topologyPeersSection } = buildWithDefaults({ topologyPeers: ['awmg-mcpg'] });
      expect(topologyPeersSection).toContain('dstdomain');
      expect(topologyPeersSection).toContain('http_access allow topology_peer_awmg_mcpg');
    });

    it('generates rules for multiple topology peers', () => {
      const { topologyPeersSection } = buildWithDefaults({ topologyPeers: ['peer1', 'peer2'] });
      expect(topologyPeersSection).toContain('topology_peer_peer1');
      expect(topologyPeersSection).toContain('topology_peer_peer2');
    });
  });

  describe('dlpAclSection and dlpAccessSection', () => {
    it('returns empty sections when enableDlp is false', () => {
      const { dlpAclSection, dlpAccessSection } = buildWithDefaults({ enableDlp: false });
      expect(dlpAclSection).toBe('');
      expect(dlpAccessSection).toBe('');
    });

    it('returns empty sections when enableDlp is not set', () => {
      const { dlpAclSection, dlpAccessSection } = buildWithDefaults();
      expect(dlpAclSection).toBe('');
      expect(dlpAccessSection).toBe('');
    });

    it('returns non-empty sections when enableDlp is true', () => {
      const { dlpAclSection, dlpAccessSection } = buildWithDefaults({ enableDlp: true });
      expect(dlpAclSection.length).toBeGreaterThan(0);
      expect(dlpAccessSection.length).toBeGreaterThan(0);
    });
  });
});
