import { assertSafeForSquidConfig } from './domain-acl';

export const SNI_GUARD_CERT_PATH = '/var/run/squid/awf-sni-guard-cert.pem';
export const SNI_GUARD_KEY_PATH = '/var/run/squid/awf-sni-guard-key.pem';

interface TlsSniGuardOptions {
  port: number;
  plainDomains: string[];
  domainPatterns: string[];
  blockedDomains?: string[];
  blockedDomainPatterns?: string[];
  allowedIps?: string[];
  apiProxyIp?: string;
  cliProxyIp?: string;
}

/**
 * Generates a guard-only SSL Bump configuration that inspects the TLS
 * ClientHello SNI and then splices allowed connections without decrypting
 * application traffic.
 */
export function generateTlsSniGuardSection(options: TlsSniGuardOptions): string {
  const {
    port,
    plainDomains,
    domainPatterns,
    blockedDomains = [],
    blockedDomainPatterns = [],
    allowedIps = [],
    apiProxyIp,
    cliProxyIp,
  } = options;

  const allowedSniAcls = [
    ...plainDomains.map(
      domain =>
        `acl tls_sni_guard_allowed ssl::server_name --client-requested .${assertSafeForSquidConfig(domain).replace(/^\./, '')}`
    ),
    ...domainPatterns.map(
      pattern =>
        `acl tls_sni_guard_allowed_regex ssl::server_name_regex --client-requested -i ${assertSafeForSquidConfig(pattern)}`
    ),
  ];
  const allowedSniRules = [
    ...(plainDomains.length > 0
      ? ['ssl_bump splice tls_sni_guard_step2 tls_sni_guard_allowed']
      : []),
    ...(domainPatterns.length > 0
      ? ['ssl_bump splice tls_sni_guard_step2 tls_sni_guard_allowed_regex']
      : []),
  ];
  const blockedSniAcls = [
    ...blockedDomains.map(
      domain =>
        `acl tls_sni_guard_blocked ssl::server_name --client-requested .${assertSafeForSquidConfig(domain).replace(/^\./, '')}`
    ),
    ...blockedDomainPatterns.map(
      pattern =>
        `acl tls_sni_guard_blocked_regex ssl::server_name_regex --client-requested -i ${assertSafeForSquidConfig(pattern)}`
    ),
  ];
  const blockedSniRules = [
    ...(blockedDomains.length > 0
      ? ['ssl_bump terminate tls_sni_guard_step2 tls_sni_guard_blocked']
      : []),
    ...(blockedDomainPatterns.length > 0
      ? ['ssl_bump terminate tls_sni_guard_step2 tls_sni_guard_blocked_regex']
      : []),
  ];
  const allowedIpAcls = allowedIps.map(
    ip => `acl tls_sni_guard_allowed_ip dst ${assertSafeForSquidConfig(ip)}`
  );
  const trustedSourceAcls = [
    ...(apiProxyIp
      ? [`acl tls_sni_guard_api_proxy src ${assertSafeForSquidConfig(apiProxyIp)}/32`]
      : []),
    ...(cliProxyIp
      ? [`acl tls_sni_guard_cli_proxy src ${assertSafeForSquidConfig(cliProxyIp)}/32`]
      : []),
  ];
  const trustedSourceRules = [
    ...(apiProxyIp ? ['ssl_bump splice tls_sni_guard_api_proxy'] : []),
    ...(cliProxyIp ? ['ssl_bump splice tls_sni_guard_cli_proxy'] : []),
  ];

  return `# TLS SNI allowlist enforcement
# Squid peeks only at the TLS ClientHello, then splices allowed connections
# without decrypting application traffic. The listener certificate is an
# ephemeral, untrusted bootstrap certificate and is never presented when these
# splice/terminate rules operate as configured.
http_port ${port} ssl-bump cert=${SNI_GUARD_CERT_PATH} key=${SNI_GUARD_KEY_PATH} generate-host-certificates=off options=NO_SSLv3,NO_TLSv1,NO_TLSv1_1
http_port [::]:${port} ssl-bump cert=${SNI_GUARD_CERT_PATH} key=${SNI_GUARD_KEY_PATH} generate-host-certificates=off options=NO_SSLv3,NO_TLSv1,NO_TLSv1_1

acl tls_sni_guard_step1 at_step SslBump1
acl tls_sni_guard_step2 at_step SslBump2
acl tls_sni_guard_port port 443
${allowedSniAcls.join('\n')}
${blockedSniAcls.join('\n')}
${allowedIpAcls.join('\n')}
${trustedSourceAcls.join('\n')}

# Trusted AWF-owned sidecars retain their existing scoped egress behavior.
${trustedSourceRules.join('\n')}
# CONNECT is also used for non-TLS traffic to explicitly allowed sidecar ports.
ssl_bump splice !tls_sni_guard_port
# Preserve explicit IP allowlisting for TLS clients, which normally omit SNI.
${allowedIps.length > 0 ? 'ssl_bump splice tls_sni_guard_step1 tls_sni_guard_allowed_ip' : ''}

# For agent HTTPS traffic, inspect the ClientHello and require its actual SNI
# to be allowlisted. --client-requested prevents fallback to the CONNECT host
# when the client omits SNI.
ssl_bump peek tls_sni_guard_step1
${blockedSniRules.join('\n')}
${allowedSniRules.join('\n')}
ssl_bump terminate tls_sni_guard_step2
ssl_bump terminate all`;
}

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
  urlPatterns?: string[],
  allowCliProxyArtifactStorage = false,
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
  if (urlPatterns && urlPatterns.length > 0) {
    const urlAcls = urlPatterns
      .map((pattern, i) => `acl allowed_url_${i} url_regex ${assertSafeForSquidConfig(pattern)}`)
      .join('\n');
    urlAclSection = `\n# URL pattern ACLs for HTTPS content inspection\n${urlAcls}\n`;
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

${allowCliProxyArtifactStorage ? `# Splice the CLI proxy's scoped artifact-storage connections here (before staring
# or bumping) so signed Azure Blob URLs stay encrypted and the AWF-generated CA
# is never presented to the CLI proxy, which only trusts its system CA bundle.
ssl_bump splice from_cli_proxy cli_proxy_artifact_storage
` : ''}# Stare at server certificate to validate it
ssl_bump stare step2

# Bump (intercept) connections to allowed domains
${bumpAcls}

# Terminate (deny) connections to non-allowed domains
ssl_bump terminate all
${urlAclSection}`;
}
