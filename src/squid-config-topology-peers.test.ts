import { generateSquidConfig } from './squid-config';

describe('generateSquidConfig: topology peers (network-isolation)', () => {
  const port = 3128;

  it('emits a dstdomain allow rule for each topology peer', () => {
    const config = generateSquidConfig({
      domains: ['github.com'],
      port,
      topologyPeers: ['awmg-mcpg', 'awmg-cli-proxy'],
    });
    expect(config).toContain('acl topology_peer_awmg_mcpg dstdomain .awmg-mcpg');
    expect(config).toContain('http_access allow topology_peer_awmg_mcpg');
    expect(config).toContain('acl topology_peer_awmg_cli_proxy dstdomain .awmg-cli-proxy');
    expect(config).toContain('http_access allow topology_peer_awmg_cli_proxy');
  });

  it('places the peer allow before the Safe_ports deny (so any port is reachable)', () => {
    const config = generateSquidConfig({
      domains: ['github.com'],
      port,
      topologyPeers: ['awmg-mcpg'],
    });
    const allowPos = config.indexOf('http_access allow topology_peer_awmg_mcpg');
    const safePortsDenyPos = config.indexOf('http_access deny !Safe_ports');
    expect(allowPos).toBeGreaterThan(-1);
    expect(safePortsDenyPos).toBeGreaterThan(-1);
    expect(allowPos).toBeLessThan(safePortsDenyPos);
  });

  it('places the peer allow before the raw-IP deny rules', () => {
    const config = generateSquidConfig({
      domains: ['github.com'],
      port,
      topologyPeers: ['awmg-mcpg'],
    });
    const allowPos = config.indexOf('http_access allow topology_peer_awmg_mcpg');
    const rawIpDenyPos = config.indexOf('http_access deny dst_ipv4');
    expect(allowPos).toBeLessThan(rawIpDenyPos);
  });

  it('emits no topology peer rules when the list is empty or omitted', () => {
    const withEmpty = generateSquidConfig({ domains: ['github.com'], port, topologyPeers: [] });
    const withUndefined = generateSquidConfig({ domains: ['github.com'], port });
    expect(withEmpty).not.toContain('topology_peer_');
    expect(withUndefined).not.toContain('topology_peer_');
  });

  it('sanitizes peer names into safe ACL identifiers', () => {
    const config = generateSquidConfig({
      domains: ['github.com'],
      port,
      topologyPeers: ['mcp.gateway-01'],
    });
    expect(config).toContain('acl topology_peer_mcp_gateway_01 dstdomain .mcp.gateway-01');
  });

  it('rejects a peer name containing squid-config-breaking characters', () => {
    expect(() =>
      generateSquidConfig({
        domains: ['github.com'],
        port,
        topologyPeers: ['evil\nhttp_access allow all'],
      })
    ).toThrow(/unsafe for Squid config/i);
  });
});
