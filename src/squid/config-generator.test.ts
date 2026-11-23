import { generateSquidConfig } from '../squid-config';
import type { SquidConfig } from '../types';

// Keep snapshots independent of the package release version.
jest.mock('../../package.json', () => ({ version: '0.0.0-test' }));

describe('generateSquidConfig golden output', () => {
  const cases: [string, SquidConfig][] = [
    ['empty allowlist', { domains: [], port: 3128 }],
    ['default policy with empty optional lists', {
      domains: ['github.com'],
      port: 3128,
      blockedDomains: [],
      sensitiveDomains: [],
      otlpEndpoints: [],
    }],
    ['combined policy and proxy sections', {
      domains: [
        'github.com',
        'http://plain.example.com',
        'https://secure.example.com',
        '*.example.org',
        '172.30.0.1',
      ],
      port: 3128,
      blockedDomains: ['blocked.example.com', '*.blocked.example.org'],
      sensitiveDomains: [
        'http://plain.example.com',
        'https://secure.example.com',
        '.github.com',
        '192.0.2.1',
        '[2001:db8::1]',
      ],
      otlpEndpoints: [
        { hostname: 'otel.example.com', port: 4318, protocol: 'https' },
        { hostname: 'otel.example.com', port: 4317, protocol: 'http' },
        { hostname: 'otel-http.example.com', port: 80, protocol: 'http' },
        { hostname: 'otel-https.example.com', port: 443, protocol: 'https' },
      ],
      cliProxyIp: '172.30.0.50',
      apiProxyIp: '172.30.0.30',
      apiProxyPorts: [10000, 10001, 10002, 10003],
      apiProxyUpstreams: [{ hostname: 'gateway.example.com', port: 8443 }],
      apiProxyBrokerUpstreams: [
        { hostname: 'broker.example.com', port: 443 },
        { hostname: '192.0.2.2', port: 8443 },
      ],
      topologyPeers: ['awmg-mcpg'],
      enableDlp: true,
      enableHostAccess: true,
      allowHostPorts: '3000,8080-8082',
      dnsServers: ['1.1.1.1', '1.0.0.1'],
      upstreamProxy: {
        host: 'proxy.example.com',
        port: 3128,
        noProxy: ['.internal.example.com'],
      },
    }],
    ['SSL Bump with URL filtering and CLI proxy', {
      domains: ['github.com', '*.example.org'],
      port: 3128,
      sslBump: true,
      caFiles: { certPath: '/tmp/ca.crt', keyPath: '/tmp/ca.key' },
      sslDbPath: '/tmp/ssl_db',
      urlPatterns: ['https://github.com/api/*'],
      cliProxyIp: '172.30.0.50',
      sensitiveDomains: ['https://github.com'],
    }],
  ];

  it.each(cases)('preserves %s byte-for-byte', (_name, config) => {
    expect(generateSquidConfig(config)).toMatchSnapshot();
  });
});
