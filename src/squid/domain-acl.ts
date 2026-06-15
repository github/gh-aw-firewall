import { parseDomainList, isDomainMatchedByPattern } from '../domain-matchers';
import { PlainDomainEntry, DomainPattern } from '../domain-patterns';
import { SQUID_DANGEROUS_CHARS } from '../domain-validation';

/**
 * Groups domains by their protocol restriction
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
 * Defense-in-depth: assert a domain/regex/URL-pattern string is safe for Squid config interpolation.
 * Rejects whitespace, null bytes, quotes, semicolons, backticks, and hash characters —
 * all of which can inject directives, tokens, or comments into Squid config.
 */
export function assertSafeForSquidConfig(value: string): string {
  if (SQUID_DANGEROUS_CHARS.test(value)) {
    throw new Error(
      `SECURITY: Domain or pattern contains characters unsafe for Squid config and cannot be ` +
      `interpolated into squid.conf: ${JSON.stringify(value)}`
    );
  }
  return value;
}

/**
 * Helper to add leading dot to domain for Squid subdomain matching
 */
export function formatDomainForSquid(domain: string): string {
  assertSafeForSquidConfig(domain);
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
 * Shared domain parsing: validates, deduplicates, filters, and groups domains by protocol.
 * Used by both generateSquidConfig and generatePolicyManifest to ensure consistent logic.
 */
export function parseDomainConfig(domains: string[]): {
  domainsByProto: DomainsByProtocol;
  patternsByProto: PatternsByProtocol;
  patterns: DomainPattern[];
} {
  const { plainDomains, patterns } = parseDomainList(domains);

  // Remove redundant plain subdomains within same protocol
  const uniquePlainDomains = plainDomains.filter((entry, index, arr) => {
    return !arr.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      if (entry.domain === other.domain || !entry.domain.endsWith('.' + other.domain)) {
        return false;
      }
      return other.protocol === 'both' || other.protocol === entry.protocol;
    });
  });

  // Remove plain domains already covered by wildcard patterns
  const filteredPlainDomains = uniquePlainDomains.filter(entry => {
    return !isDomainMatchedByPattern(entry, patterns);
  });

  return {
    domainsByProto: groupDomainsByProtocol(filteredPlainDomains),
    patternsByProto: groupPatternsByProtocol(patterns),
    patterns,
  };
}
