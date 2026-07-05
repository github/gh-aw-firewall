import { generateUpstreamProxySection } from './upstream-proxy';

describe('generateUpstreamProxySection', () => {
  it('generates cache_peer directive with host and port', () => {
    const result = generateUpstreamProxySection({ host: 'proxy.corp.com', port: 3128 });
    expect(result).toContain('cache_peer proxy.corp.com parent 3128 0 no-query default');
  });

  it('always includes never_direct allow all directive', () => {
    const result = generateUpstreamProxySection({ host: 'proxy.corp.com', port: 8080 });
    expect(result).toContain('never_direct allow all');
  });

  it('does not include bypass ACL when noProxy is empty', () => {
    const result = generateUpstreamProxySection({ host: 'proxy.corp.com', port: 3128, noProxy: [] });
    expect(result).not.toContain('upstream_bypass');
    expect(result).not.toContain('always_direct');
  });

  it('does not include bypass ACL when noProxy is undefined', () => {
    const result = generateUpstreamProxySection({ host: 'proxy.corp.com', port: 3128 });
    expect(result).not.toContain('upstream_bypass');
  });

  it('adds subdomain dstdomain ACL and exact match for plain domain noProxy entry', () => {
    const result = generateUpstreamProxySection({
      host: 'proxy.corp.com',
      port: 3128,
      noProxy: ['internal.corp.com'],
    });
    // Subdomain match
    expect(result).toContain('acl upstream_bypass dstdomain .internal.corp.com');
    // Exact domain match (non-dot entry gets both)
    expect(result).toContain('acl upstream_bypass dstdomain internal.corp.com');
    expect(result).toContain('always_direct allow upstream_bypass');
  });

  it('adds only subdomain dstdomain ACL for already-dotted noProxy entry', () => {
    const result = generateUpstreamProxySection({
      host: 'proxy.corp.com',
      port: 3128,
      noProxy: ['.corp.com'],
    });
    expect(result).toContain('acl upstream_bypass dstdomain .corp.com');
    // Should NOT add exact match for already-dotted domain
    const exactMatchLine = 'acl upstream_bypass dstdomain corp.com';
    expect(result).not.toContain(exactMatchLine);
  });

  it('handles multiple noProxy domains and adds always_direct once', () => {
    const result = generateUpstreamProxySection({
      host: 'proxy.corp.com',
      port: 3128,
      noProxy: ['internal.corp.com', '.other.corp.com'],
    });
    expect(result).toContain('acl upstream_bypass dstdomain .internal.corp.com');
    expect(result).toContain('acl upstream_bypass dstdomain .other.corp.com');
    expect(result).toContain('always_direct allow upstream_bypass');
  });

  it('includes Bypass comment when noProxy entries present', () => {
    const result = generateUpstreamProxySection({
      host: 'proxy.corp.com',
      port: 3128,
      noProxy: ['internal.corp.com'],
    });
    expect(result).toContain('# Bypass upstream proxy for these domains (from host no_proxy)');
  });

  it('rejects newline injection in proxy host via assertSafeForSquidConfig', () => {
    expect(() =>
      generateUpstreamProxySection({ host: 'proxy.corp.com\nevil', port: 3128 })
    ).toThrow();
  });

  it('rejects newline injection in noProxy domain', () => {
    expect(() =>
      generateUpstreamProxySection({
        host: 'proxy.corp.com',
        port: 3128,
        noProxy: ['legit.com\nevil_directive'],
      })
    ).toThrow();
  });
});
