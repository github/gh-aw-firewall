import type { PolicyRule } from '../../types';
import { parseDomainList } from '../../domain-matchers';
import { formatDomainForSquid } from '../domain-acl';
import type { DomainPattern } from '../../domain-patterns';

export interface DomainsByProtocol {
  http: string[];
  https: string[];
  both: string[];
}

export interface PatternsByProtocol {
  http: DomainPattern[];
  https: DomainPattern[];
  both: DomainPattern[];
}

export interface PolicyRuleState {
  rules: PolicyRule[];
  order: number;
}

function pushRule(state: PolicyRuleState, rule: Omit<PolicyRule, 'order'>): void {
  state.rules.push({
    ...rule,
    order: ++state.order,
  });
}

export function addPortSafetyRules(state: PolicyRuleState): void {
  pushRule(state, {
    id: 'deny-unsafe-ports',
    action: 'deny',
    aclName: '!Safe_ports',
    protocol: 'both',
    domains: [],
    description: 'Deny requests to ports not in Safe_ports ACL (only 80, 443, and user-specified ports allowed)',
  });
  pushRule(state, {
    id: 'deny-connect-unsafe-ports',
    action: 'deny',
    aclName: 'CONNECT !Safe_ports',
    protocol: 'https',
    domains: [],
    description: 'Deny CONNECT (HTTPS) to ports not in Safe_ports ACL',
  });
}

export function addApiProxyAllowRules(state: PolicyRuleState, apiProxyIp?: string): void {
  if (!apiProxyIp) {
    return;
  }

  pushRule(state, {
    id: 'allow-api-proxy-ip',
    action: 'allow',
    aclName: 'allow_api_proxy_ip',
    protocol: 'both',
    domains: [apiProxyIp],
    description: 'Allow connections to the AWF api-proxy sidecar IP before raw-IP deny rules',
  });
  pushRule(state, {
    id: 'allow-from-api-proxy',
    action: 'allow',
    aclName: 'from_api_proxy',
    protocol: 'both',
    domains: ['*'],
    description: 'Allow unrestricted outbound from api-proxy sidecar (trusted AWF component, not subject to agent domain ACL)',
  });
}

export function addRawIpBlockRules(state: PolicyRuleState): void {
  pushRule(state, {
    id: 'deny-raw-ipv4',
    action: 'deny',
    aclName: 'dst_ipv4',
    protocol: 'both',
    domains: ['^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'],
    description: 'Deny requests to raw IPv4 addresses (bypasses domain filtering)',
  });
  pushRule(state, {
    id: 'deny-raw-ipv6',
    action: 'deny',
    aclName: 'dst_ipv6',
    protocol: 'both',
    domains: ['^\\[?[0-9a-fA-F:]+\\]?$'],
    description: 'Deny requests to raw IPv6 addresses (bypasses domain filtering)',
  });
}

export function addDlpRules(state: PolicyRuleState, enableDlp?: boolean): void {
  if (!enableDlp) {
    return;
  }

  pushRule(state, {
    id: 'deny-dlp',
    action: 'deny',
    aclName: 'dlp_blocked',
    protocol: 'both',
    domains: [],
    description: 'Deny requests containing credential patterns in URLs (DLP)',
  });
}

export function addBlockedDomainRules(state: PolicyRuleState, blockedDomains?: string[]): void {
  if (!blockedDomains || blockedDomains.length === 0) {
    return;
  }

  const normalizedBlocked = blockedDomains.map(d => d.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  const { plainDomains: blockedPlain, patterns: blockedPatterns } = parseDomainList(normalizedBlocked);

  if (blockedPlain.length > 0) {
    pushRule(state, {
      id: 'deny-blocked-plain',
      action: 'deny',
      aclName: 'blocked_domains',
      protocol: 'both',
      domains: blockedPlain.map(entry => formatDomainForSquid(entry.domain)),
      description: 'Deny requests to explicitly blocked domains',
    });
  }

  if (blockedPatterns.length > 0) {
    pushRule(state, {
      id: 'deny-blocked-regex',
      action: 'deny',
      aclName: 'blocked_domains_regex',
      protocol: 'both',
      domains: blockedPatterns.map(pattern => pattern.regex),
      description: 'Deny requests to explicitly blocked domain patterns',
    });
  }
}

export function addProtocolAllowRules(
  state: PolicyRuleState,
  domainsByProto: DomainsByProtocol,
  patternsByProto: PatternsByProtocol
): void {
  if (domainsByProto.http.length > 0) {
    pushRule(state, {
      id: 'allow-http-only-plain',
      action: 'allow',
      aclName: 'allowed_http_only',
      protocol: 'http',
      domains: domainsByProto.http.map(domain => formatDomainForSquid(domain)),
      description: 'Allow HTTP-only traffic to these domains (no HTTPS)',
    });
  }
  if (patternsByProto.http.length > 0) {
    pushRule(state, {
      id: 'allow-http-only-regex',
      action: 'allow',
      aclName: 'allowed_http_only_regex',
      protocol: 'http',
      domains: patternsByProto.http.map(pattern => pattern.regex),
      description: 'Allow HTTP-only traffic matching these patterns',
    });
  }

  if (domainsByProto.https.length > 0) {
    pushRule(state, {
      id: 'allow-https-only-plain',
      action: 'allow',
      aclName: 'allowed_https_only',
      protocol: 'https',
      domains: domainsByProto.https.map(domain => formatDomainForSquid(domain)),
      description: 'Allow HTTPS-only traffic to these domains (no HTTP)',
    });
  }
  if (patternsByProto.https.length > 0) {
    pushRule(state, {
      id: 'allow-https-only-regex',
      action: 'allow',
      aclName: 'allowed_https_only_regex',
      protocol: 'https',
      domains: patternsByProto.https.map(pattern => pattern.regex),
      description: 'Allow HTTPS-only traffic matching these patterns',
    });
  }
}

export function addBothProtocolAllowRules(
  state: PolicyRuleState,
  domainsByProto: DomainsByProtocol,
  patternsByProto: PatternsByProtocol
): void {
  if (domainsByProto.both.length > 0) {
    pushRule(state, {
      id: 'allow-both-plain',
      action: 'allow',
      aclName: 'allowed_domains',
      protocol: 'both',
      domains: domainsByProto.both.map(domain => formatDomainForSquid(domain)),
      description: 'Allow HTTP and HTTPS traffic to these domains',
    });
  }
  if (patternsByProto.both.length > 0) {
    pushRule(state, {
      id: 'allow-both-regex',
      action: 'allow',
      aclName: 'allowed_domains_regex',
      protocol: 'both',
      domains: patternsByProto.both.map(pattern => pattern.regex),
      description: 'Allow HTTP and HTTPS traffic matching these patterns',
    });
  }
}

export function addDefaultDenyRule(state: PolicyRuleState): void {
  pushRule(state, {
    id: 'deny-default',
    action: 'deny',
    aclName: 'all',
    protocol: 'both',
    domains: [],
    description: 'Deny all traffic not matching any allow rule (default deny)',
  });
}
