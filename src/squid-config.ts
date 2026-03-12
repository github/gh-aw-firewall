import { SquidConfig } from './types';
import {
  parseDomainList,
  isDomainMatchedByPattern,
  PlainDomainEntry,
  DomainPattern,
} from './domain-patterns';

/**
 * Ports that should never be allowed, even with --allow-host-ports
 * These ports are blocked for security reasons to prevent access to sensitive services
 */
const DANGEROUS_PORTS = [
  22,    // SSH
  23,    // Telnet
  25,    // SMTP (mail)
  110,   // POP3 (mail)
  143,   // IMAP (mail)
  445,   // SMB (file sharing)
  1433,  // MS SQL Server
  1521,  // Oracle DB
  3306,  // MySQL
  3389,  // RDP (Windows Remote Desktop)
  5432,  // PostgreSQL
  5984,  // CouchDB
  6379,  // Redis
  6984,  // CouchDB (SSL)
  8086,  // InfluxDB HTTP API
  8088,  // InfluxDB RPC
  9200,  // Elasticsearch HTTP API
  9300,  // Elasticsearch transport
  27017, // MongoDB
  27018, // MongoDB sharding
  28017, // MongoDB web interface
];

/**
 * Groups domains/patterns by their protocol restriction
 */
interface DomainsByProtocol {
  http: string[];
  https: string[];
  both: string[];
}

/**
 * Groups patterns by their protocol restriction
 */
interface PatternsByProtocol {
  http: DomainPattern[];
  https: DomainPattern[];
  both: DomainPattern[];
}

/**
 * Helper to add leading dot to domain for Squid subdomain matching
 */
function formatDomainForSquid(domain: string): string {
  return domain.startsWith('.') ? domain : `.${domain}`;
}

/**
 * Group plain domains by protocol
 */
function groupDomainsByProtocol(domains: PlainDomainEntry[]): DomainsByProtocol {
  const result: DomainsByProtocol = { http: [], https: [], both: [] };
  for (const entry of domains) {
    result[entry.protocol].push(entry.domain);
  }
  return result;
}

/**
 * Group patterns by protocol
 */
function groupPatternsByProtocol(patterns: DomainPattern[]): PatternsByProtocol {
  const result: PatternsByProtocol = { http: [], https: [], both: [] };
  for (const pattern of patterns) {
    result[pattern.protocol].push(pattern);
  }
  return result;
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
function generateSslBumpSection(
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
      .map((pattern, i) => `acl allowed_url_${i} url_regex ${pattern}`)
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
http_port 3128 ssl-bump \\
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

/**
 * Generates Squid proxy configuration with domain whitelisting and optional blocklisting
 *
 * Supports both plain domains and wildcard patterns:
 * - Plain domains use dstdomain ACL (efficient, fast matching)
 * - Wildcard patterns use dstdom_regex ACL (regex matching)
 *
 * Blocked domains take precedence over allowed domains.
 *
 * Supports protocol-specific domain restrictions:
 * - http://domain.com  -> allow only HTTP traffic
 * - https://domain.com -> allow only HTTPS traffic
 * - domain.com         -> allow both HTTP and HTTPS (default)
 *
 * When sslBump is enabled, adds SSL Bump configuration for HTTPS inspection.
 *
 * @example
 * // Plain domain: github.com -> acl allowed_domains dstdomain .github.com
 * // Wildcard: *.github.com -> acl allowed_domains_regex dstdom_regex -i ^.*\.github\.com$
 * // HTTP only: http://api.example.com -> separate ACL with !CONNECT rule
 * // Blocked: internal.example.com -> acl blocked_domains dstdomain .internal.example.com
 */
export function generateSquidConfig(config: SquidConfig): string {
  const { domains, blockedDomains, port, sslBump, caFiles, sslDbPath, urlPatterns, enableHostAccess, allowHostPorts } = config;

  // Parse domains into plain domains and wildcard patterns
  // Note: parseDomainList extracts and preserves protocol info from prefixes (http://, https://)
  // This also validates all inputs and throws on invalid patterns
  const { plainDomains, patterns } = parseDomainList(domains);

  // Remove redundant plain subdomains within same protocol
  // (e.g., if github.com with 'both' is present, api.github.com with 'both' is redundant)
  const uniquePlainDomains = plainDomains.filter((entry, index, arr) => {
    // Check if this domain is a subdomain of another plain domain with compatible protocol
    return !arr.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      // Check if this domain is a subdomain of other
      if (entry.domain === other.domain || !entry.domain.endsWith('.' + other.domain)) {
        return false;
      }
      // Subdomain is only redundant if parent has same or broader protocol
      return other.protocol === 'both' || other.protocol === entry.protocol;
    });
  });

  // Remove plain domains that are already covered by wildcard patterns
  const filteredPlainDomains = uniquePlainDomains.filter(entry => {
    return !isDomainMatchedByPattern(entry, patterns);
  });

  // Group domains and patterns by protocol
  const domainsByProto = groupDomainsByProtocol(filteredPlainDomains);
  const patternsByProto = groupPatternsByProtocol(patterns);

  // Generate ACL entries
  const aclLines: string[] = [];
  const accessRules: string[] = [];

  // === DOMAINS FOR BOTH PROTOCOLS (current behavior) ===
  if (domainsByProto.both.length > 0) {
    aclLines.push('# ACL definitions for allowed domains (HTTP and HTTPS)');
    for (const domain of domainsByProto.both) {
      aclLines.push(`acl allowed_domains dstdomain ${formatDomainForSquid(domain)}`);
    }
  }

  // === PATTERNS FOR BOTH PROTOCOLS ===
  if (patternsByProto.both.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for allowed domain patterns (HTTP and HTTPS)');
    for (const p of patternsByProto.both) {
      aclLines.push(`acl allowed_domains_regex dstdom_regex -i ${p.regex}`);
    }
  }

  // === HTTP-ONLY DOMAINS ===
  if (domainsByProto.http.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for HTTP-only domains');
    for (const domain of domainsByProto.http) {
      aclLines.push(`acl allowed_http_only dstdomain ${formatDomainForSquid(domain)}`);
    }
  }

  // === HTTP-ONLY PATTERNS ===
  if (patternsByProto.http.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for HTTP-only domain patterns');
    for (const p of patternsByProto.http) {
      aclLines.push(`acl allowed_http_only_regex dstdom_regex -i ${p.regex}`);
    }
  }

  // === HTTPS-ONLY DOMAINS ===
  if (domainsByProto.https.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for HTTPS-only domains');
    for (const domain of domainsByProto.https) {
      aclLines.push(`acl allowed_https_only dstdomain ${formatDomainForSquid(domain)}`);
    }
  }

  // === HTTPS-ONLY PATTERNS ===
  if (patternsByProto.https.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for HTTPS-only domain patterns');
    for (const p of patternsByProto.https) {
      aclLines.push(`acl allowed_https_only_regex dstdom_regex -i ${p.regex}`);
    }
  }

  // Build access rules
  // Order matters: allow rules come before deny rules

  // Allow HTTP-only domains for non-CONNECT requests
  const hasHttpOnly = domainsByProto.http.length > 0 || patternsByProto.http.length > 0;
  if (hasHttpOnly) {
    if (domainsByProto.http.length > 0 && patternsByProto.http.length > 0) {
      accessRules.push('http_access allow !CONNECT allowed_http_only');
      accessRules.push('http_access allow !CONNECT allowed_http_only_regex');
    } else if (domainsByProto.http.length > 0) {
      accessRules.push('http_access allow !CONNECT allowed_http_only');
    } else {
      accessRules.push('http_access allow !CONNECT allowed_http_only_regex');
    }
  }

  // Allow HTTPS-only domains for CONNECT requests
  const hasHttpsOnly = domainsByProto.https.length > 0 || patternsByProto.https.length > 0;
  if (hasHttpsOnly) {
    if (domainsByProto.https.length > 0 && patternsByProto.https.length > 0) {
      accessRules.push('http_access allow CONNECT allowed_https_only');
      accessRules.push('http_access allow CONNECT allowed_https_only_regex');
    } else if (domainsByProto.https.length > 0) {
      accessRules.push('http_access allow CONNECT allowed_https_only');
    } else {
      accessRules.push('http_access allow CONNECT allowed_https_only_regex');
    }
  }

  // Build the deny rule based on configured domains and their protocols
  const hasBothDomains = domainsByProto.both.length > 0;
  const hasBothPatterns = patternsByProto.both.length > 0;

  // Process blocked domains (optional) - blocklist takes precedence over allowlist
  const blockedAclLines: string[] = [];
  const blockedAccessRules: string[] = [];

  if (blockedDomains && blockedDomains.length > 0) {
    // Normalize blocked domains
    const normalizedBlockedDomains = blockedDomains.map(domain => {
      return domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    });

    // Parse blocked domains into plain domains and wildcard patterns
    const { plainDomains: blockedPlainDomains, patterns: blockedPatterns } = parseDomainList(normalizedBlockedDomains);

    // Generate ACL entries for blocked plain domains
    if (blockedPlainDomains.length > 0) {
      blockedAclLines.push('# ACL definitions for blocked domains');
      for (const entry of blockedPlainDomains) {
        blockedAclLines.push(`acl blocked_domains dstdomain ${formatDomainForSquid(entry.domain)}`);
      }
      blockedAccessRules.push('http_access deny blocked_domains');
    }

    // Generate ACL entries for blocked wildcard patterns
    if (blockedPatterns.length > 0) {
      blockedAclLines.push('');
      blockedAclLines.push('# ACL definitions for blocked domain patterns (wildcard)');
      for (const p of blockedPatterns) {
        blockedAclLines.push(`acl blocked_domains_regex dstdom_regex -i ${p.regex}`);
      }
      blockedAccessRules.push('http_access deny blocked_domains_regex');
    }
  }

  // Build the deny rule based on configured domains and their protocols
  let denyRule: string;
  if (hasBothDomains && hasBothPatterns) {
    denyRule = 'http_access deny !allowed_domains !allowed_domains_regex';
  } else if (hasBothDomains) {
    denyRule = 'http_access deny !allowed_domains';
  } else if (hasBothPatterns) {
    denyRule = 'http_access deny !allowed_domains_regex';
  } else if (hasHttpOnly || hasHttpsOnly) {
    // Only protocol-specific domains - deny all by default
    // The allow rules above will permit the specific traffic
    denyRule = 'http_access deny all';
  } else {
    // No domains configured
    denyRule = 'http_access deny all';
  }

  // Combine ACL sections: blocked domains first, then allowed domains
  const allAclLines = [...blockedAclLines];
  if (blockedAclLines.length > 0 && aclLines.length > 0) {
    allAclLines.push('');
  }
  allAclLines.push(...aclLines);
  const aclSection = allAclLines.length > 0 ? allAclLines.join('\n') : '# No domains configured';

  // Combine access rules section:
  // 1. Blocked domains deny rules first (blocklist takes precedence)
  // 2. Protocol-specific allow rules
  // 3. Deny rule for non-allowed domains
  const allAccessRules: string[] = [];

  if (blockedAccessRules.length > 0) {
    allAccessRules.push('# Deny requests to blocked domains (blocklist takes precedence)');
    allAccessRules.push(...blockedAccessRules);
    allAccessRules.push('');
  }

  if (accessRules.length > 0) {
    allAccessRules.push('# Protocol-specific domain access rules');
    allAccessRules.push(...accessRules);
    allAccessRules.push('');
  }

  const accessRulesSection = allAccessRules.length > 0
    ? allAccessRules.join('\n') + '\n'
    : '';

  // Generate SSL Bump section if enabled
  let sslBumpSection = '';
  // Port configuration: Use normal proxy mode (not intercept mode)
  // With targeted port redirection in iptables, traffic is explicitly redirected
  // to Squid on specific ports (80, 443, + user-specified), maintaining defense-in-depth
  let portConfig = `http_port ${port}`;

  // For SSL Bump, we need to check hasPlainDomains and hasPatterns for the 'both' protocol domains
  // since those are the ones that go into allowed_domains / allowed_domains_regex ACLs
  const hasPlainDomainsForSslBump = domainsByProto.both.length > 0;
  const hasPatternsForSslBump = patternsByProto.both.length > 0;

  if (sslBump && caFiles && sslDbPath) {
    sslBumpSection = generateSslBumpSection(
      caFiles,
      sslDbPath,
      hasPlainDomainsForSslBump,
      hasPatternsForSslBump,
      urlPatterns
    );
    // SSL Bump section includes its own port config, so use that instead
    portConfig = '';
  }

  // Port ACLs and access rules
  // Build Safe_ports ACL with user-specified additional ports if provided
  let portAclsSection = `# Port ACLs
acl SSL_ports port 443
acl Safe_ports port 80          # HTTP
acl Safe_ports port 443         # HTTPS`;

  // Add user-specified ports if --allow-host-ports was provided
  if (enableHostAccess && allowHostPorts) {
    // Parse comma-separated ports/ranges and add to ACL
    const ports = allowHostPorts.split(',').map(p => p.trim());
    for (const port of ports) {
      // Validate port or port range to prevent injection and invalid configs
      const parts = port.split('-');
      if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
        // Port range (e.g., "3000-3010")
        const start = parseInt(parts[0], 10);
        const end = parseInt(parts[1], 10);

        if (isNaN(start) || isNaN(end) || start < 1 || end > 65535 || start > end) {
          throw new Error(`Invalid port range: ${port}. Must be in format START-END where 1 <= START <= END <= 65535`);
        }

        // Check if any port in the range is dangerous
        for (let p = start; p <= end; p++) {
          if (DANGEROUS_PORTS.includes(p)) {
            throw new Error(
              `Port range ${port} includes dangerous port ${p} which is blocked for security reasons. ` +
              `Dangerous ports (SSH, databases, etc.) cannot be allowed even with --allow-host-ports.`
            );
          }
        }
      } else {
        // Single port (e.g., "3000" or invalid like "-1")
        const portNum = parseInt(port, 10);

        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
          throw new Error(`Invalid port: ${port}. Must be a number between 1 and 65535`);
        }

        // Check if port is in dangerous ports blocklist
        if (DANGEROUS_PORTS.includes(portNum)) {
          throw new Error(
            `Port ${portNum} is blocked for security reasons. ` +
            `Dangerous ports (SSH:22, MySQL:3306, PostgreSQL:5432, etc.) cannot be allowed even with --allow-host-ports.`
          );
        }
      }

      // Defense-in-depth: Additional sanitization to remove any non-digit/non-dash characters
      // This is redundant given validation above, but provides extra protection against edge cases
      const sanitizedPort = port.replace(/[^0-9-]/g, '');
      portAclsSection += `\nacl Safe_ports port ${sanitizedPort}      # User-specified via --allow-host-ports`;
    }
  }

  portAclsSection += `\nacl CONNECT method CONNECT`;

  const portAclsAndRules = `${portAclsSection}

# Access rules
# Deny unsafe ports (only allow Safe_ports defined above)
http_access deny !Safe_ports
# Allow CONNECT to Safe_ports instead of just SSL_ports (443)
# This is required because some HTTP clients (e.g., Node.js fetch) use CONNECT
# method even for HTTP connections when going through a proxy.
# See: gh-aw-firewall issue #189
http_access deny CONNECT !Safe_ports`;

  return `# Squid configuration for egress traffic control
# Generated by awf
${sslBump ? '\n# SSL Bump mode enabled - HTTPS traffic will be intercepted for URL inspection' : ''}

# Disable pinger (ICMP) - requires NET_RAW capability which we don't have for security
pinger_enable off

# PID file location - use proxy-owned directory since container runs as non-root
pid_filename /var/run/squid/squid.pid

# Custom log format with detailed connection information
# Format: timestamp client_ip:port dest_domain dest_ip:port protocol method status decision url user_agent
# Note: For CONNECT requests (HTTPS), the domain is in the URL field
logformat firewall_detailed %ts.%03tu %>a:%>p %{Host}>h %<a:%<p %rv %rm %>Hs %Ss:%Sh %ru "%{User-Agent}>h"

# Access log and cache configuration
# Don't log healthcheck probes from localhost (using ACL filter on access_log)
acl healthcheck_localhost src 127.0.0.1 ::1
access_log /var/log/squid/access.log firewall_detailed !healthcheck_localhost
cache_log /var/log/squid/cache.log
cache deny all

${aclSection}

# Port configuration
${portConfig}
${sslBumpSection}

# Network ACLs
acl localnet src 10.0.0.0/8
acl localnet src 172.16.0.0/12
acl localnet src 192.168.0.0/16
acl localnet src fc00::/7
acl localnet src fe80::/10

${portAclsAndRules}

# Deny CONNECT to raw IP addresses (IPv4 and IPv6)
# Prevents bypassing domain-based filtering via direct IP connections
acl dst_ipv4 dstdom_regex ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$
acl dst_ipv6 dstdom_regex ^\\[?[0-9a-fA-F:]+\\]?$
http_access deny dst_ipv4
http_access deny dst_ipv6

${accessRulesSection}# Deny requests to unknown domains (not in allow-list)
# This applies to all sources including localnet
${denyRule}

# Allow from trusted sources (after domain filtering)
http_access allow localnet
http_access allow localhost

# Deny everything else
http_access deny all

# Disable caching
cache deny all

# DNS settings
dns_nameservers 8.8.8.8 8.8.4.4

# Forwarded headers
forwarded_for delete
via off

# Error page customization
error_directory /usr/share/squid/errors/en

# Memory and file descriptor limits
cache_mem 64 MB
maximum_object_size 0 KB

# Timeout settings for streaming/long-lived connections (AI inference APIs)
# read_timeout: Time to wait for data from server before giving up
# Increased to accommodate long AI inference calls and SSE streaming
read_timeout 30 minutes

# connect_timeout: Time to wait for TCP connection to origin server
connect_timeout 30 seconds

# request_timeout: Time to wait for client to send first request after connection
request_timeout 2 minutes

# persistent_request_timeout: Time to wait for next request on persistent connection
persistent_request_timeout 2 minutes

# pconn_timeout: How long to keep idle persistent connections to servers
pconn_timeout 2 minutes

# client_lifetime: Maximum time a client connection can be open
# Set high to accommodate long streaming sessions
client_lifetime 8 hours

# half_closed_clients: Allow half-closed connections for streaming
# Critical for SSE where server sends but client doesn't respond
half_closed_clients on

# Debugging (can be enabled for troubleshooting)
# debug_options ALL,1 33,2
`;
}
