import { parseDomainConfig } from './domain-acl';

type DomainsByProto = ReturnType<typeof parseDomainConfig>['domainsByProto'];
type PatternsByProto = ReturnType<typeof parseDomainConfig>['patternsByProto'];

export function generateProtocolRules(domainsByProto: DomainsByProto, patternsByProto: PatternsByProto): string[] {
  const accessRules: string[] = [];
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

  return accessRules;
}

export function generateDenyRule(domainsByProto: DomainsByProto, patternsByProto: PatternsByProto): string {
  const hasBothDomains = domainsByProto.both.length > 0;
  const hasBothPatterns = patternsByProto.both.length > 0;
  const hasHttpOnly = domainsByProto.http.length > 0 || patternsByProto.http.length > 0;
  const hasHttpsOnly = domainsByProto.https.length > 0 || patternsByProto.https.length > 0;

  if (hasBothDomains && hasBothPatterns) {
    return 'http_access deny !allowed_domains !allowed_domains_regex';
  }
  if (hasBothDomains) {
    return 'http_access deny !allowed_domains';
  }
  if (hasBothPatterns) {
    return 'http_access deny !allowed_domains_regex';
  }
  if (hasHttpOnly || hasHttpsOnly) {
    return 'http_access deny all';
  }
  return 'http_access deny all';
}

export function generateAccessRulesSection(blockedAccessRules: string[], protocolRules: string[]): string {
  const allAccessRules: string[] = [];

  if (blockedAccessRules.length > 0) {
    allAccessRules.push('# Deny requests to blocked domains (blocklist takes precedence)');
    allAccessRules.push(...blockedAccessRules);
    allAccessRules.push('');
  }

  if (protocolRules.length > 0) {
    allAccessRules.push('# Protocol-specific domain access rules');
    allAccessRules.push(...protocolRules);
    allAccessRules.push('');
  }

  return allAccessRules.length > 0
    ? allAccessRules.join('\n') + '\n'
    : '';
}
