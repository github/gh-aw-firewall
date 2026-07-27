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

describe('buildConfigSections', () => {
  describe('portConfig', () => {
    it('emits http_port with the configured port', () => {
      const { portConfig } = buildWithDefaults({ port: 3128 });
      expect(portConfig).toContain('http_port 3128');
    });

    it('emits IPv6 port entry', () => {
      const { portConfig } = buildWithDefaults({ port: 3128 });
      expect(portConfig).toContain('http_port [::]:3128');
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
    it('is empty when sslBump is not enabled', () => {
      const { sslBumpSection } = buildWithDefaults();
      expect(sslBumpSection).toBe('');
    });

    it('is empty when sslBump enabled but caFiles missing', () => {
      const { sslBumpSection } = buildWithDefaults({ sslBump: true });
      expect(sslBumpSection).toBe('');
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
expect(dnsSection).toBe('dns_nameservers 1.1.1.1 1.0.0.1');
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
