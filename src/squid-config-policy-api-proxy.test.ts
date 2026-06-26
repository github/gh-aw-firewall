import { generatePolicyManifest } from './squid-config';

describe('generatePolicyManifest - Api-Proxy Rules', () => {
  const defaultPort = 3128;

  it('should include allow-api-proxy-ip rule before deny-raw-ipv4 when apiProxyIp is set', () => {
    const manifest = generatePolicyManifest({
      domains: ['example.com'],
      port: defaultPort,
      apiProxyIp: '172.30.0.30',
    });

    const apiProxyRule = manifest.rules.find(r => r.id === 'allow-api-proxy-ip');
    expect(apiProxyRule).toBeDefined();
    expect(apiProxyRule!.action).toBe('allow');
    expect(apiProxyRule!.domains).toContain('172.30.0.30');

    const denyIpv4Rule = manifest.rules.find(r => r.id === 'deny-raw-ipv4');
    expect(denyIpv4Rule).toBeDefined();
    expect(apiProxyRule!.order).toBeLessThan(denyIpv4Rule!.order);
  });

  it('should not include allow-api-proxy-ip rule when apiProxyIp is not set', () => {
    const manifest = generatePolicyManifest({
      domains: ['example.com'],
      port: defaultPort,
    });

    const apiProxyRule = manifest.rules.find(r => r.id === 'allow-api-proxy-ip');
    expect(apiProxyRule).toBeUndefined();
  });

  it('should include allow-from-api-proxy rule when apiProxyIp is set', () => {
    const manifest = generatePolicyManifest({
      domains: ['example.com'],
      port: defaultPort,
      apiProxyIp: '172.30.0.30',
    });

    const fromProxyRule = manifest.rules.find(r => r.id === 'allow-from-api-proxy');
    expect(fromProxyRule).toBeDefined();
    expect(fromProxyRule!.action).toBe('allow');
    expect(fromProxyRule!.aclName).toBe('from_api_proxy');
    expect(fromProxyRule!.domains).toContain('*');
    expect(fromProxyRule!.description).toContain('unrestricted outbound from api-proxy');

    // Must come after allow-api-proxy-ip and before deny-raw-ipv4
    const apiProxyRule = manifest.rules.find(r => r.id === 'allow-api-proxy-ip');
    const denyIpv4Rule = manifest.rules.find(r => r.id === 'deny-raw-ipv4');
    expect(fromProxyRule!.order).toBeGreaterThan(apiProxyRule!.order);
    expect(fromProxyRule!.order).toBeLessThan(denyIpv4Rule!.order);
  });

  it('should not include allow-from-api-proxy rule when apiProxyIp is not set', () => {
    const manifest = generatePolicyManifest({
      domains: ['example.com'],
      port: defaultPort,
    });

    const fromProxyRule = manifest.rules.find(r => r.id === 'allow-from-api-proxy');
    expect(fromProxyRule).toBeUndefined();
  });
});
