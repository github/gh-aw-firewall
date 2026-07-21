import { resolveTopologyPeerHosts } from './topology-peers';

describe('resolveTopologyPeerHosts', () => {
  it('returns topology-attach names in network-isolation + compose runtime', () => {
    expect(
      resolveTopologyPeerHosts({
        networkIsolation: true,
        topologyAttach: ['awmg-mcpg', 'awmg-cli-proxy'],
      })
    ).toEqual(['awmg-mcpg', 'awmg-cli-proxy']);
  });

  it('returns [] when network isolation is off', () => {
    expect(
      resolveTopologyPeerHosts({
        networkIsolation: false,
        topologyAttach: ['awmg-mcpg'],
      })
    ).toEqual([]);
  });

  it('returns [] for a non-compose runtime (e.g. sbx)', () => {
    expect(
      resolveTopologyPeerHosts({
        networkIsolation: true,
        containerRuntime: 'sbx',
        topologyAttach: ['awmg-mcpg'],
      })
    ).toEqual([]);
  });

  it('includes the DIFC/cli-proxy host with scheme and port stripped', () => {
    expect(
      resolveTopologyPeerHosts({
        networkIsolation: true,
        difcProxyHost: 'https://awmg-cli-proxy:18443',
      })
    ).toEqual(['awmg-cli-proxy']);
  });

  it('deduplicates when the DIFC host is also in topologyAttach', () => {
    expect(
      resolveTopologyPeerHosts({
        networkIsolation: true,
        topologyAttach: ['awmg-cli-proxy'],
        difcProxyHost: 'awmg-cli-proxy:18443',
      })
    ).toEqual(['awmg-cli-proxy']);
  });

  it('ignores empty / non-string topologyAttach entries', () => {
    expect(
      resolveTopologyPeerHosts({
        networkIsolation: true,
        topologyAttach: ['awmg-mcpg', '', '  ', 42 as unknown as string],
      })
    ).toEqual(['awmg-mcpg']);
  });

  it('returns [] when nothing is attached', () => {
    expect(resolveTopologyPeerHosts({ networkIsolation: true, topologyAttach: [] })).toEqual([]);
  });
});
