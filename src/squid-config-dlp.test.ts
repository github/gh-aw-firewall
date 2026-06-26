import { generateSquidConfig } from './squid-config';

describe('Empty Domain List', () => {
  it('should generate config that denies all traffic when no domains are specified', () => {
    const config = {
      domains: [],
      port: 3128,
    };
    const result = generateSquidConfig(config);
    // Should deny all traffic when no domains are allowed
    expect(result).toContain('http_access deny all');
    // Should have a comment indicating no domains configured
    expect(result).toContain('# No domains configured');
    // Should not have any allowed_domains ACL
    expect(result).not.toContain('acl allowed_domains');
    expect(result).not.toContain('acl allowed_http_only');
    expect(result).not.toContain('acl allowed_https_only');
  });
});

describe('DLP Integration', () => {
  const defaultPort = 3128;

  it('should not include DLP rules when enableDlp is false', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: false,
    };
    const result = generateSquidConfig(config);
    expect(result).not.toContain('dlp_blocked');
    expect(result).not.toContain('DLP');
  });

  it('should not include DLP rules when enableDlp is undefined', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
    };
    const result = generateSquidConfig(config);
    expect(result).not.toContain('dlp_blocked');
  });

  it('should include DLP ACL and deny rules when enableDlp is true', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);
    // Should have DLP ACL definitions
    expect(result).toContain('acl dlp_blocked url_regex -i');
    // Should have DLP deny rule
    expect(result).toContain('http_access deny dlp_blocked');
    // Should still have normal domain ACLs
    expect(result).toContain('acl allowed_domains dstdomain .github.com');
  });

  it('should place DLP deny rules before domain allow rules', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);

    const dlpDenyIndex = result.indexOf('http_access deny dlp_blocked');
    const domainDenyIndex = result.indexOf('http_access deny !allowed_domains');
    // DLP deny should appear before domain deny
    expect(dlpDenyIndex).toBeGreaterThan(-1);
    expect(domainDenyIndex).toBeGreaterThan(-1);
    expect(dlpDenyIndex).toBeLessThan(domainDenyIndex);
  });

  it('should include credential patterns like ghp_ and AKIA in ACLs', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);
    // Check for a few key patterns
    expect(result).toContain('ghp_');
    expect(result).toContain('AKIA');
    expect(result).toContain('sk-ant-');
  });

  it('should work with DLP and blocked domains together', () => {
    const config = {
      domains: ['github.com'],
      blockedDomains: ['evil.com'],
      port: defaultPort,
      enableDlp: true,
    };
    const result = generateSquidConfig(config);
    // Should have both DLP and blocked domain rules
    expect(result).toContain('http_access deny dlp_blocked');
    expect(result).toContain('http_access deny blocked_domains');
    expect(result).toContain('acl dlp_blocked url_regex -i');
  });

  it('should work with DLP and SSL Bump together', () => {
    const config = {
      domains: ['github.com'],
      port: defaultPort,
      enableDlp: true,
      sslBump: true,
      caFiles: { certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' },
      sslDbPath: '/var/spool/squid_ssl_db',
    };
    const result = generateSquidConfig(config);
    // Should have DLP rules
    expect(result).toContain('http_access deny dlp_blocked');
    // Should have SSL Bump config
    expect(result).toContain('ssl_bump');
  });
});
