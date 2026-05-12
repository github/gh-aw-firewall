import { assertSafeForSquidConfig } from './domain-acl';

/**
 * Generates SSL Bump configuration section for HTTPS content inspection
 *
 * @param caFiles - Paths to CA certificate and key
 * @param sslDbPath - Path to SSL certificate database
 * @param hasPlainDomains - Whether there are plain domain ACLs
 * @param hasPatterns - Whether there are pattern ACLs
 * @param urlPatterns - Optional URL patterns for HTTPS filtering
 * @returns Squid SSL Bump configuration string
 */
export function generateSslBumpSection(
  caFiles: { certPath: string; keyPath: string },
  sslDbPath: string,
  hasPlainDomains: boolean,
  hasPatterns: boolean,
  urlPatterns?: string[]
): string {
  // Build the SSL Bump domain list for the bump directive
  let bumpAcls = '';
  if (hasPlainDomains && hasPatterns) {
    bumpAcls = 'ssl_bump bump allowed_domains\nssl_bump bump allowed_domains_regex';
  } else if (hasPlainDomains) {
    bumpAcls = 'ssl_bump bump allowed_domains';
  } else if (hasPatterns) {
    bumpAcls = 'ssl_bump bump allowed_domains_regex';
  } else {
    // No domains configured - terminate all
    bumpAcls = '# No domains configured - terminate all SSL connections';
  }

  // Generate URL pattern ACLs if provided
  let urlAclSection = '';
  let urlAccessRules = '';
  if (urlPatterns && urlPatterns.length > 0) {
    const urlAcls = urlPatterns
      .map((pattern, i) => `acl allowed_url_${i} url_regex ${assertSafeForSquidConfig(pattern)}`)
      .join('\n');
    urlAclSection = `\n# URL pattern ACLs for HTTPS content inspection\n${urlAcls}\n`;

    // Build access rules for URL patterns
    // When URL patterns are specified, we:
    // 1. Allow requests matching the URL patterns
    // 2. Deny all other requests to allowed_domains (they didn't match URL patterns)
    const urlAccessLines = urlPatterns
      .map((_, i) => `http_access allow allowed_url_${i}`)
      .join('\n');

    // Deny requests to allowed domains that don't match URL patterns
    // This ensures URL-level filtering is enforced
    // IMPORTANT: Use !CONNECT to only deny actual HTTP requests after bump,
    // not the CONNECT request itself (which must be allowed for SSL bump to work)
    const denyNonMatching = hasPlainDomains
      ? 'http_access deny !CONNECT allowed_domains'
      : hasPatterns
        ? 'http_access deny !CONNECT allowed_domains_regex'
        : '';

    urlAccessRules = `\n# Allow HTTPS requests matching URL patterns\n${urlAccessLines}\n\n# Deny requests that don't match URL patterns\n${denyNonMatching}\n`;
  }

  return `
# SSL Bump configuration for HTTPS content inspection
# WARNING: This enables TLS interception - traffic is decrypted for inspection
# A per-session CA certificate is used for dynamic certificate generation

# HTTP port with SSL Bump enabled for HTTPS interception
# This handles both HTTP requests and HTTPS CONNECT requests
# Listen on both IPv4 and IPv6 as defense-in-depth (see: gh-aw-firewall issue #1543)
http_port 3128 ssl-bump \\
  cert=${caFiles.certPath} \\
  key=${caFiles.keyPath} \\
  generate-host-certificates=on \\
  dynamic_cert_mem_cache_size=16MB \\
  options=NO_SSLv3,NO_TLSv1,NO_TLSv1_1
http_port [::]:3128 ssl-bump \\
  cert=${caFiles.certPath} \\
  key=${caFiles.keyPath} \\
  generate-host-certificates=on \\
  dynamic_cert_mem_cache_size=16MB \\
  options=NO_SSLv3,NO_TLSv1,NO_TLSv1_1

# SSL certificate database for dynamic certificate generation
# Using 16MB for certificate cache (sufficient for typical AI agent sessions)
sslcrtd_program /usr/lib/squid/security_file_certgen -s ${sslDbPath} -M 16MB
sslcrtd_children 5

# SSL Bump ACL steps:
# Step 1 (SslBump1): Peek at ClientHello to get SNI
# Step 2 (SslBump2): Stare at server certificate to validate
# Step 3 (SslBump3): Bump or splice based on policy
acl step1 at_step SslBump1
acl step2 at_step SslBump2
acl step3 at_step SslBump3

# Peek at ClientHello to see SNI (Server Name Indication)
ssl_bump peek step1

# Stare at server certificate to validate it
ssl_bump stare step2

# Bump (intercept) connections to allowed domains
${bumpAcls}

# Terminate (deny) connections to non-allowed domains
ssl_bump terminate all
${urlAclSection}${urlAccessRules}`;
}
