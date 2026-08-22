import { generateSquidConfig } from './squid-config';

describe('generateSquidConfig: CLI proxy artifact storage', () => {
  it('allows Azure Blob artifact redirects only from the CLI proxy', () => {
    const config = generateSquidConfig({
      domains: ['github.com'],
      blockedDomains: ['blocked.example.com'],
      port: 3128,
      cliProxyIp: '172.30.0.50',
    });

    expect(config).toContain('acl from_cli_proxy src 172.30.0.50/32');
    expect(config).toContain('acl cli_proxy_artifact_storage dstdomain .blob.core.windows.net');
    expect(config).toContain('http_access allow from_cli_proxy cli_proxy_artifact_storage');
    expect(config).not.toContain('http_access allow cli_proxy_artifact_storage\n');

    const blocklistDeny = config.indexOf('http_access deny blocked_domains');
    const artifactAllow = config.indexOf('http_access allow from_cli_proxy cli_proxy_artifact_storage');
    const allowlistDeny = config.indexOf('http_access deny !allowed_domains');
    expect(blocklistDeny).toBeLessThan(artifactAllow);
    expect(artifactAllow).toBeLessThan(allowlistDeny);
  });

  it('does not add artifact storage access without the CLI proxy', () => {
    const config = generateSquidConfig({ domains: ['github.com'], port: 3128 });

    expect(config).not.toContain('cli_proxy_artifact_storage');
    expect(config).not.toContain('from_cli_proxy');
  });

  it('allows scoped artifact storage connections in SSL Bump mode', () => {
    const config = generateSquidConfig({
      domains: ['github.com'],
      port: 3128,
      cliProxyIp: '172.30.0.50',
      sslBump: true,
      caFiles: { certPath: '/tmp/ca.crt', keyPath: '/tmp/ca.key' },
      sslDbPath: '/tmp/ssl_db',
    });

    expect(config).toContain('ssl_bump splice from_cli_proxy cli_proxy_artifact_storage');

    const splice = config.indexOf('ssl_bump splice from_cli_proxy cli_proxy_artifact_storage');
    const peek = config.indexOf('ssl_bump peek step1');
    const stare = config.indexOf('ssl_bump stare step2');
    expect(peek).toBeLessThan(splice);
    expect(splice).toBeLessThan(stare);
  });
});
