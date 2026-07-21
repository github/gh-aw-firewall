import { buildInternalServiceHosts } from './internal-service-hosts';

describe('buildInternalServiceHosts', () => {
  it('always includes squid-proxy', () => {
    expect(buildInternalServiceHosts({ squidIp: '172.30.0.10' })).toEqual({
      'squid-proxy': '172.30.0.10',
    });
  });

  it('includes api-proxy and cli-proxy only when their IPs are provided', () => {
    expect(
      buildInternalServiceHosts({
        squidIp: '172.30.0.10',
        apiProxyIp: '172.30.0.30',
        cliProxyIp: '172.30.0.50',
      }),
    ).toEqual({
      'squid-proxy': '172.30.0.10',
      'api-proxy': '172.30.0.30',
      'cli-proxy': '172.30.0.50',
    });
  });

  it('omits sidecars whose IPs are undefined', () => {
    const hosts = buildInternalServiceHosts({
      squidIp: '172.30.0.10',
      cliProxyIp: '172.30.0.50',
    });
    expect(hosts).toEqual({
      'squid-proxy': '172.30.0.10',
      'cli-proxy': '172.30.0.50',
    });
    expect(hosts['api-proxy']).toBeUndefined();
  });
});
