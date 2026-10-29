import { generatePolicyManifest, generateSquidConfig } from '../squid-config';

describe('trusted API proxy custom upstream ports', () => {
  const config = {
    domains: ['host.docker.internal'],
    port: 3128,
    apiProxyIp: '172.30.0.30',
    apiProxyUpstreams: [
      { hostname: 'host.docker.internal', port: 11434 },
      { hostname: 'gateway.example.com', port: 8443 },
    ],
  };

  it('scopes each exception to the trusted source and one exact hostname/port pair', () => {
    const result = generateSquidConfig(config);
    expect(result).toContain('acl api_upstream_source src 172.30.0.30/32');
    for (const [index, endpoint] of config.apiProxyUpstreams.entries()) {
      const escapedHostname = endpoint.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(result).toContain(`acl api_upstream_${index}_host dstdom_regex -i -n ^${escapedHostname}$`);
      expect(result).toContain(`acl api_upstream_${index}_port port ${endpoint.port}`);
      const rule = `http_access allow api_upstream_source api_upstream_${index}_host api_upstream_${index}_port`;
      expect(result).toContain(rule);
      expect(result.indexOf(rule)).toBeLessThan(result.indexOf('http_access deny !Safe_ports'));
      expect(result).not.toContain(`acl Safe_ports port ${endpoint.port}`);
    }
    expect(result).toContain('http_access deny !Safe_ports');
    expect(result).toContain('http_access deny dst_ipv4');
    expect(result).toContain('http_access deny dst_ipv6');
  });

  it('retains explicit domain blocks and DLP on the exception', () => {
    const result = generateSquidConfig({
      ...config,
      blockedDomains: ['host.docker.internal', '*.example.com'],
      enableDlp: true,
    });
    const blockedDeny = 'http_access deny api_upstream_source api_upstream_0_host api_upstream_0_port blocked_domains';
    const dlpDeny = 'http_access deny api_upstream_source api_upstream_0_host api_upstream_0_port dlp_blocked';
    const allow = 'http_access allow api_upstream_source api_upstream_0_host api_upstream_0_port !blocked_domains !blocked_domains_regex !dlp_blocked';
    expect(result).toContain(blockedDeny);
    expect(result).toContain(dlpDeny);
    expect(result.indexOf(blockedDeny)).toBeLessThan(result.indexOf(allow));
    expect(result.indexOf(dlpDeny)).toBeLessThan(result.indexOf(allow));
    expect(result).toContain(
      allow
    );
  });

  it('denies blocked and DLP matches before a custom port already in Safe_ports', () => {
    const result = generateSquidConfig({
      ...config,
      enableHostAccess: true,
      allowHostPorts: '11434',
      blockedDomains: ['host.docker.internal'],
      enableDlp: true,
    });
    const blockedDeny = 'http_access deny api_upstream_source api_upstream_0_host api_upstream_0_port blocked_domains';
    const dlpDeny = 'http_access deny api_upstream_source api_upstream_0_host api_upstream_0_port dlp_blocked';
    const allow = 'http_access allow api_upstream_source api_upstream_0_host api_upstream_0_port';
    const broadAllow = 'http_access allow from_api_proxy';
    expect(result).toContain('acl Safe_ports port 11434');
    for (const deny of [blockedDeny, dlpDeny]) {
      expect(result.indexOf(deny)).toBeLessThan(result.indexOf(allow));
      expect(result.indexOf(deny)).toBeLessThan(result.indexOf(broadAllow));
    }
  });

  it('does not open custom ports without an API proxy source', () => {
    expect(generateSquidConfig({ ...config, apiProxyIp: undefined })).not.toContain('api_upstream_');
  });

  it.each([
    { hostname: 'gateway.example.com', port: 443 },
    { hostname: '127.0.0.1', port: 80 },
  ])('leaves default ports under the existing safety rules: %s', endpoint => {
    const result = generateSquidConfig({
      ...config,
      apiProxyUpstreams: [endpoint],
    });
    expect(result).not.toContain('api_upstream_');
  });

  it('records source/port-scoped exceptions before port safety in the policy manifest', () => {
    const manifest = generatePolicyManifest(config);
    const upstream = manifest.rules.find(rule => rule.id === 'allow-api-proxy-upstream-0')!;
    const unsafe = manifest.rules.find(rule => rule.id === 'deny-unsafe-ports')!;
    expect(upstream.order).toBeLessThan(unsafe.order);
    expect(upstream.aclName).toBe('api_upstream_source api_upstream_0_host api_upstream_0_port');
    expect(upstream.domains).toEqual([]);
    expect(upstream.description).toContain('host.docker.internal:11434');
  });

  it.each([22, 6379, 0, 65536, NaN])('rejects dangerous or invalid port %s', port => {
    expect(() => generateSquidConfig({
      ...config, apiProxyUpstreams: [{ hostname: 'gateway.example.com', port }],
    })).toThrow();
  });

  it.each(['127.0.0.1', '[::1]', '.example.com', '*.example.com', 'host\nhttp_access allow all'])(
    'rejects raw IPs, wildcard hosts and configuration injection: %s', hostname => {
      expect(() => generateSquidConfig({
        ...config, apiProxyUpstreams: [{ hostname, port: 11434 }],
      })).toThrow(/SECURITY/);
    }
  );
});
