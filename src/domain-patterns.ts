/**
 * Domain pattern utilities for wildcard support in --allow-domains
 *
 * Supports asterisk (*) wildcards that are converted to Squid dstdom_regex ACLs.
 * Examples:
 *   *.github.com      -> matches api.github.com, raw.github.com, etc.
 *   api-*.example.com -> matches api-v1.example.com, api-test.example.com, etc.
 *
 * Also supports protocol-specific domain allowlisting:
 *   http://github.com  -> allow only HTTP traffic (port 80)
 *   https://github.com -> allow only HTTPS traffic (port 443)
 *   github.com         -> allow both HTTP and HTTPS (default)
 */

/**
 * Characters that are dangerous in Squid config files when interpolating domain names
 * or URL regex patterns. Squid config is line-and-space delimited, so:
 * - Whitespace (space, tab, CR, LF) can split ACL tokens or inject new directives
 * - Null bytes may terminate strings unexpectedly
 * - `#` starts a Squid config comment, truncating the rest of the line
 * - Quotes (", ', `) and `;` can interfere with config parsing
 *
 * Note: backslash is intentionally excluded here because URL regex patterns passed to
 * `--allow-urls` legitimately use `\` for regex escaping (e.g., `\\.` or `[^\\s]`).
 * Domain names are additionally validated to reject `\` in validateDomainOrPattern().
 */
export const SQUID_DANGEROUS_CHARS = /[\s\0"'`;#]/;

/**
 * Protocol restriction for a domain
 */
export type DomainProtocol = 'http' | 'https' | 'both';

/**
 * Parsed domain with protocol information
 */
export interface ParsedDomain {
  /** The domain name without protocol prefix */
  domain: string;
  /** Which protocol(s) are allowed */
  protocol: DomainProtocol;
}

/**
 * Parse a domain string and extract protocol restriction if present
 *
 * @param input - Domain string, optionally prefixed with http:// or https://
 * @returns ParsedDomain with the domain and protocol restriction
 *
 * Examples:
 *   'github.com'        -> { domain: 'github.com', protocol: 'both' }
 *   'http://github.com' -> { domain: 'github.com', protocol: 'http' }
 *   'https://github.com' -> { domain: 'github.com', protocol: 'https' }
 */
export function parseDomainWithProtocol(input: string): ParsedDomain {
  const trimmed = input.trim();

  if (trimmed.startsWith('http://')) {
    return {
      domain: trimmed.slice(7).replace(/\/$/, ''),
      protocol: 'http',
    };
  }

  if (trimmed.startsWith('https://')) {
    return {
      domain: trimmed.slice(8).replace(/\/$/, ''),
      protocol: 'https',
    };
  }

  // No protocol prefix - allow both
  return {
    domain: trimmed.replace(/\/$/, ''),
    protocol: 'both',
  };
}

/**
 * Check if a domain string contains wildcard characters
 */
export function isWildcardPattern(domain: string): boolean {
  return domain.includes('*');
}

/**
 * Regex pattern for matching valid domain name characters.
 * Uses character class instead of .* to prevent catastrophic backtracking (ReDoS).
 * Per RFC 1035, valid domain characters are: letters, digits, hyphens, and dots.
 */
const DOMAIN_CHAR_PATTERN = '[a-zA-Z0-9.-]*';

/**
 * Convert a wildcard pattern to a Squid-compatible regex pattern
 *
 * @param pattern - Domain pattern with asterisk wildcards
 * @returns Anchored regex string for use with dstdom_regex
 * @throws Error if pattern is invalid
 *
 * Conversion rules:
 * - `*` becomes `[a-zA-Z0-9.-]*` (match valid domain characters, safe from ReDoS)
 * - `.` becomes `\.` (literal dot)
 * - Other regex metacharacters are escaped
 * - Result is anchored with `^` and `$`
 */
export function wildcardToRegex(pattern: string): string {
  // Escape regex metacharacters except for *
  // Order matters: escape backslash first
  let regex = '';

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    switch (char) {
      case '*':
        // Use character class instead of .* to prevent catastrophic backtracking
        regex += DOMAIN_CHAR_PATTERN;
        break;
      case '.':
        regex += '\\.';
        break;
      // Escape other regex metacharacters
      case '^':
      case '$':
      case '+':
      case '?':
      case '{':
      case '}':
      case '[':
      case ']':
      case '|':
      case '(':
      case ')':
      case '\\':
        regex += '\\' + char;
        break;
      default:
        regex += char;
        break;
    }
  }

  // Anchor the regex to match the full domain
  return '^' + regex + '$';
}

/**
 * Validate a domain or wildcard pattern
 *
 * @param input - Domain or pattern to validate (may include protocol prefix)
 * @throws Error if the input is invalid or too broad
 */
export function validateDomainOrPattern(input: string): void {
  // Check for empty input
  if (!input || input.trim() === '') {
    throw new Error('Domain cannot be empty');
  }

  // Strip protocol prefix for validation
  const parsed = parseDomainWithProtocol(input);
  const trimmed = parsed.domain;

  // Check for empty domain after stripping protocol
  if (!trimmed || trimmed === '') {
    throw new Error('Domain cannot be empty');
  }

  // Reject characters that could inject Squid config directives or tokens.
  // Also reject backslash: domain names never legitimately contain backslashes,
  // and they could be used in regex injection if they reach Squid config.
  // This prevents Squid config injection via --allow-domains.
  const DOMAIN_DANGEROUS_CHARS = /[\s\0"'`;#\\]/;
  const match = trimmed.match(DOMAIN_DANGEROUS_CHARS);
  if (match) {
    const safeDomainForMessage = JSON.stringify(trimmed);
    const charCode = match[0].charCodeAt(0);
    const charDesc = charCode <= 0x20 || charCode === 0x7f
      ? `U+${charCode.toString(16).padStart(4, '0')}`
      : `'${match[0]}'`;
    throw new Error(
      `Invalid domain ${safeDomainForMessage}: contains invalid character ${charDesc}. ` +
      `Domain names must not contain whitespace, quotes, semicolons, backticks, hash characters, backslashes, or control characters.`
    );
  }

  // Check for overly broad patterns
  if (trimmed === '*') {
    throw new Error("Pattern '*' matches all domains and is not allowed");
  }

  if (trimmed === '*.*') {
    throw new Error("Pattern '*.*' is too broad and is not allowed");
  }

  // Check for patterns that are essentially "match all"
  // e.g., *.* with only wildcards and dots
  if (/^[*.]+$/.test(trimmed) && trimmed.includes('*')) {
    throw new Error(`Pattern '${trimmed}' is too broad and is not allowed`);
  }

  // Check for double dots
  if (trimmed.includes('..')) {
    throw new Error(`Invalid domain '${trimmed}': contains double dots`);
  }

  // Check for patterns starting or ending with just a dot
  if (trimmed === '.') {
    throw new Error('Invalid domain: cannot be just a dot');
  }

  // Check for invalid leading/trailing patterns
  if (trimmed === '*.' || trimmed === '.*') {
    throw new Error(`Invalid pattern '${trimmed}': incomplete domain`);
  }

  // Check for wildcard-only segments between dots that could match anything
  // e.g., "*.*.com" is too broad (matches any.thing.com)
  // But "*.github.com" is fine (matches anything.github.com)
  const segments = trimmed.split('.');
  const wildcardSegments = segments.filter(s => s === '*').length;
  const totalSegments = segments.length;

  // If more than half the segments are pure wildcards, it's probably too broad
  // Exception: *.domain.tld is fine (1 wildcard, 3 segments)
  if (wildcardSegments > 1 && wildcardSegments >= totalSegments - 1) {
    throw new Error(
      `Pattern '${trimmed}' has too many wildcard segments and is not allowed`
    );
  }
}

export interface DomainPattern {
  original: string;
  regex: string;
  protocol: DomainProtocol;
}

/**
 * A plain domain entry with protocol restriction
 */
export interface PlainDomainEntry {
  domain: string;
  protocol: DomainProtocol;
}

export interface ParsedDomainList {
  /** Plain domains without wildcards */
  plainDomains: PlainDomainEntry[];
  /** Wildcard patterns with regex */
  patterns: DomainPattern[];
}

/**
 * Parse and categorize domains into plain domains and wildcard patterns
 *
 * @param domains - Array of domain strings (may include wildcards and protocol prefixes)
 * @returns Object with plainDomains and patterns arrays
 * @throws Error if any domain/pattern is invalid
 */
export function parseDomainList(domains: string[]): ParsedDomainList {
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
