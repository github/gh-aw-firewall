import type { UpstreamProxyConfig } from '../types';

/**
 * Generates Squid cache_peer / always_direct / never_direct directives for
 * upstream (corporate) proxy chaining.
 *
 * When an upstream proxy is configured, ALL outbound traffic goes through
 * the parent proxy except domains in the no_proxy bypass list.
 */
export function generateUpstreamProxySection(upstream: UpstreamProxyConfig): string {
  const lines: string[] = [
    '# Upstream corporate proxy — route outbound traffic through parent proxy',
    '# Required for self-hosted runners where direct egress is blocked',
    `cache_peer ${upstream.host} parent ${upstream.port} 0 no-query default`,
  ];

  // Generate always_direct ACL for no_proxy bypass domains
  if (upstream.noProxy && upstream.noProxy.length > 0) {
    lines.push('');
    lines.push('# Bypass upstream proxy for these domains (from host no_proxy)');
    for (const domain of upstream.noProxy) {
      // All entries are treated as suffix matches (domain + subdomains),
      // matching standard no_proxy semantics:
      //   .corp.com  → *.corp.com
      //   internal.corp.com → internal.corp.com AND *.internal.corp.com
      const squidDomain = domain.startsWith('.') ? domain : `.${domain}`;
      lines.push(`acl upstream_bypass dstdomain ${squidDomain}`);
      // For non-dot entries, also add the exact domain for Squid dstdomain matching
      if (!domain.startsWith('.')) {
        lines.push(`acl upstream_bypass dstdomain ${domain}`);
      }
    }
    lines.push('always_direct allow upstream_bypass');
  }

  // Force all non-bypass traffic through the parent proxy
  lines.push('never_direct allow all');

  return lines.join('\n');
}
