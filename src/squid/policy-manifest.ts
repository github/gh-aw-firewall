import type { PolicyManifest, PolicyRule, SquidConfig } from '../types';
import { DEFAULT_DNS_SERVERS } from '../dns-resolver';
import { parseDomainList } from '../domain-matchers';
import { formatDomainForSquid, parseDomainConfig } from './domain-acl';

/**
 * Ports that should never be allowed, even with --allow-host-ports
 * These ports are blocked for security reasons to prevent access to sensitive services
 */
export const DANGEROUS_PORTS = [
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
 * Generates a structured policy manifest describing all effective access-control rules.
 *
 * The manifest reflects the logical policy and overall evaluation order derived from
 * generateSquidConfig(), but it is a higher-level representation rather than a literal
 * list of Squid `http_access` directives. Some internal rules (negations, method
 * constraints, localhost/localnet allowances) are abstracted into logical concepts.
 *
 * Port/method-based rules (deny-unsafe-ports, deny-dlp) have empty `domains` arrays
 * because they can't be deterministically replayed from Squid log data alone — the
 * enricher skips them and attributes those denials to "unknown".
 */
export function generatePolicyManifest(config: SquidConfig): PolicyManifest {
  const { domains, blockedDomains, sslBump, enableHostAccess, allowHostPorts, enableDlp, dnsServers, apiProxyIp } = config;

  // Parse, deduplicate, and group domains by protocol (shared logic with generateSquidConfig)
  const { domainsByProto, patternsByProto } = parseDomainConfig(domains);

  const rules: PolicyRule[] = [];
  let order = 0;

  // --- Port safety rules (evaluated first in Squid) ---
  rules.push({
    id: 'deny-unsafe-ports',
    order: ++order,
    action: 'deny',
    aclName: '!Safe_ports',
    protocol: 'both',
    domains: [],
    description: 'Deny requests to ports not in Safe_ports ACL (only 80, 443, and user-specified ports allowed)',
  });
  rules.push({
    id: 'deny-connect-unsafe-ports',
    order: ++order,
    action: 'deny',
    aclName: 'CONNECT !Safe_ports',
    protocol: 'https',
    domains: [],
    description: 'Deny CONNECT (HTTPS) to ports not in Safe_ports ACL',
  });

  // --- api-proxy allow (before raw-IP deny) ---
  if (apiProxyIp) {
    rules.push({
      id: 'allow-api-proxy-ip',
      order: ++order,
      action: 'allow',
      aclName: 'allow_api_proxy_ip',
      protocol: 'both',
      domains: [apiProxyIp],
      description: 'Allow connections to the AWF api-proxy sidecar IP before raw-IP deny rules',
    });
    rules.push({
      id: 'allow-from-api-proxy',
      order: ++order,
      action: 'allow',
      aclName: 'from_api_proxy',
      protocol: 'both',
      domains: ['*'],
      description: 'Allow unrestricted outbound from api-proxy sidecar (trusted AWF component, not subject to agent domain ACL)',
    });
  }

  // --- Raw IP blocking ---
  rules.push({
    id: 'deny-raw-ipv4',
    order: ++order,
    action: 'deny',
    aclName: 'dst_ipv4',
    protocol: 'both',
    domains: ['^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'],
    description: 'Deny requests to raw IPv4 addresses (bypasses domain filtering)',
  });
  rules.push({
    id: 'deny-raw-ipv6',
    order: ++order,
    action: 'deny',
    aclName: 'dst_ipv6',
    protocol: 'both',
    domains: ['^\\[?[0-9a-fA-F:]+\\]?$'],
    description: 'Deny requests to raw IPv6 addresses (bypasses domain filtering)',
  });

  // --- DLP rules (if enabled) ---
  if (enableDlp) {
    rules.push({
      id: 'deny-dlp',
      order: ++order,
      action: 'deny',
      aclName: 'dlp_blocked',
      protocol: 'both',
      domains: [],
      description: 'Deny requests containing credential patterns in URLs (DLP)',
    });
  }

  // --- Blocked domains ---
  if (blockedDomains && blockedDomains.length > 0) {
    const normalizedBlocked = blockedDomains.map(d => d.replace(/^https?:\/\//, '').replace(/\/$/, ''));
    const { plainDomains: blockedPlain, patterns: blockedPatterns } = parseDomainList(normalizedBlocked);

    if (blockedPlain.length > 0) {
      rules.push({
        id: 'deny-blocked-plain',
        order: ++order,
        action: 'deny',
        aclName: 'blocked_domains',
        protocol: 'both',
        domains: blockedPlain.map(e => formatDomainForSquid(e.domain)),
        description: 'Deny requests to explicitly blocked domains',
      });
    }

    if (blockedPatterns.length > 0) {
      rules.push({
        id: 'deny-blocked-regex',
        order: ++order,
        action: 'deny',
        aclName: 'blocked_domains_regex',
        protocol: 'both',
        domains: blockedPatterns.map(p => p.regex),
        description: 'Deny requests to explicitly blocked domain patterns',
      });
    }
  }

  // --- Protocol-specific allow rules ---
  if (domainsByProto.http.length > 0) {
    rules.push({
      id: 'allow-http-only-plain',
      order: ++order,
      action: 'allow',
      aclName: 'allowed_http_only',
      protocol: 'http',
      domains: domainsByProto.http.map(d => formatDomainForSquid(d)),
      description: 'Allow HTTP-only traffic to these domains (no HTTPS)',
    });
  }
  if (patternsByProto.http.length > 0) {
    rules.push({
      id: 'allow-http-only-regex',
      order: ++order,
      action: 'allow',
      aclName: 'allowed_http_only_regex',
      protocol: 'http',
      domains: patternsByProto.http.map(p => p.regex),
      description: 'Allow HTTP-only traffic matching these patterns',
    });
  }

  if (domainsByProto.https.length > 0) {
    rules.push({
      id: 'allow-https-only-plain',
      order: ++order,
      action: 'allow',
      aclName: 'allowed_https_only',
      protocol: 'https',
      domains: domainsByProto.https.map(d => formatDomainForSquid(d)),
      description: 'Allow HTTPS-only traffic to these domains (no HTTP)',
    });
  }
  if (patternsByProto.https.length > 0) {
    rules.push({
      id: 'allow-https-only-regex',
      order: ++order,
      action: 'allow',
      aclName: 'allowed_https_only_regex',
      protocol: 'https',
      domains: patternsByProto.https.map(p => p.regex),
      description: 'Allow HTTPS-only traffic matching these patterns',
    });
  }

  // --- Both-protocol allow (used in deny rule logic) ---
  if (domainsByProto.both.length > 0) {
    rules.push({
      id: 'allow-both-plain',
      order: ++order,
      action: 'allow',
      aclName: 'allowed_domains',
      protocol: 'both',
      domains: domainsByProto.both.map(d => formatDomainForSquid(d)),
      description: 'Allow HTTP and HTTPS traffic to these domains',
    });
  }
  if (patternsByProto.both.length > 0) {
    rules.push({
      id: 'allow-both-regex',
      order: ++order,
      action: 'allow',
      aclName: 'allowed_domains_regex',
      protocol: 'both',
      domains: patternsByProto.both.map(p => p.regex),
      description: 'Allow HTTP and HTTPS traffic matching these patterns',
    });
  }

  // --- Default deny (final rule) ---
  rules.push({
    id: 'deny-default',
    order: ++order,
    action: 'deny',
    aclName: 'all',
    protocol: 'both',
    domains: [],
    description: 'Deny all traffic not matching any allow rule (default deny)',
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rules,
    dangerousPorts: DANGEROUS_PORTS,
    dnsServers: dnsServers || DEFAULT_DNS_SERVERS,
    sslBumpEnabled: sslBump ?? false,
    dlpEnabled: enableDlp ?? false,
    hostAccessEnabled: enableHostAccess ?? false,
    allowHostPorts: allowHostPorts ?? null,
  };
}
