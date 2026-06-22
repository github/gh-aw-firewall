/**
 * Domain list management and pattern matching
 *
 * Provides functions to parse an array of raw domain strings (which may include
 * protocol prefixes and wildcard patterns) into structured lists, and to test
 * whether a given domain is covered by any of those patterns.
 */

import {
  parseDomainWithProtocol,
  isWildcardPattern,
  wildcardToRegex,
  type DomainPattern,
  type PlainDomainEntry,
} from './domain-patterns';
import { validateDomainOrPattern } from './domain-validation';

/**
 * Parse and categorize domains into plain domains and wildcard patterns
 *
 * @param domains - Array of domain strings (may include wildcards and protocol prefixes)
 * @returns Object with plainDomains and patterns arrays
 * @throws Error if any domain/pattern is invalid
 */
export function parseDomainList(domains: string[]): {
  plainDomains: PlainDomainEntry[];
  patterns: DomainPattern[];
} {
  const plainDomains: PlainDomainEntry[] = [];
  const patterns: DomainPattern[] = [];

  for (const domainInput of domains) {
    // Validate each domain/pattern
    validateDomainOrPattern(domainInput);

    // Parse protocol and domain
    const parsed = parseDomainWithProtocol(domainInput);
    const domain = parsed.domain;
    const protocol = parsed.protocol;

    if (isWildcardPattern(domain)) {
      patterns.push({
        original: domain,
        regex: wildcardToRegex(domain),
        protocol,
      });
    } else {
      plainDomains.push({ domain, protocol });
    }
  }

  return { plainDomains, patterns };
}

/**
 * Check if a plain domain would be matched by any of the wildcard patterns
 * considering protocol restrictions.
 *
 * A domain is only considered "matched" if both:
 * 1. The domain matches the pattern regex
 * 2. The pattern's protocol restriction covers the domain's protocol
 *
 * Protocol compatibility:
 * - Pattern 'both' covers any domain protocol (http, https, both)
 * - Pattern 'http' only covers domain with 'http' protocol
 * - Pattern 'https' only covers domain with 'https' protocol
 *
 * Security: Input length is validated before regex matching to prevent
 * potential ReDoS attacks with extremely long inputs.
 *
 * @param domainEntry - Plain domain entry with protocol to check
 * @param patterns - Array of wildcard patterns with their regex and protocol
 * @returns true if the domain is fully covered by a pattern
 */
export function isDomainMatchedByPattern(
  domainEntry: PlainDomainEntry,
  patterns: DomainPattern[]
): boolean {
  // Defense in depth: Limit domain length to prevent potential ReDoS
  // RFC 1035 limits domain names to 253 characters, add buffer for edge cases
  const MAX_DOMAIN_LENGTH = 512;
  if (domainEntry.domain.length > MAX_DOMAIN_LENGTH) {
    return false;
  }

  for (const pattern of patterns) {
    try {
      // Use case-insensitive matching (DNS is case-insensitive)
      const regex = new RegExp(pattern.regex, 'i');
      if (regex.test(domainEntry.domain)) {
        // Check protocol compatibility
        // Pattern 'both' covers any domain
        if (pattern.protocol === 'both') {
          return true;
        }
        // A domain that needs both protocols cannot be fully covered by a single-protocol pattern
        if (domainEntry.protocol === 'both') {
          continue;
        }
        // Pattern matches specific protocol
        if (pattern.protocol === domainEntry.protocol) {
          return true;
        }
      }
    } catch {
      // Invalid regex, skip this pattern
      continue;
    }
  }
  return false;
}

/**
 * Regex pattern for matching URL path characters.
 * Uses character class instead of .* to prevent catastrophic backtracking (ReDoS).
 * Matches any non-whitespace character, which is appropriate for URL paths.
 */
const URL_CHAR_PATTERN = '[^\\s]*';

/**
 * Regex pattern for matching hostname characters.
 * Unlike URL_CHAR_PATTERN, this does NOT match '/' to prevent hostname wildcards
 * from crossing the host/path boundary (e.g., `api-*` must not match `/`).
 */
const HOST_CHAR_PATTERN = '[^\\s/]*';

/**
 * Parses URL patterns for SSL Bump ACL rules
 *
 * Converts user-friendly URL patterns into Squid url_regex ACL patterns.
 *
 * Examples:
 * - `https://github.com/myorg/*` → `^https://github\.com/myorg/[^\s]*`
 * - `https://api.example.com/v1/users` → `^https://api\.example\.com/v1/users$`
 *
 * @param patterns - Array of URL patterns (can include wildcards)
 * @returns Array of regex patterns for Squid url_regex ACL
 */
export function parseUrlPatterns(patterns: string[]): string[] {
  return patterns.map(pattern => {
    // Remove trailing slash for consistency
    let p = pattern.replace(/\/$/, '');

    // Preserve existing .* patterns by using a placeholder before escaping
    const WILDCARD_PLACEHOLDER = '\x00WILDCARD\x00';
    p = p.replace(/\.\*/g, WILDCARD_PLACEHOLDER);

    // Split into host and path portions to apply different wildcard patterns.
    // Wildcards in hostname must not match '/' to prevent host/path boundary crossing.
    const schemeMatch = p.match(/^(https?:\/\/)/);
    const schemeLen = schemeMatch ? schemeMatch[1].length : 0;
    const firstSlashAfterScheme = p.indexOf('/', schemeLen);

    let hostPart: string;
    let pathPart: string;
    if (firstSlashAfterScheme === -1) {
      hostPart = p;
      pathPart = '';
    } else {
      hostPart = p.slice(0, firstSlashAfterScheme);
      pathPart = p.slice(firstSlashAfterScheme);
    }

    // Escape regex special characters except * in each part
    hostPart = hostPart.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    pathPart = pathPart.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

    // Convert * wildcards: HOST_CHAR_PATTERN for hostname, URL_CHAR_PATTERN for path
    hostPart = hostPart.replace(/\*/g, HOST_CHAR_PATTERN);
    pathPart = pathPart.replace(/\*/g, URL_CHAR_PATTERN);

    p = hostPart + pathPart;

    // Restore preserved patterns from placeholder
    p = p.replace(new RegExp(WILDCARD_PLACEHOLDER, 'g'), URL_CHAR_PATTERN);

    // Anchor the pattern
    // If pattern ends with a wildcard char pattern, don't add end anchor
    if (p.endsWith(URL_CHAR_PATTERN) || p.endsWith(HOST_CHAR_PATTERN)) {
      return `^${p}`;
    }
    // For exact matches, add end anchor
    return `^${p}$`;
  });
}
