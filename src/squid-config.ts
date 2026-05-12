import { SquidConfig } from './types';
import { parseDomainList } from './domain-patterns';
import { generateDlpSquidConfig } from './dlp';
import { DEFAULT_DNS_SERVERS } from './dns-resolver';
import { DANGEROUS_PORTS } from './squid/policy-manifest';
import { parseDomainConfig, formatDomainForSquid } from './squid/domain-acl';
import { generateSslBumpSection } from './squid/ssl-bump';
import { generateUpstreamProxySection } from './squid/upstream-proxy';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: AWF_VERSION } = require('../package.json') as { version: string };

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
  const { domains, blockedDomains, port, sslBump, caFiles, sslDbPath, urlPatterns, enableHostAccess, allowHostPorts, enableDlp, dnsServers, upstreamProxy, apiProxyIp, apiProxyPorts } = config;

  // Validate apiProxyIp if provided — must be a valid IPv4 address to prevent config injection.
  // Each octet must be 0-255; the simple \d{1,3} pattern would wrongly accept 999.999.999.999.
  if (apiProxyIp !== undefined) {
    const octet = '(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]\\d|\\d)';
    const ipv4Re = new RegExp(`^(?:${octet}\\.){3}${octet}$`);
    if (!ipv4Re.test(apiProxyIp)) {
      throw new Error(`SECURITY: apiProxyIp must be a valid IPv4 address (0-255 octets), got: ${JSON.stringify(apiProxyIp)}`);
    }
  }

  // Parse, deduplicate, and group domains by protocol (shared logic)
  const { domainsByProto, patternsByProto } = parseDomainConfig(domains);

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
  let sslBumpUrlAccessSection = '';
  // Port configuration: Use normal proxy mode (not intercept mode)
  // With targeted port redirection in iptables, traffic is explicitly redirected
  // to Squid on specific ports (80, 443, + user-specified), maintaining defense-in-depth
  // Listen on both IPv4 and IPv6 as defense-in-depth (see #1543)
  let portConfig = `http_port ${port}\nhttp_port [::]:${port}`;

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
    if (urlPatterns && urlPatterns.length > 0) {
      const urlAccessLines = urlPatterns
        .map((_, i) => `http_access allow allowed_url_${i}`)
        .join('\n');

      const denyNonMatching = hasPlainDomainsForSslBump
        ? 'http_access deny !CONNECT allowed_domains'
        : hasPatternsForSslBump
          ? 'http_access deny !CONNECT allowed_domains_regex'
          : '';

      sslBumpUrlAccessSection = `
# Allow HTTPS requests matching URL patterns
${urlAccessLines}

# Deny requests that don't match URL patterns
${denyNonMatching}
`;
    }
    // SSL Bump section includes its own port config, so use that instead
    portConfig = '';
  }

  // Generate DLP section if enabled
  let dlpAclSection = '';
  let dlpAccessSection = '';
  if (enableDlp) {
    const dlp = generateDlpSquidConfig();
    dlpAclSection = '\n' + dlp.aclLines.join('\n') + '\n';
    dlpAccessSection = '\n' + dlp.accessRules.join('\n') + '\n';
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

  // Add api-proxy ports to Safe_ports so that CONNECT / requests to those ports
  // are not rejected by `deny CONNECT !Safe_ports` / `deny !Safe_ports` before
  // the per-IP allow rule (below) has a chance to fire.
  if (apiProxyPorts && apiProxyPorts.length > 0) {
    for (const proxyPort of apiProxyPorts) {
      if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
        throw new Error(`Invalid api-proxy port: ${proxyPort}. Must be an integer between 1 and 65535`);
      }
      if (DANGEROUS_PORTS.includes(proxyPort)) {
        throw new Error(
          `Api-proxy port ${proxyPort} is blocked for security reasons. ` +
          `Dangerous ports (SSH, databases, etc.) cannot be added to Safe_ports.`
        );
      }
      portAclsSection += `\nacl Safe_ports port ${proxyPort}     # AWF api-proxy sidecar`;
    }
  }

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

# Structured JSONL audit log for machine-readable analysis
# Note: Squid logformat does not JSON-escape strings, so fields like User-Agent
# could break JSON parsing. We omit User-Agent to reduce breakage risk.
logformat audit_jsonl {"_schema":"audit/v${AWF_VERSION}","ts":%ts.%03tu,"client":"%>a","host":"%{Host}>h","dest":"%<a:%<p","method":"%rm","status":%>Hs,"decision":"%Ss","url":"%ru"}

# Access log and cache configuration
# Don't log healthcheck probes from localhost (using ACL filter on access_log)
acl healthcheck_localhost src 127.0.0.1 ::1
access_log /var/log/squid/access.log firewall_detailed !healthcheck_localhost
access_log /var/log/squid/audit.jsonl audit_jsonl !healthcheck_localhost
cache_log /var/log/squid/cache.log
cache deny all

${aclSection}
${dlpAclSection}
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
${apiProxyIp ? `
# Allow connections to the AWF api-proxy sidecar before raw-IP deny rules.
# Some HTTP clients (e.g., Node.js fetch / undici ProxyAgent) route requests to
# the api-proxy via HTTP_PROXY without honouring NO_PROXY for raw IP addresses,
# causing them to arrive at Squid and be rejected by the raw-IP deny rule below.
# This allow rule fires first for the known api-proxy IP.
acl allow_api_proxy_ip dst ${apiProxyIp}
http_access allow allow_api_proxy_ip
` : ''}
# Deny CONNECT to raw IP addresses (IPv4 and IPv6)
# Prevents bypassing domain-based filtering via direct IP connections
acl dst_ipv4 dstdom_regex ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$
acl dst_ipv6 dstdom_regex ^\\[?[0-9a-fA-F:]+\\]?$
http_access deny dst_ipv4
http_access deny dst_ipv6
${dlpAccessSection}
${sslBumpUrlAccessSection}
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

# DNS settings - Squid resolves all domains for HTTP/HTTPS traffic
dns_nameservers ${(dnsServers && dnsServers.length > 0) ? dnsServers.join(' ') : DEFAULT_DNS_SERVERS.join(' ')}
${upstreamProxy ? '\n' + generateUpstreamProxySection(upstreamProxy) : ''}
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

# shutdown_lifetime: Time to wait for active connections during shutdown
# Set to 0 because this is an ephemeral proxy — no connection draining needed
shutdown_lifetime 0 seconds

# Debugging (can be enabled for troubleshooting)
# debug_options ALL,1 33,2
`;
}

export { generatePolicyManifest } from './squid/policy-manifest';
