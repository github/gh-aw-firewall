import { parseDomainList } from '../domain-matchers';
import { formatDomainForSquid, parseDomainConfig } from './domain-acl';

type DomainsByProto = ReturnType<typeof parseDomainConfig>['domainsByProto'];
type PatternsByProto = ReturnType<typeof parseDomainConfig>['patternsByProto'];

function generateDomainAcls(domainsByProto: DomainsByProto, patternsByProto: PatternsByProto): string[] {
  const aclLines: string[] = [];

  if (domainsByProto.both.length > 0) {
    aclLines.push('# ACL definitions for allowed domains (HTTP and HTTPS)');
    for (const domain of domainsByProto.both) {
      aclLines.push(`acl allowed_domains dstdomain ${formatDomainForSquid(domain)}`);
    }
  }

  if (patternsByProto.both.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for allowed domain patterns (HTTP and HTTPS)');
    for (const p of patternsByProto.both) {
      aclLines.push(`acl allowed_domains_regex dstdom_regex -i ${p.regex}`);
    }
  }

  if (domainsByProto.http.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for HTTP-only domains');
    for (const domain of domainsByProto.http) {
      aclLines.push(`acl allowed_http_only dstdomain ${formatDomainForSquid(domain)}`);
    }
  }

  if (patternsByProto.http.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for HTTP-only domain patterns');
    for (const p of patternsByProto.http) {
      aclLines.push(`acl allowed_http_only_regex dstdom_regex -i ${p.regex}`);
    }
  }

  if (domainsByProto.https.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for HTTPS-only domains');
    for (const domain of domainsByProto.https) {
      aclLines.push(`acl allowed_https_only dstdomain ${formatDomainForSquid(domain)}`);
    }
  }

  if (patternsByProto.https.length > 0) {
    aclLines.push('');
    aclLines.push('# ACL definitions for HTTPS-only domain patterns');
    for (const p of patternsByProto.https) {
      aclLines.push(`acl allowed_https_only_regex dstdom_regex -i ${p.regex}`);
    }
  }

  return aclLines;
}

function generateBlockedDomainAcls(blockedDomains?: string[]): {
  aclLines: string[];
  accessRules: string[];
} {
  const blockedAclLines: string[] = [];
  const blockedAccessRules: string[] = [];

  if (blockedDomains && blockedDomains.length > 0) {
    const normalizedBlockedDomains = blockedDomains.map(domain => {
      return domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    });

    const { plainDomains: blockedPlainDomains, patterns: blockedPatterns } = parseDomainList(normalizedBlockedDomains);

    if (blockedPlainDomains.length > 0) {
      blockedAclLines.push('# ACL definitions for blocked domains');
      for (const entry of blockedPlainDomains) {
        blockedAclLines.push(`acl blocked_domains dstdomain ${formatDomainForSquid(entry.domain)}`);
      }
      blockedAccessRules.push('http_access deny blocked_domains');
    }

    if (blockedPatterns.length > 0) {
      blockedAclLines.push('');
      blockedAclLines.push('# ACL definitions for blocked domain patterns (wildcard)');
      for (const p of blockedPatterns) {
        blockedAclLines.push(`acl blocked_domains_regex dstdom_regex -i ${p.regex}`);
      }
      blockedAccessRules.push('http_access deny blocked_domains_regex');
    }
  }

  return {
    aclLines: blockedAclLines,
    accessRules: blockedAccessRules,
  };
}

export function generateAclSections(
  domainsByProto: DomainsByProto,
  patternsByProto: PatternsByProto,
  blockedDomains?: string[]
): {
  aclLines: string[];
  blockedDomainConfig: {
    aclLines: string[];
    accessRules: string[];
  };
} {
  return {
    aclLines: generateDomainAcls(domainsByProto, patternsByProto),
    blockedDomainConfig: generateBlockedDomainAcls(blockedDomains),
  };
}
