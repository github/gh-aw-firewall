import type { PolicyManifest, SquidConfig } from '../types';
import { DEFAULT_DNS_SERVERS } from '../dns-resolver';
import { parseDomainConfig } from './domain-acl';
import {
  addApiProxyAllowRules,
  addBlockedDomainRules,
  addBothProtocolAllowRules,
  addDefaultDenyRule,
  addDlpRules,
  addPortSafetyRules,
  addProtocolAllowRules,
  addRawIpBlockRules,
  type PolicyRuleState,
} from './policy-rules/section-builders';

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

  const state: PolicyRuleState = { rules: [], order: 0 };

  addPortSafetyRules(state);
  addApiProxyAllowRules(state, apiProxyIp);
  addRawIpBlockRules(state);
  addDlpRules(state, enableDlp);
  addBlockedDomainRules(state, blockedDomains);
  addProtocolAllowRules(state, domainsByProto, patternsByProto);
  addBothProtocolAllowRules(state, domainsByProto, patternsByProto);
  addDefaultDenyRule(state);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rules: state.rules,
    dangerousPorts: DANGEROUS_PORTS,
    dnsServers: dnsServers || DEFAULT_DNS_SERVERS,
    sslBumpEnabled: sslBump ?? false,
    dlpEnabled: enableDlp ?? false,
    hostAccessEnabled: enableHostAccess ?? false,
    allowHostPorts: allowHostPorts ?? null,
  };
}
