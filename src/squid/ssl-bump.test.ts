import { generateSslBumpSection } from './ssl-bump';

describe('generateSslBumpSection', () => {
  const caFiles = { certPath: '/tmp/test/cert.pem', keyPath: '/tmp/test/key.pem' };
  const sslDbPath = '/var/lib/squid/ssl_db';

  it('includes both ACL directives when hasPlainDomains and hasPatterns are true', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, true);
    expect(result).toContain('ssl_bump bump allowed_domains\nssl_bump bump allowed_domains_regex');
  });

  it('includes only plain domain directive when hasPlainDomains=true, hasPatterns=false', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('ssl_bump bump allowed_domains');
    expect(result).not.toContain('allowed_domains_regex');
  });

  it('includes only regex directive when hasPlainDomains=false, hasPatterns=true', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, false, true);
    expect(result).toContain('ssl_bump bump allowed_domains_regex');
    expect(result).not.toContain('ssl_bump bump allowed_domains\n');
  });

  it('uses terminate-all comment when no domains configured', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, false, false);
    expect(result).toContain('# No domains configured - terminate all SSL connections');
  });

  it('embeds cert and key paths in http_port directives', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain(`cert=${caFiles.certPath}`);
    expect(result).toContain(`key=${caFiles.keyPath}`);
  });

  it('embeds sslDbPath in sslcrtd_program directive', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain(`-s ${sslDbPath}`);
  });

  it('includes both IPv4 and IPv6 http_port directives for dual-stack defense-in-depth', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('http_port 3128 ssl-bump');
    expect(result).toContain('http_port [::]:3128 ssl-bump');
  });

  it('includes peek, stare, and terminate directives', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('ssl_bump peek step1');
    expect(result).toContain('ssl_bump stare step2');
    expect(result).toContain('ssl_bump terminate all');
  });

  it('generates indexed URL ACL lines when urlPatterns provided', () => {
    const urlPatterns = ['.*\\.example\\.com', 'github\\.com'];
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false, urlPatterns);
    expect(result).toContain('acl allowed_url_0 url_regex .*\\.example\\.com');
    expect(result).toContain('acl allowed_url_1 url_regex github\\.com');
    expect(result).toContain('# URL pattern ACLs for HTTPS content inspection');
  });

  it('omits URL ACL section when urlPatterns is undefined', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).not.toContain('URL pattern ACLs');
  });

  it('omits URL ACL section when urlPatterns is empty array', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false, []);
    expect(result).not.toContain('URL pattern ACLs');
  });

  it('disables weak TLS protocols (NO_SSLv3, NO_TLSv1, NO_TLSv1_1)', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('options=NO_SSLv3,NO_TLSv1,NO_TLSv1_1');
  });

  it('rejects newline injection in URL patterns via assertSafeForSquidConfig', () => {
    expect(() =>
      generateSslBumpSection(caFiles, sslDbPath, true, false, ['safe\nevil_directive'])
    ).toThrow();
  });

  it('includes step ACL declarations for SslBump phases', () => {
    const result = generateSslBumpSection(caFiles, sslDbPath, true, false);
    expect(result).toContain('acl step1 at_step SslBump1');
    expect(result).toContain('acl step2 at_step SslBump2');
    expect(result).toContain('acl step3 at_step SslBump3');
  });
});
